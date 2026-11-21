// SPDX-License-Identifier: MIT
//! `codesense-bridge hook …` as Claude runs it: the built binary, the hook's JSON on stdin.

use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

mod support;

use support::{listener, listener_answering, TempDir};

/// Run `codesense-bridge hook <args>` with `stdin` and a home of its own.
fn hook(args: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> Output {
    let home = TempDir::new();
    let mut command = Command::new(env!("CARGO_BIN_EXE_codesense-bridge"));
    command
        .arg("hook")
        .args(args)
        .env("HOME", &home.0)
        .env_remove("CODESENSE_API_PORT")
        .env_remove("CODESENSE_STATUS_URL")
        .env_remove("CODESENSE_TAB_SESSION_ID")
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    // A verb that reads no stdin may have exited already.
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn the_secret_guard_denies_a_credential_read() {
    let out = hook(
        &["secret-guard"],
        br#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/repo/.env"}}"#,
        &[],
    );
    assert!(out.status.success());
    let deny: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(deny["hookSpecificOutput"]["permissionDecision"], "deny");
    assert_eq!(deny["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        codesense_host_proto::hook::Deny {
            reason: codesense_host_proto::hook::GUARD_REASON
        }
        .to_json()
    );
}

#[test]
fn the_secret_guard_allows_ordinary_work_silently() {
    let inputs: [&[u8]; 2] = [
        br#"{"tool_name":"Read","tool_input":{"file_path":"/repo/src/main.rs"}}"#,
        b"not json",
    ];
    for input in inputs {
        let out = hook(&["secret-guard"], input, &[]);
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn notify_posts_the_event_once() {
    let (port, rx) = listener();
    let event = r#"{"hook_event_name":"Stop","session_id":"abc"}"#;
    let out = hook(
        &["notify"],
        event.as_bytes(),
        &[
            ("CODESENSE_API_PORT", port.as_str()),
            ("CODESENSE_TAB_SESSION_ID", "tab-1"),
        ],
    );
    assert!(out.status.success());
    let request = String::from_utf8(rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
    assert!(request.starts_with("POST /api/v1/terminal/status HTTP/1."));
    assert!(request.contains("\r\nX-Codesense-Tab-Session-Id: tab-1\r\n"));
    assert!(request.ends_with(event));
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "one post"
    );
}

#[test]
fn reply_check_prints_the_apps_block_once() {
    let (port, rx) = listener_answering(r#"{"block":"42"}"#);
    let env = [
        ("CODESENSE_API_PORT", port.as_str()),
        ("CODESENSE_TAB_SESSION_ID", "tab-1"),
    ];
    let out = hook(
        &["reply-check"],
        br#"{"hook_event_name":"Stop","stop_hook_active":false}"#,
        &env,
    );
    assert!(out.status.success());
    let decision: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(decision["decision"], "block");
    assert_eq!(
        decision["reason"],
        "You haven't answered in the chat: reply to message 42 with your answer."
    );
    let request = String::from_utf8(rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
    assert!(request.starts_with("POST /api/v1/terminal/reply-check HTTP/1."));
    assert!(request.contains("\r\nX-Codesense-Tab-Session-Id: tab-1\r\n"));

    // A stop Claude is already continuing asks nothing and prints nothing.
    let out = hook(
        &["reply-check"],
        br#"{"hook_event_name":"Stop","stop_hook_active":true}"#,
        &env,
    );
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn reply_check_lets_the_turn_stop_when_nothing_is_owed_or_the_app_is_gone() {
    let (port, _rx) = listener_answering(r#"{"block":null}"#);
    let event = br#"{"hook_event_name":"Stop"}"#;
    let out = hook(
        &["reply-check"],
        event,
        &[
            ("CODESENSE_API_PORT", port.as_str()),
            ("CODESENSE_TAB_SESSION_ID", "tab-1"),
        ],
    );
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    let out = hook(
        &["reply-check"],
        event,
        &[("CODESENSE_TAB_SESSION_ID", "tab-1")],
    );
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn an_unknown_hook_prints_usage_and_succeeds() {
    let verbs: [&[&str]; 2] = [&["bogus"], &[]];
    for args in verbs {
        let out = hook(args, b"{}", &[]);
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage: codesense-bridge hook"));
    }
}
