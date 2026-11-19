// SPDX-License-Identifier: MIT
//! Codex's engine over the Unix socket it serves: the transport behind
//! [`super::connect`] where Unix sockets are available.

use std::os::unix::net::UnixStream;

use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use super::*;

/// How long the engine has to answer a request.
const ENGINE_DEADLINE: Duration = Duration::from_secs(10);
/// The largest message read from the engine.
const MAX_MESSAGE: usize = 4 * 1024 * 1024;

/// [`super::connect`]'s transport: its engine at `endpoint`, on the thread its TUI shows
/// for `session`.
pub(super) fn connect(endpoint: &Path, session: Option<&str>) -> io::Result<Box<dyn Channel>> {
    Ok(Box::new(AppServer::connect(endpoint, session)?))
}

/// Codex's engine, its app-server, spoken to in JSON-RPC over the WebSocket it serves on a
/// Unix socket: one connection, and the thread its session's TUI shows.
pub(super) struct AppServer {
    socket: WebSocket<UnixStream>,
    endpoint: PathBuf,
    /// The thread its TUI shows, and whether it was idle (no turn running) as connected;
    /// `None` when which one it shows is unclear.
    shown: Option<(String, bool)>,
    next_id: u64,
}

/// Why a request got no result.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RequestError {
    /// The engine answered it with an error: it had no effect.
    Refused,
    /// The connection failed, or no answer came, once it may have been sent.
    Lost,
}

impl AppServer {
    /// A connection to the engine at `endpoint`, on the thread its TUI shows for
    /// `session` (see [`Self::shown_thread`]).
    pub(super) fn connect(endpoint: &Path, session: Option<&str>) -> io::Result<Self> {
        let mut server = Self::open(endpoint)?;
        server.shown = server.shown_thread(session)?;
        Ok(server)
    }

    /// A connection to the engine at `endpoint`, initialized, on no thread yet.
    pub(super) fn open(endpoint: &Path) -> io::Result<Self> {
        let stream = UnixStream::connect(endpoint)?;
        stream.set_read_timeout(Some(ENGINE_DEADLINE))?;
        stream.set_write_timeout(Some(ENGINE_DEADLINE))?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (socket, _) =
            tungstenite::client::client_with_config("ws://localhost/", stream, Some(config))
                .map_err(|_| io::Error::other("the engine refused the connection"))?;
        let mut server = Self {
            socket,
            endpoint: endpoint.to_path_buf(),
            shown: None,
            next_id: 0,
        };
        let refused = |_| io::Error::other("the engine refused the session");
        server
            .request(
                "initialize",
                json!({"clientInfo": {"name": "codesense", "version": env!("CARGO_PKG_VERSION")}}),
            )
            .map_err(refused)?;
        server.notify("initialized")?;
        Ok(server)
    }

    /// The thread the session's TUI shows: the one its hooks last named (`session`, a
    /// thread id), or with no session named the only root, and in either case the one
    /// a person was latest in. After `/new` the TUI shows a newer, unnamed thread, while the old one
    /// stays loaded: that reads as unclear, and nothing is started where no one sees it.
    /// The engine's own threads (ephemeral ones, such as its reviewer's) and subagents'
    /// are never a TUI's. With it, whether it is idle; `Ok(None)` when it is unclear, an
    /// error when the engine could not be read.
    fn shown_thread(&mut self, session: Option<&str>) -> io::Result<Option<(String, bool)>> {
        let lost = |_| io::Error::other("the engine's threads could not be read");
        let loaded = self
            .request("thread/loaded/list", json!({}))
            .map_err(lost)?;
        // A list that goes on past this page leaves the latest unknown.
        let (Some(ids), true) = (loaded["data"].as_array(), loaded["nextCursor"].is_null()) else {
            return Ok(None);
        };
        let mut threads = Vec::new();
        for id in ids.iter().filter_map(Value::as_str) {
            let read = self
                .request("thread/read", json!({"threadId": id}))
                .map_err(lost)?;
            let thread = &read["thread"];
            if thread["ephemeral"] == true || !thread["parentThreadId"].is_null() {
                continue;
            }
            let idle = thread.pointer("/status/type") == Some(&json!("idle"));
            threads.push((
                id.to_owned(),
                thread["recencyAt"].as_i64().unwrap_or(0),
                idle,
            ));
        }
        let shown = match session {
            Some(session) => threads.iter().find(|(id, ..)| id == session),
            None => match threads.as_slice() {
                [only] => Some(only),
                _ => None,
            },
        };
        Ok(shown
            .filter(|(shown, at, _)| {
                threads
                    .iter()
                    .all(|(id, other, _)| id == shown || other < at)
            })
            .map(|(id, _, idle)| (id.clone(), *idle)))
    }

