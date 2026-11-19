// SPDX-License-Identifier: MIT
//! Shared by the integration tests that run sessions on a host: where
//! `scripts/build-emulator.sh` put the emulator worker for this machine, the
//! runtime a host runs on, event sinks and a session's registration.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use codesense_pty_core::domain::{PortUnavailable, TerminalDomainEvent, TerminalEventSink};
use codesense_pty_core::emulator::WORKER_BIN;
use codesense_pty_core::{SessionMeta, SessionRegistration};

/// The runtime every host in the test binary runs on.
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().unwrap())
}

/// Drops every event.
pub struct NoopSink;

impl TerminalEventSink for NoopSink {
    fn emit(&self, _: TerminalDomainEvent) -> Result<(), PortUnavailable> {
        Ok(())
    }
}

/// Keeps every event.
#[derive(Default)]
pub struct RecordingSink(pub Mutex<Vec<TerminalDomainEvent>>);

impl TerminalEventSink for RecordingSink {
    fn emit(&self, event: TerminalDomainEvent) -> Result<(), PortUnavailable> {
        self.0.lock().unwrap().push(event);
        Ok(())
    }
}

/// An ordinary session `session_id`, with xterm's default scrollback, and the
/// OSC side-tap on when `osc_enabled`.
pub fn registration(session_id: &str, osc_enabled: bool) -> SessionRegistration {
    SessionRegistration {
        session_id: session_id.to_string(),
        meta: SessionMeta::default(),
        home_cwd: None,
        osc_enabled,
        is_pool_member: false,
        scrollback: 1000,
    }
}

/// The Rust triple of the machine running the tests, as the build scripts name
/// artifacts.
pub fn host_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        other => panic!("no emulator worker is built for {other:?}"),
    }
}

/// The worker `CODESENSE_EMULATOR_WORKER` names, else the build artifact for
/// this machine: `src-tauri/binaries/codesense-emulator-<triple>`, plus the
/// platform's executable suffix (`.exe` on Windows).
pub fn worker_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CODESENSE_EMULATOR_WORKER") {
        return PathBuf::from(path);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../binaries")
        .join(format!(
            "{WORKER_BIN}-{}{}",
            host_triple(),
            std::env::consts::EXE_SUFFIX
        ))
}

/// Whether the tests run under CI: `CI=1` (or `true`).
pub fn in_ci() -> bool {
    std::env::var_os("CI").is_some_and(|v| v == "1" || v == "true")
}

/// Whether a missing worker fails the tests rather than skipping them: under
/// CI, or with `CODESENSE_REQUIRE_EMULATOR=1`.
pub fn worker_required() -> bool {
    in_ci() || std::env::var_os("CODESENSE_REQUIRE_EMULATOR").is_some_and(|v| v == "1")
}

/// The worker, or `None` (with a note) when this machine has none and nothing
/// requires one.
pub fn worker() -> Option<PathBuf> {
    find_worker(worker_required())
}

/// The worker, failing the test when there is none.
pub fn required_worker() -> PathBuf {
    find_worker(true).expect("a required worker")
}

/// The worker; when there is none, a failure if `required`, else `None` with
/// a note.
fn find_worker(required: bool) -> Option<PathBuf> {
    let path = worker_path();
    if path.is_file() {
        return Some(path);
    }
    let missing = format!(
        "no emulator worker at {} (build it with `pnpm run build:emulator`)",
        path.display()
    );
    assert!(!required, "{missing}");
    eprintln!("skipping: {missing}");
    None
}
