// SPDX-License-Identifier: MIT
//! The process the platform contract tests drive, so they never need a shell.
//!
//! - `tree`: start a `sleep` child (the test's grandchild), print its pid,
//!   then sleep.
//! - `ignore-terminate`: ignore the polite stop, print `ready`, then sleep.
//! - `try-lock <path>`: print `locked` or `busy` for an exclusive lock on
//!   `path`, then exit.
//! - `sleep`: sleep.

use std::io::Write;
use std::time::Duration;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next().and_then(|mode| mode.into_string().ok());
    match mode.as_deref() {
        Some("tree") => {
            let grandchild = std::process::Command::new(std::env::current_exe().expect("own path"))
                .arg("sleep")
                .spawn()
                .expect("start the grandchild");
            say(&grandchild.id().to_string());
            sleep_forever()
        }
        Some("ignore-terminate") => {
            ignore_terminate();
            say("ready");
            sleep_forever()
        }
        Some("try-lock") => {
            let path = args.next().expect("a lock file path");
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .expect("open the lock file");
            let locked = codesense_platform::fs::try_lock_exclusive(&file).expect("try the lock");
            say(if locked { "locked" } else { "busy" });
        }
        Some("sleep") => sleep_forever(),
        other => {
            eprintln!("platform-fixture: unknown mode {other:?}");
            std::process::exit(2);
        }
    }
}

fn say(line: &str) {
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn sleep_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

/// Unix: ignore SIGTERM, so only SIGKILL ends this process.
#[cfg(unix)]
fn ignore_terminate() {
    // SAFETY: SIG_IGN installs no handler code.
    unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
}

/// Windows: a Job Object ends its processes outright; there is nothing to
/// ignore.
#[cfg(windows)]
fn ignore_terminate() {}
