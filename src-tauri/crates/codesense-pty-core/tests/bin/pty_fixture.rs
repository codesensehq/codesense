// SPDX-License-Identifier: MIT
//! The child the pty tests start in a pty, so they need no shell.
//!
//! - `pty-fixture tree <pid file>` (`tests/process_tree.rs`): waits for a `go`
//!   line, then starts one grandchild (itself, asked to `sleep`), on Windows
//!   detached from the console, writes its own pid and the grandchild's to the
//!   file, and sleeps.
//! - `pty-fixture serve` (`tests/pty_contract.rs`): prints `ready`, reports
//!   `size <cols>x<rows>` whenever the terminal's size changes (on SIGWINCH on
//!   unix; Windows has none, so it polls the console's size), and answers each
//!   line it reads:
//!   - `exit <n>`: exits with code n;
//!   - `osc`: emits OSC 133 prompt marks around an OSC 7 report of its working
//!     directory, then `osc done`;
//!   - `dec`: switches to the alternate screen and draws on it with DEC private
//!     modes (autowrap off, then on);
//!   - `normal`: switches back to the normal screen;
//!   - anything else: `pong:<line>`.

use std::io::{BufRead, Write};
use std::time::Duration;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next().expect("a mode: tree, serve or sleep");
    match mode.to_str() {
        Some("sleep") => sleep_forever(),
        Some("tree") => tree(args.next().expect("a pid file").into()),
        Some("serve") => serve(),
        _ => panic!("unknown mode {mode:?}"),
    }
}

fn tree(pid_file: std::path::PathBuf) -> ! {
    // The test says `go` once the runner has put this process in the
    // session's process group, so the grandchild starts inside it.
    let mut line = String::new();
    while line.trim() != "go" {
        line.clear();
        if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
            panic!("stdin closed before `go`");
        }
    }
    let mut grandchild = std::process::Command::new(std::env::current_exe().expect("own path"));
    grandchild
        .arg("sleep")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    platform::detach_from_console(&mut grandchild);
    let grandchild = grandchild.spawn().expect("start the grandchild");
    // Written whole, then renamed, so the test never reads half of it.
    let partial = pid_file.with_extension("partial");
    std::fs::write(
        &partial,
        format!("{} {}", std::process::id(), grandchild.id()),
    )
    .expect("write the pids");
    std::fs::rename(&partial, &pid_file).expect("publish the pids");
    sleep_forever();
}

fn serve() {
    platform::enable_escape_sequences();
    platform::watch_size();
    let mut last = platform::size();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(20));
        if !platform::resized() {
            continue;
        }
        let size = platform::size();
        if let (Some((cols, rows)), true) = (size, size != last) {
            say(&format!("size {cols}x{rows}"));
            last = size;
        }
    });
    say("ready");
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("read a line");
        let line = line.trim_end_matches(['\r', '\n']);
        if let Some(code) = line.strip_prefix("exit ") {
            std::process::exit(code.trim().parse().expect("an exit code"));
        }
        match line {
            "osc" => osc(),
            "dec" => print(&dec_screen()),
            "normal" => print("\x1b[?1049l"),
            _ => say(&format!("pong:{line}")),
        }
    }
}

/// OSC 133 A (prompt start), OSC 7 with this process's working directory as a
/// `file:` URL, OSC 133 B (command start) and D;0 (command end, status 0).
fn osc() {
    let cwd = std::env::current_dir().expect("the working directory");
    let cwd = cwd.to_string_lossy();
    let cwd = cwd.strip_prefix(r"\\?\").unwrap_or(&cwd).replace('\\', "/");
    // A Windows path (C:/x) gets the URL path's leading slash: /C:/x.
    let path = if cwd.starts_with('/') {
        cwd
    } else {
        format!("/{cwd}")
    };
    let path = path.replace('%', "%25").replace(' ', "%20");
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "localhost".into());
    print(&format!(
        "\x1b]133;A\x07\x1b]7;file://{host}{path}\x07\x1b]133;B\x07\x1b]133;D;0\x07"
    ));
    say("osc done");
}

/// The alternate screen, cleared, with `row one` on row 1, `at 3,5` from
/// column 5 of row 3, 100 `x`s on row 5 with autowrap off (so the row ends in
/// the last column), and `done` on row 7 with autowrap back on.
fn dec_screen() -> String {
    format!(
        "\x1b[?1049h\x1b[2J\x1b[H\x1b[?7lrow one\x1b[3;5Hat 3,5\x1b[5;1H{}\x1b[?7h\x1b[7;1Hdone",
        "x".repeat(100)
    )
}

/// Write `text` and a line end, at once.
fn say(text: &str) {
    print(&format!("{text}\r\n"));
}

fn print(text: &str) {
    let mut out = std::io::stdout().lock();
    out.write_all(text.as_bytes())
        .expect("write to the terminal");
    out.flush().expect("flush the terminal");
}

fn sleep_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

#[cfg(unix)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};

    static RESIZED: AtomicBool = AtomicBool::new(false);

    extern "C" fn on_winch(_: libc::c_int) {
        RESIZED.store(true, Ordering::SeqCst);
    }

    pub fn detach_from_console(_: &mut std::process::Command) {}

    pub fn enable_escape_sequences() {}

    pub fn watch_size() {
        let handler: extern "C" fn(libc::c_int) = on_winch;
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        unsafe { libc::signal(libc::SIGWINCH, handler as libc::sighandler_t) };
    }

    pub fn resized() -> bool {
        RESIZED.swap(false, Ordering::SeqCst)
    }

    pub fn size() -> Option<(u16, u16)> {
        // SAFETY: all-zero is a valid winsize, which the ioctl fills.
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        // SAFETY: TIOCGWINSZ writes one winsize through the pointer.
        let ok = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == 0;
        ok.then_some((size.ws_col, size.ws_row))
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;

    /// `DETACHED_PROCESS`: the process gets no console, so closing the
    /// pseudo console does not end it.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    /// `(DWORD)-11`.
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;

    #[repr(C)]
    #[allow(dead_code)]
    struct Coord {
        x: i16,
        y: i16,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct SmallRect {
        left: i16,
        top: i16,
        right: i16,
        bottom: i16,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct ScreenBufferInfo {
        size: Coord,
        cursor: Coord,
        attributes: u16,
        window: SmallRect,
        max_window: Coord,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut c_void;
        fn GetConsoleMode(console: *mut c_void, mode: *mut u32) -> i32;
        fn SetConsoleMode(console: *mut c_void, mode: u32) -> i32;
        fn GetConsoleScreenBufferInfo(console: *mut c_void, info: *mut ScreenBufferInfo) -> i32;
    }

    pub fn detach_from_console(command: &mut std::process::Command) {
        command.creation_flags(DETACHED_PROCESS);
    }

    pub fn enable_escape_sequences() {
        // SAFETY: reads and sets the mode of this process's console output.
        unsafe {
            let out = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(out, &mut mode) != 0 {
                SetConsoleMode(out, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
        }
    }

    /// Windows sends no resize signal: [`resized`] always says to look.
    pub fn watch_size() {}

    pub fn resized() -> bool {
        true
    }

    pub fn size() -> Option<(u16, u16)> {
        // SAFETY: all-zero is a valid value of this plain-data struct, which
        // the call fills.
        let mut info: ScreenBufferInfo = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is writable for the call.
        let ok = unsafe { GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) };
        let window = &info.window;
        (ok != 0).then(|| {
            (
                (window.right - window.left + 1) as u16,
                (window.bottom - window.top + 1) as u16,
            )
        })
    }
}
