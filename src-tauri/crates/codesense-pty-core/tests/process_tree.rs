// SPDX-License-Identifier: MIT
//! Killing a pty session ends its whole process tree: the child the runner
//! started and the grandchild it started in turn.

use std::time::{Duration, Instant};

use codesense_platform::process::{is_alive, Pid};
use codesense_pty_core::runner::{LocalPtyRunner, PtyRunner, PtySpec};
use portable_pty::{CommandBuilder, PtySize};

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

#[tokio::test]
async fn killing_a_session_ends_the_child_and_its_grandchild() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_pty-tree-fixture"));
    command.arg(&pid_file);
    command.cwd(dir.path());
    let session = LocalPtyRunner
        .spawn(PtySpec {
            command,
            size: PtySize::default(),
        })
        .await
        .expect("local spawn succeeds");

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
        "the fixture never wrote its pids"
    );
    assert_eq!(Some(pids[0].as_raw()), session.pid());
    assert!(pids.iter().all(|pid| is_alive(*pid)));

    // Kill the session and reap its child.
    session.discard();
    assert!(
        eventually(Duration::from_secs(5), || pids
            .iter()
            .all(|pid| !is_alive(*pid))),
        "a process in the session's tree outlived it"
    );
}
