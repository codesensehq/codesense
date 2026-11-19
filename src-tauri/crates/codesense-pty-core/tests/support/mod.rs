// SPDX-License-Identifier: MIT
//! Shared by the integration tests that run the real emulator worker: where
//! `scripts/build-emulator.sh` put it for this machine.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use codesense_pty_core::emulator::WORKER_BIN;

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
    let path = worker_path();
    if path.is_file() {
        return Some(path);
    }
    assert!(
        !worker_required(),
        "no emulator worker at {} — build it with `pnpm run build:emulator`",
        path.display()
    );
    eprintln!(
        "skipping: no emulator worker at {} (build it with `pnpm run build:emulator`)",
        path.display()
    );
    None
}

/// The worker, failing the test when there is none.
pub fn required_worker() -> PathBuf {
    let path = worker_path();
    assert!(
        path.is_file(),
        "no emulator worker at {} — build it with `pnpm run build:emulator`",
        path.display()
    );
    path
}
