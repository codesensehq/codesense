// SPDX-License-Identifier: MIT
//! The process the platform contract tests drive, so they never need a shell.
//!
//! - `tree`: start a `sleep` child (the test's grandchild), print its pid,
//!   then sleep.
//! - `tree-on-input`: as `tree`, once a line arrives on stdin (so a test can
//!   adopt this process's group before the grandchild starts).
//! - `ignore-terminate`: ignore the polite stop, print `ready`, then sleep.
//! - `try-lock <path>`: print `locked` or `busy` for an exclusive lock on
//!   `path`, then exit.
//! - `lock-dir`: print the shared lock directory, then exit.
//! - `console`: print `console window` or `no console window`, then exit.
//! - `sleep`: sleep.
//!
//! IPC client modes take an endpoint's wire form:
//!
//! - `echo <wire>`: send 1 MiB in chunks, reading each chunk back, and print
//!   `ok` when every byte came back in order.
//! - `send <wire> <text>`: send the text and a newline, then wait for the
//!   listener to close.
//! - `peer <wire>`: print the listener's pid as `peer_pid` sees it, then
//!   wait for the listener to close.
//! - `listen <wire>`: bind the endpoint, print `ready`, then sleep.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::time::Duration;

use codesense_platform::ipc::blocking::{LocalListener, LocalStream};
use codesense_platform::ipc::Endpoint;

/// What `echo` sends.
const ECHO_BYTES: usize = 1 << 20;
/// What `echo` sends before reading it back: well inside a pipe's buffers.
const ECHO_CHUNK: usize = 16 * 1024;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next().and_then(|mode| mode.into_string().ok());
    match mode.as_deref() {
        Some(mode @ ("tree" | "tree-on-input")) => {
            if mode == "tree-on-input" {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).expect("read stdin");
            }
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
        Some("echo") => {
            let mut stream = connect(args.next());
            let sent = pattern(ECHO_BYTES);
            let mut back = vec![0; ECHO_CHUNK];
            for chunk in sent.chunks(ECHO_CHUNK) {
                let back = &mut back[..chunk.len()];
                stream.write_all(chunk).expect("send a chunk");
                stream.read_exact(back).expect("read the chunk back");
                assert!(back == chunk, "the echo differs");
            }
            say("ok");
        }
        Some("send") => {
            let mut stream = connect(args.next());
            let text = args.next().expect("the text to send");
            let mut line = text.into_string().expect("UTF-8 text");
            line.push('\n');
            stream.write_all(line.as_bytes()).expect("send the text");
            let _ = stream.read_to_end(&mut Vec::new());
        }
        Some("peer") => {
            let mut stream = connect(args.next());
            say(&stream.peer_pid().expect("the listener's pid").to_string());
            let _ = stream.read_to_end(&mut Vec::new());
        }
        Some("listen") => {
            let _listener = LocalListener::bind(&endpoint(args.next())).expect("bind");
            say("ready");
            sleep_forever()
        }
        Some("lock-dir") => {
            let dir = codesense_platform::dirs::lock_dir().expect("a lock directory");
            say(&dir.display().to_string());
        }
        Some("console") => say(if has_console_window() {
            "console window"
        } else {
            "no console window"
        }),
        Some("sleep") => sleep_forever(),
        other => {
            eprintln!("platform-fixture: unknown mode {other:?}");
            std::process::exit(2);
        }
    }
}

fn endpoint(wire: Option<OsString>) -> Endpoint {
    Endpoint::from_wire(&wire.expect("an endpoint's wire form")).expect("a wire form")
}

fn connect(wire: Option<OsString>) -> LocalStream {
    LocalStream::connect(&endpoint(wire)).expect("connect")
}

/// `len` bytes that do not repeat at any chunk size (xorshift).
fn pattern(len: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 56) as u8
        })
        .collect()
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

/// Unix: no process has a console window.
#[cfg(unix)]
fn has_console_window() -> bool {
    false
}

/// Windows: whether this process's console, if any, has a window.
#[cfg(windows)]
fn has_console_window() -> bool {
    // SAFETY: GetConsoleWindow takes no arguments and only reads.
    !unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() }.is_null()
}