    /// The request seam: sends `method` with `params` and returns its result, passing
    /// over the notifications, and the requests, the engine sends meanwhile (its TUI
    /// answers those).
    pub(super) fn request(&mut self, method: &str, params: Value) -> Result<Value, RequestError> {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({"id": id, "method": method, "params": params});
        self.socket
            .send(Message::text(request.to_string()))
            .map_err(|_| RequestError::Lost)?;
        let deadline = Instant::now() + ENGINE_DEADLINE;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || self.socket.get_ref().set_read_timeout(Some(left)).is_err() {
                return Err(RequestError::Lost);
            }
            // A ping is answered by the socket itself; only text carries replies.
            let text = match self.socket.read() {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) | Err(_) => return Err(RequestError::Lost),
                Ok(_) => continue,
            };
            let Ok(reply) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            if reply.get("method").is_some() || reply.get("id").and_then(Value::as_u64) != Some(id)
            {
                continue;
            }
            return reply.get("result").cloned().ok_or(RequestError::Refused);
        }
    }

    fn notify(&mut self, method: &str) -> io::Result<()> {
        self.socket
            .send(Message::text(json!({"method": method}).to_string()))
            .map_err(io::Error::other)
    }

    /// Whether `thread` holds a user message sent under `client_id`, among its latest
    /// items (where one just sent is); `None` when that can't be read.
    fn holds_message(&mut self, thread: &str, client_id: &str) -> Option<bool> {
        let params = json!({"threadId": thread, "limit": 100, "sortDirection": "desc"});
        let page = self.request("thread/items/list", params).ok()?;
        Some(page["data"].as_array()?.iter().any(|entry| {
            entry["item"]["type"] == "userMessage" && entry["item"]["clientId"] == client_id
        }))
    }
}

impl Channel for AppServer {
    fn ready_session(&mut self) -> Option<String> {
        let (thread, true) = self.shown.clone()? else {
            return None;
        };
        let read = self
            .request("thread/read", json!({"threadId": thread}))
            .ok()?;
        let cwd = read["thread"]["cwd"].as_str()?;
        if !Path::new(cwd).is_absolute() {
            return None;
        }
        let list = self.request("hooks/list", json!({"cwds": [cwd]})).ok()?;
        let entries = list["data"].as_array()?;
        let [entry] = entries.as_slice() else {
            return None;
        };
        if entry["cwd"] != cwd || !entry["errors"].as_array()?.is_empty() {
            return None;
        }
        let hooks = entry["hooks"].as_array()?;
        // A custom untrusted hook can still put a review menu in front of the TUI.
        // Managed hooks are trusted by policy; unknown flags/statuses fail closed.
        if hooks.iter().any(|hook| match hook["enabled"].as_bool() {
            Some(false) => false,
            Some(true) => !matches!(hook["trustStatus"].as_str(), Some("trusted" | "managed")),
            None => true,
        }) {
            return None;
        }
        let command = observer_command();
        for event in OBSERVER_EVENTS {
            let mut name = event.to_string();
            name[..1].make_ascii_lowercase();
            if !hooks.iter().any(|hook| {
                hook["eventName"] == name
                    && hook["command"] == command
                    && hook["handlerType"] == "command"
                    && hook["enabled"] == true
                    && hook["source"] == "sessionFlags"
                    && hook["matcher"].is_null()
                    && hook["async"].as_bool() != Some(true)
            }) {
                return None;
            }
        }
        Some(thread)
    }

    /// Only the thread its TUI shows is started a turn, and only while idle: one started
    /// while a turn runs would join it. A person pressing Enter at that moment shares the
    /// new turn; neither prompt is lost.
    fn start_turn(&mut self, text: &str, client_id: &str) -> SubmitOutcome {
        let Some((thread, true)) = self.shown.clone() else {
            return SubmitOutcome::RefusedNoEffect;
        };
        let params = json!({
            "threadId": thread,
            "clientUserMessageId": client_id,
            "input": [{"type": "text", "text": text}],
        });
        match self.request("turn/start", params) {
            Ok(started) if started.pointer("/turn/id").is_some() => SubmitOutcome::Accepted,
            Err(RequestError::Refused) => SubmitOutcome::RefusedNoEffect,
            // Its answer was lost or unreadable: whether the turn started is read back, by
            // its client id, on a connection of its own.
            _ => {
                let held = Self::open(&self.endpoint)
                    .ok()
                    .and_then(|mut fresh| fresh.holds_message(&thread, client_id));
                match held {
                    Some(true) => SubmitOutcome::Accepted,
                    _ => SubmitOutcome::Uncertain,
                }
            }
        }
    }
}
