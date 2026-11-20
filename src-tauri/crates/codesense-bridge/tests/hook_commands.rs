// SPDX-License-Identifier: MIT
//! The hook commands CodeSense writes (`codesense_host_proto::hook::command`), run as Claude
//! runs them: through each shell Claude may pick for the target, with the built bridge in the
//! tab's host root and the hook's JSON on stdin. Every Claude hook payload reaches the app's
//! route byte for byte, and the guard's deny reaches Claude.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use codesense_host_proto::hook::{self, HookTarget, Verb};

mod support;

/// A shell Claude may run a hook command in, and the target whose commands it runs.
struct Shell {
    /// How a failure names it.
    name: &'static str,
    target: HookTarget,
    /// The program, then the flags before the command.
    argv: &'static [&'static str],
}

/// Every shell a written command must work under. The rows of this host's own target run.
const SHELLS: &[Shell] = &[Shell {
    name: "bash",
    target: HookTarget::Posix,
    argv: &["bash", "-c"],
}];

fn shells() -> impl Iterator<Item = &'static Shell> {
    SHELLS
        .iter()
        .filter(|shell| shell.target == HookTarget::local())
}

/// A fresh temporary directory, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "codesense-hook-commands-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A host root holding the built bridge under the name `target`'s commands run.
fn root_with_bridge(target: HookTarget) -> TempDir {
    let root = TempDir::new();
    std::fs::copy(
        env!("CARGO_BIN_EXE_codesense-bridge"),
        root.0.join(target.bridge_file()),
    )
    .unwrap();
    root
}

/// Run `verb`'s written command under `shell`, in a tab whose host root is `root`, with
/// `stdin` and a home of its own.
fn run(shell: &Shell, verb: Verb, root: &Path, stdin: &[u8], env: &[(&str, &str)]) -> Output {
    let home = TempDir::new();
    let (program, flags) = shell.argv.split_first().unwrap();
    let mut child = Command::new(program)
        .args(flags)
        .arg(hook::command(verb, shell.target).command)
        .env(hook::HOST_ENV, root)
        .env("HOME", &home.0)
        .env("USERPROFILE", &home.0)
        .env_remove("CODESENSE_API_PORT")
        .env_remove("CODESENSE_STATUS_URL")
        .env_remove("CODESENSE_TAB_SESSION_ID")
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("{}: {error}", shell.name));
    // A command that reads no stdin may have exited already.
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

/// Every top-level Claude hook payload the status route's tests read, by file name, and one
/// with non-ASCII text.
fn payloads() -> Vec<(String, Vec<u8>)> {
    let dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/http/routes/fixtures/claude-hooks");
    let mut payloads: Vec<(String, Vec<u8>)> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (name, std::fs::read(&path).unwrap())
        })
        .collect();
    assert!(payloads.len() >= 8, "fixtures in {}", dir.display());
    payloads.sort();
    payloads.push((
        "non-ASCII".into(),
        "{\"hook_event_name\":\"Stop\",\"session_id\":\"s\",\"last_assistant_message\":\"é ą 🦀\"}"
            .as_bytes()
            .to_vec(),
    ));
    payloads
}

#[test]
fn every_hook_payload_reaches_the_route_byte_for_byte() {
    for shell in shells() {
        let root = root_with_bridge(shell.target);
        let (port, rx) = support::listener();
        for (name, payload) in payloads() {
            let out = run(
                shell,
                Verb::Notify,
                &root.0,
                &payload,
                &[
                    ("CODESENSE_API_PORT", port.as_str()),
                    ("CODESENSE_TAB_SESSION_ID", "tab-1"),
                ],
            );
            assert!(out.status.success(), "{}: {name}: {out:?}", shell.name);
            let request = rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_else(|_| panic!("{}: {name}: no post", shell.name));
            let (head, body) = support::split(&request).unwrap();
            assert!(
                head.starts_with(b"POST /api/v1/terminal/status HTTP/1."),
                "{}: {name}",
                shell.name
            );
            assert!(
                body == payload.as_slice(),
                "{}: {name}: the body differs from the payload",
                shell.name
            );
        }
    }
}

#[test]
fn the_guard_command_prints_the_deny() {
    let deny = hook::Deny {
        reason: hook::GUARD_REASON,
    }
    .to_json();
    let rows: [(&str, &[u8], &str); 3] = [
        (
            "a credential read",
            br#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/repo/.env"}}"#,
            &deny,
        ),
        (
            "a raw no-break space",
            b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat\xc2\xa0.env\"}}",
            &deny,
        ),
        (
            "ordinary work",
            br#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/repo/src/main.rs"}}"#,
            "",
        ),
    ];
    for shell in shells() {
        let root = root_with_bridge(shell.target);
        for (name, payload, printed) in rows {
            let out = run(shell, Verb::SecretGuard, &root.0, payload, &[]);
            assert!(out.status.success(), "{}: {name}: {out:?}", shell.name);
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                printed,
                "{}: {name}",
                shell.name
            );
        }
    }
}

/// A tab whose host placed no bridge runs hooks that do nothing and succeed: a missing bridge
/// allows, as a missing hook does.
#[test]
fn a_root_without_the_bridge_runs_nothing_and_succeeds() {
    for shell in shells() {
        let root = TempDir::new();
        for verb in Verb::ALL {
            let out = run(shell, verb, &root.0, b"{}", &[]);
            assert!(out.status.success(), "{}: {verb:?}: {out:?}", shell.name);
            assert!(out.stdout.is_empty(), "{}: {verb:?}", shell.name);
            assert!(out.stderr.is_empty(), "{}: {verb:?}", shell.name);
        }
    }
}
