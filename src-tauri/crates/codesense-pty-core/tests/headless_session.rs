// SPDX-License-Identifier: MIT
//! A session nobody watches still runs and reports its exit: no viewer and no
//! emulator worker answer the terminal for it. On Windows that means the
//! pseudo console's startup cursor query is answered by the runner, or the
//! child's first write would wait for an answer forever.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use codesense_pty_core::domain::{PtySessionId, TerminalDomainEvent};
use codesense_pty_core::layout::ServerIdentity;
use codesense_pty_core::runner::{LocalPtyRunner, PtyRunner, PtySpec};
use codesense_pty_core::TerminalHost;
use portable_pty::{CommandBuilder, PtySize};
use support::{registration, runtime, RecordingSink};

#[test]
fn a_session_with_no_viewer_runs_and_reports_its_exit() {
    let dir = tempfile::tempdir().unwrap();
    let mark = dir.path().join("mark");
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_pty-fixture"));
    command.arg("mark");
    command.arg(&mark);
    command.cwd(dir.path());
    let pty = runtime()
        .block_on(LocalPtyRunner.spawn(PtySpec {
            command,
            size: PtySize::default(),
        }))
        .expect("local spawn succeeds");
    let events = Arc::new(RecordingSink::default());
    let host = TerminalHost::new(
        ServerIdentity::ephemeral("headless-session"),
        events.clone(),
        runtime().handle().clone(),
    );
    let session = PtySessionId::new("headless");
    host.register(pty, registration(session.as_str(), false))
        .expect("register the session");

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        let exit = events.0.lock().unwrap().iter().find_map(|event| match event {
            TerminalDomainEvent::Exit {
                session: exited,
                status,
                ..
            } if *exited == session => Some(status.clone()),
            _ => None,
        });
        if let Some(status) = exit {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "the session never reported its exit (the pty had written {:?} bytes)",
            host.output_seq(&session)
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.and_then(|status| status.exit_code), Some(0));
    assert_eq!(std::fs::read_to_string(&mark).unwrap(), "marked");
}
