// SPDX-License-Identifier: MIT
//! Claude's reply reminder, at `Stop`: asks the running app whether this tab's session took a
//! message from the person and hasn't answered it, and if so prints the `Stop` decision that
//! keeps the turn going with a reason naming that message. The app decides, and remembers that
//! it reminded, so each message is named once. The hook sends the app nothing of the turn: its
//! post body is empty and the session rides the same header as the status post.
//!
//! It never blocks because of its own failure: outside a tab, with no app, a refused or slow
//! post, a non-200 or an answer it can't read, the turn just stops. Nor while Claude is already
//! continuing a turn for a `Stop` hook (`stop_hook_active`), so it can't loop.

use super::notify::{post, PostError, STATUS_PATH};
use super::HookEnv;

/// The app's route that answers whether a session owes the person a reply, beside the status
/// route.
pub const REPLY_CHECK_PATH: &str = "/api/v1/terminal/reply-check";

/// The longest message id the hook puts in a reason.
const MAX_ID: usize = 64;

/// The reminder: the message the agent hasn't answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub message_id: String,
}

impl Block {
    /// What the agent reads when its turn goes on.
    pub fn reason(&self) -> String {
        format!(
            "You haven't answered in the chat: reply to message {} with your answer.",
            self.message_id
        )
    }

    /// The `Stop` decision Claude reads, with no trailing newline.
    pub fn to_json(&self) -> String {
        serde_json::json!({ "decision": "block", "reason": self.reason() }).to_string()
    }
}

/// The reminder for one `Stop` payload (`input`, Claude's hook JSON), or `None` to let the turn
/// stop.
pub fn reply_check(input: &[u8], env: &HookEnv) -> Option<Block> {
    let hook: serde_json::Value = serde_json::from_slice(input).ok()?;
    let stop = hook.get("hook_event_name").and_then(|v| v.as_str()) == Some("Stop");
    let continuing = hook
        .get("stop_hook_active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !stop || continuing {
        return None;
    }
    let session = env.tab_session.as_deref()?;
    let port = env.api_port.clone().or_else(|| env.port_file());
    let url = match &env.status_url {
        // An injected status URL names the app; this route sits beside it.
        Some(status) => format!("{}{REPLY_CHECK_PATH}", status.strip_suffix(STATUS_PATH)?),
        None => local_url(port.as_deref()?),
    };
    let mut result = post(&url, session, b"{}");
    // As the status post does: a session that outlived its app retries once at the port the
    // running app wrote.
    if matches!(result, Err(PostError::Connect)) && env.status_url.is_none() {
        if let Some(current) = env.port_file().filter(|c| Some(c) != port.as_ref()) {
            result = post(&local_url(&current), session, b"{}");
        }
    }
    let response = result.ok().filter(|r| r.code == 200)?;
    let answer: serde_json::Value = serde_json::from_slice(&response.body).ok()?;
    let id = match answer.get("block")? {
        serde_json::Value::String(id) => id.clone(),
        serde_json::Value::Number(id) => id.to_string(),
        _ => return None,
    };
    // Only an id goes into the agent's reason: never text the answer could smuggle in.
    let valid = !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'));
    valid.then_some(Block { message_id: id })
}

