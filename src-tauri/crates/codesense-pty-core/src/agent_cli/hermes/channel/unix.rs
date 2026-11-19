// SPDX-License-Identifier: MIT
//! The gateway's private control socket and its engine relay's WebSocket, over Unix
//! sockets: the transport behind [`super::control`] and [`super::connect`].
use super::*;
use std::{
    io::{BufRead, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream,
    },
    time::{Duration, Instant},
};
use tungstenite::{handshake::client::Request, protocol::WebSocketConfig, Message, WebSocket};

const BUDGET: Duration = Duration::from_secs(10);
const MAX_MESSAGE: usize = 4 * 1024 * 1024;

/// Unix sockets are available here.
pub(super) fn available() -> io::Result<()> {
    Ok(())
}

/// One control `request` line to the socket at `path`, and its reply line, once the
/// private directory holding the socket passed. `home` is the verified home, opened.
pub(super) fn call(path: &Path, home: &fs::File, request: &[u8]) -> io::Result<String> {
    // The socket itself, once the private directory holding it passed: by lstat, as
    // open(2) on a socket fails (ENXIO), so it cannot go through `private_node`. Its
    // owner is the verified home's, which `private_node` proved is this user.
    let meta = fs::symlink_metadata(&path)?;
    if meta.uid() != home.metadata()?.uid() || meta.mode() & 0o077 != 0 {
        return Err(unavailable());
    }
    if !meta.file_type().is_socket() {
        return Err(unavailable());
    }
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(BUDGET))?;
    stream.set_write_timeout(Some(BUDGET))?;
    stream.write_all(request)?;
    let mut line = String::new();
    io::BufReader::new(stream)
        .take(65537)
        .read_line(&mut line)?;
    Ok(line)
}

/// The engine relay at `endpoint`, authorized by `request`, on the session `session`
/// names (or the only one); ready only when `hooks_ready`.
pub(super) fn connect(
    endpoint: &Path,
    request: Request,
    session: Option<&str>,
    hooks_ready: impl FnOnce() -> bool,
) -> io::Result<Box<dyn Channel>> {
    let stream = UnixStream::connect(endpoint)?;
    stream.set_read_timeout(Some(BUDGET))?;
    stream.set_write_timeout(Some(BUDGET))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    // Never include handshake errors/headers in diagnostics: they contain the ticket.
    let (socket, response) = tungstenite::client::client_with_config(request, stream, Some(config))
        .map_err(|_| unavailable())?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|h| h.to_str().ok())
        != Some(PROTOCOL)
    {
        return Err(unavailable());
    }
    let mut gateway = Gateway {
        socket,
        shown: None,
        next_id: 0,
        receipt: None,
        ready: false,
    };
    let list = gateway
        .request("session.list", json!({}))
        .map_err(|_| unavailable())?;
    let sessions = list["sessions"].as_array().ok_or_else(unavailable)?;
    let selected = match session {
        Some(id) => sessions.iter().find(|row| row["session_id"] == id),
        None if sessions.len() == 1 => sessions.first(),
        _ => None,
    };
    if let Some(id) = selected.and_then(|row| row["session_id"].as_str()) {
        let snapshot = gateway
            .request("session.resume", json!({"session_id":id}))
            .map_err(|_| unavailable())?;
        if snapshot["session_id"] == id {
            gateway.ready = hooks_ready()
                && snapshot
                    .pointer("/info/mcp_servers")
                    .and_then(Value::as_array)
                    .is_some_and(|servers| {
                        servers.iter().any(|server| {
                            server["name"] == "codesense"
                                && server["connected"] == true
                                && server["tools"].as_u64().is_some_and(|count| count > 0)
                        })
                    });
            gateway.shown = Some((id.into(), snapshot["running"] == false));
        }
    }
    Ok(Box::new(gateway))
}

struct Gateway {
    socket: WebSocket<UnixStream>,
    shown: Option<(String, bool)>,
    next_id: u64,
    receipt: Option<String>,
    ready: bool,
}

enum RequestError {
    Refused,
    Lost,
}
impl Gateway {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, RequestError> {
        self.next_id += 1;
        let id = self.next_id;
        self.socket
            .send(Message::text(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
            ))
            .map_err(|_| RequestError::Lost)?;
        let until = Instant::now() + BUDGET;
        loop {
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero()
                || self
                    .socket
                    .get_ref()
                    .set_read_timeout(Some(remaining))
                    .is_err()
            {
                return Err(RequestError::Lost);
            }
            match self.socket.read().map_err(|_| RequestError::Lost)? {
                Message::Text(text) => {
                    let frame: Value =
                        serde_json::from_str(&text).map_err(|_| RequestError::Lost)?;
                    if frame["id"] != id {
                        continue;
                    }
                    if frame.get("error").is_some() {
                        return Err(RequestError::Refused);
                    }
                    return frame.get("result").cloned().ok_or(RequestError::Lost);
                }
                Message::Ping(_) => self.socket.flush().map_err(|_| RequestError::Lost)?,
                Message::Close(_) => return Err(RequestError::Lost),
                _ => {}
            }
        }
    }
}
impl Channel for Gateway {
    fn ready_session(&mut self) -> Option<String> {
        self.shown
            .as_ref()
            .filter(|(_, idle)| *idle && self.ready)
            .map(|(id, _)| id.clone())
    }
    fn start_turn(&mut self, text: &str, client_id: &str) -> SubmitOutcome {
        self.receipt = None;
        let Some(id) = self.ready_session() else {
            return SubmitOutcome::RefusedNoEffect;
        };
        match self.request(
            "prompt.submit",
            json!({"session_id":id,"input_id":client_id,"text":text}),
        ) {
            Ok(receipt) => {
                self.receipt = receipt["admission_id"]
                    .as_str()
                    .filter(|id| crate::activity::opaque(id))
                    .map(str::to_owned);
                // Even "queued"/"started" is not consumption evidence. Only the
                // admitted main pre_llm_call's platform_message_id can settle it.
                SubmitOutcome::Uncertain
            }
            Err(RequestError::Refused) => SubmitOutcome::RefusedNoEffect,
            Err(RequestError::Lost) => SubmitOutcome::Uncertain,
        }
    }
    fn receipt_id(&self) -> Option<&str> {
        self.receipt.as_deref()
    }
}
