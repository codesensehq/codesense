// SPDX-License-Identifier: MIT
//! Killing a pty session ends its whole process tree: the child the runner
//! started and the grandchild it started in turn.
//!
//! The child starts its grandchild only when told `go`, which the test sends
//! once the runner has put the child in the session's process group (a Job
//! Object on Windows). On Windows the grandchild is detached from the console,
//! so closing the pseudo console does not end it: only the job does.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use codesense_platform::process::{is_alive, Pid};
use codesense_pty_core::domain::{PtySessionId, TerminalDomain};
use codesense_pty_core::layout::ServerIdentity;
use codesense_pty_core::runner::{LocalPtyRunner, PtyRunner, PtySpec};
use codesense_pty_core::TerminalHost;
use portable_pty::{CommandBuilder, PtySize};
use support::{registration, runtime, NoopSink};

/// Poll `done` every 20 ms until it holds or `limit` passes.
fn eventually(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if done() {
            return true;
        }
        if start.elapsed() > limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn killing_a_session_ends_the_child_and_its_grandchild() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_pty-fixture"));
    command.arg("tree");
    command.arg(&pid_file);
    command.cwd(dir.path());
    let pty = runtime()
        .block_on(LocalPtyRunner.spawn(PtySpec {
            command,
            size: PtySize::default(),
        }))
        .expect("local spawn succeeds");
    let child = pty.pid();
    let host = TerminalHost::new(
        ServerIdentity::ephemeral("process-tree"),
        Arc::new(NoopSink),
        runtime().handle().clone(),
    );
    let session = PtySessionId::new("tree");
    host.register(pty, registration(session.as_str(), false))
        .expect("register the session");
    support::answer_cursor_request(&host, &session);
    // The runner adopted the child into its process group as it spawned it.
    host.write(&session, b"go\r").expect("send go");

    let mut pids = Vec::new();
    assert!(
        eventually(Duration::from_secs(10), || {
            pids = std::fs::read_to_string(&pid_file)
                .unwrap_or_default()
                .split_whitespace()
                .filter_map(|pid| pid.parse().ok())
                .map(Pid::from_raw)
                .collect();
            pids.len() == 2
        }),
        "the fixture never wrote its pids (the pty had written {:?} bytes)",
        host.output_seq(&session)
    );
    assert_eq!(Some(pids[0].as_raw()), child);
    assert!(pids.iter().all(|pid| is_alive(*pid)));

    host.kill(&session).expect("kill the session");
    assert!(
        eventually(Duration::from_secs(5), || pids
            .iter()
            .all(|pid| !is_alive(*pid))),
        "a process in the session's tree outlived it"
    );
}