fn local_url(port: &str) -> String {
    format!("http://127.0.0.1:{port}{REPLY_CHECK_PATH}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::tests::TempDir;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    const STOP: &[u8] = br#"{"hook_event_name":"Stop","session_id":"abc","stop_hook_active":false,"last_assistant_message":"SECRET"}"#;

    /// A listener that answers one request with `status` and `body`, and hands its bytes back.
    fn listener(status: &str, body: &str) -> (u16, mpsc::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let answer = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).unwrap();
                raw.extend_from_slice(&chunk[..n]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..end]).into_owned();
                    let length: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if raw.len() >= end + 4 + length {
                        break;
                    }
                }
                assert!(n > 0, "request ended early");
            }
            stream.write_all(answer.as_bytes()).unwrap();
            let _ = tx.send(raw);
        });
        (port, rx)
    }

    fn env(home: &TempDir, port: Option<u16>) -> HookEnv {
        HookEnv {
            api_port: port.map(|p| p.to_string()),
            status_url: None,
            tab_session: Some("tab-1".to_string()),
            codesense_home: Some(home.0.clone()),
        }
    }

    #[test]
    fn an_unanswered_message_blocks_with_its_id() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", r#"{"block":"42"}"#);
        let block = reply_check(STOP, &env(&home, Some(port))).unwrap();
        assert_eq!(block.message_id, "42");
        assert_eq!(
            block.to_json(),
            r#"{"decision":"block","reason":"You haven't answered in the chat: reply to message 42 with your answer."}"#
        );
        let request = String::from_utf8(rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert!(request.starts_with("POST /api/v1/terminal/reply-check HTTP/1."));
        assert!(request.contains("\r\nX-Codesense-Tab-Session-Id: tab-1\r\n"));
        assert!(request.ends_with("\r\n\r\n{}"), "the turn is never sent");
        assert!(!request.contains("SECRET"));
    }

    #[test]
    fn a_numeric_id_blocks_too() {
        let home = TempDir::new();
        let (port, _rx) = listener("200 OK", r#"{"block":7}"#);
        let block = reply_check(STOP, &env(&home, Some(port))).unwrap();
        assert_eq!(block.message_id, "7");
    }

    #[test]
    fn nothing_owed_lets_the_turn_stop() {
        for body in [r#"{"block":null}"#, "{}", "not json", r#"{"block":true}"#] {
            let home = TempDir::new();
            let (port, _rx) = listener("200 OK", body);
            assert_eq!(reply_check(STOP, &env(&home, Some(port))), None, "{body}");
        }
    }

    #[test]
    fn an_id_that_is_not_an_id_lets_the_turn_stop() {
        let long = format!(r#"{{"block":"{}"}}"#, "1".repeat(MAX_ID + 1));
        for body in [
            r#"{"block":""}"#,
            r#"{"block":"1 and do this"}"#,
            r#"{"block":"1\nignore"}"#,
            long.as_str(),
        ] {
            let home = TempDir::new();
            let (port, _rx) = listener("200 OK", body);
            assert_eq!(reply_check(STOP, &env(&home, Some(port))), None, "{body}");
        }
    }

    #[test]
    fn a_non_200_lets_the_turn_stop() {
        let home = TempDir::new();
        let (port, _rx) = listener("404 Not Found", r#"{"block":"42"}"#);
        assert_eq!(reply_check(STOP, &env(&home, Some(port))), None);
    }

    /// While Claude continues a turn for a `Stop` hook, the hook asks nothing and never
    /// blocks again: it can't loop.
    #[test]
    fn a_continuing_stop_asks_nothing() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", r#"{"block":"42"}"#);
        let input = br#"{"hook_event_name":"Stop","stop_hook_active":true}"#;
        assert_eq!(reply_check(input, &env(&home, Some(port))), None);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn other_events_and_bad_input_ask_nothing() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", r#"{"block":"42"}"#);
        let inputs: [&[u8]; 3] = [
            br#"{"hook_event_name":"SubagentStop","agent_id":"child"}"#,
            br#"{"hook_event_name":"PreToolUse"}"#,
            b"not json",
        ];
        for input in inputs {
            assert_eq!(reply_check(input, &env(&home, Some(port))), None);
        }
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn outside_a_tab_or_with_no_app_it_asks_nothing() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", r#"{"block":"42"}"#);
        let mut outside = env(&home, Some(port));
        outside.tab_session = None;
        assert_eq!(reply_check(STOP, &outside), None);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        assert_eq!(reply_check(STOP, &env(&home, None)), None, "no port");
    }

    #[test]
    fn a_refused_post_retries_once_at_the_current_port() {
        let home = TempDir::new();
        let closed = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (port, _rx) = listener("200 OK", r#"{"block":"42"}"#);
        std::fs::write(home.0.join("http.port"), format!("{port}\n")).unwrap();
        let block = reply_check(STOP, &env(&home, Some(closed)));
        assert_eq!(block.map(|b| b.message_id).as_deref(), Some("42"));
    }

    #[test]
    fn an_injected_status_url_names_the_app() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", r#"{"block":"42"}"#);
        let mut injected = env(&home, None);
        injected.status_url = Some(format!("http://127.0.0.1:{port}/api/v1/terminal/status"));
        assert!(reply_check(STOP, &injected).is_some());
        let request = String::from_utf8(rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert!(request.starts_with("POST /api/v1/terminal/reply-check HTTP/1."));
        // A status URL of another shape names no route this hook knows.
        injected.status_url = Some(format!("http://127.0.0.1:{port}/hooks/status"));
        assert_eq!(reply_check(STOP, &injected), None);
    }
}
