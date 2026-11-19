// SPDX-License-Identifier: MIT
//! What a terminal needs from the platform's PTY (ConPTY on Windows, the unix
//! PTY elsewhere), checked through what the host makes of it: the emulator
//! worker's screen, the session state the OSC side-tap fills, and the
//! session's exit. Never the raw bytes, which ConPTY re-renders.
//!
//! The child is pty-core's fixture (`tests/bin/pty_fixture.rs`), so no shell
//! is needed, except in `default_shell_smoke`, which runs this OS's default
//! shell. Needs the emulator worker (`pnpm run build:emulator`, or
//! `CODESENSE_EMULATOR_WORKER`): without one the tests skip, unless `CI=1`,
//! where a missing worker fails them.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use codesense_pty_core::domain::{PtySessionId, TerminalDomain, TerminalDomainEvent, ViewerId};
use codesense_pty_core::emulator::{EmulatorConfig, EmulatorText, TextMode};
use codesense_pty_core::layout::ServerIdentity;
use codesense_pty_core::osc::OscEvent;
use codesense_pty_core::runner::{LocalPtyRunner, PtyRunner, PtySpec};
use codesense_pty_core::shell::{shell_kind, ShellKind};
use codesense_pty_core::spawn::{HostEnvironment, SpawnIntent};
use codesense_pty_core::TerminalHost;
use portable_pty::{CommandBuilder, PtySize};
use support::{registration, runtime, RecordingSink};

/// How long anything the tests wait for may take.
const WAIT: Duration = Duration::from_secs(20);
const COLS: u16 = 80;
const ROWS: u16 = 24;

/// One session in a pty, on a host running the emulator worker.
struct Terminal {
    host: TerminalHost,
    events: Arc<RecordingSink>,
    session: PtySessionId,
    /// When the child was spawned.
    spawned: Instant,
    /// The child's working directory.
    dir: tempfile::TempDir,
}

impl Terminal {
    /// `pty-fixture serve` in a temporary directory.
    fn fixture(worker: &Path, osc_enabled: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_pty-fixture"));
        command.arg("serve");
        command.cwd(dir.path());
        Self::start(
            worker,
            PtySpec {
                command,
                size: PtySize {
                    rows: ROWS,
                    cols: COLS,
                    pixel_width: 0,
                    pixel_height: 0,
                },
            },
            osc_enabled,
            dir,
        )
    }

    fn start(worker: &Path, spec: PtySpec, osc_enabled: bool, dir: tempfile::TempDir) -> Self {
        let events = Arc::new(RecordingSink::default());
        let host = TerminalHost::new(
            ServerIdentity::ephemeral("pty-contract"),
            events.clone(),
            runtime().handle().clone(),
        );
        host.start_emulator(EmulatorConfig::new(
            worker.to_path_buf(),
            dir.path().join("runtime"),
        ))
        .expect("start the emulator worker");
        let spawned = Instant::now();
        let pty = runtime()
            .block_on(LocalPtyRunner.spawn(spec))
            .expect("local spawn succeeds");
        let session = PtySessionId::new("contract");
        host.register(pty, registration(session.as_str(), osc_enabled))
            .expect("register the session");
        support::answer_cursor_request(&host, &session);
        Self {
            host,
            events,
            session,
            spawned,
            dir,
        }
    }

    /// Type `line` and Enter.
    fn type_line(&self, line: &str) {
        self.host
            .write(&self.session, format!("{line}\r").as_bytes())
            .expect("write to the session");
    }

    /// The rows on screen, as the emulator worker has parsed them.
    fn screen(&self) -> EmulatorText {
        self.host
            .emulator_text(&self.session, u32::from(ROWS), TextMode::Screen, WAIT)
            .expect("read the screen")
    }

    /// Wait until the screen satisfies `done`, and return it.
    fn wait_for_screen(&self, what: &str, done: impl Fn(&EmulatorText) -> bool) -> EmulatorText {
        let deadline = Instant::now() + WAIT;
        loop {
            let screen = self.screen();
            if done(&screen) {
                return screen;
            }
            assert!(
                Instant::now() < deadline,
                "{what}: never on screen; the screen:\n{}",
                screen.lines.join("\n")
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Wait until a row on screen is exactly `text` (trailing blanks aside).
    fn wait_for_row(&self, text: &str) -> EmulatorText {
        self.wait_for_screen(text, |screen| has_row(screen, text))
    }

    /// Wait until the output has been quiet for `quiet`.
    fn wait_for_quiet(&self, quiet: Duration) {
        let deadline = Instant::now() + WAIT;
        let mut seq = self.host.output_seq(&self.session);
        let mut since = Instant::now();
        while since.elapsed() < quiet {
            assert!(Instant::now() < deadline, "the output never went quiet");
            std::thread::sleep(Duration::from_millis(50));
            let now = self.host.output_seq(&self.session);
            if now != seq {
                seq = now;
                since = Instant::now();
            }
        }
    }

    /// The child's exit code, once it exited.
    fn exit_code(&self) -> Option<u32> {
        let deadline = Instant::now() + WAIT;
        loop {
            let exit = self
                .events
                .0
                .lock()
                .unwrap()
                .iter()
                .find_map(|event| match event {
                    TerminalDomainEvent::Exit {
                        session, status, ..
                    } if *session == self.session => Some(status.clone()),
                    _ => None,
                });
            if let Some(status) = exit {
                return status.and_then(|status| status.exit_code);
            }
            assert!(Instant::now() < deadline, "the session never exited");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The OSC 133 marks the host saw, in order.
    fn prompt_marks(&self) -> Vec<OscEvent> {
        self.events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                TerminalDomainEvent::PromptMarker { session, marker }
                    if *session == self.session =>
                {
                    Some(marker.clone())
                }
                _ => None,
            })
            .collect()
    }
}

impl Drop for Terminal {
    /// End the child with the test, passed or failed.
    fn drop(&mut self) {
        let _ = self.host.kill(&self.session);
    }
}

/// Whether an executable `name` is in a directory on `PATH`.
fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
}

fn has_row(screen: &EmulatorText, text: &str) -> bool {
    screen.lines.iter().any(|row| row.trim_end() == text)
}

fn row(screen: &EmulatorText, index: usize) -> &str {
    screen.lines.get(index).map_or("", |row| row.trim_end())
}

#[test]
fn spawn_reaches_ready() {
    let Some(worker) = support::worker() else {
        return;
    };
    let terminal = Terminal::fixture(&worker, false);
    terminal.wait_for_row("ready");
    let took = terminal.spawned.elapsed();
    assert!(took <= Duration::from_secs(10), "ready after {took:?}");
}

#[test]
fn input_round_trips() {
    let Some(worker) = support::worker() else {
        return;
    };
    let terminal = Terminal::fixture(&worker, false);
    terminal.wait_for_row("ready");
    terminal.type_line("hello world");
    terminal.wait_for_row("pong:hello world");
}

#[test]
fn resize_is_seen_by_child() {
    let Some(worker) = support::worker() else {
        return;
    };
    let terminal = Terminal::fixture(&worker, false);
    terminal.wait_for_row("ready");
    terminal
        .host
        .resize(&ViewerId::new("test"), &terminal.session, 100, 30)
        .expect("resize the session");
    terminal.wait_for_row("size 100x30");
}

#[test]
fn exit_code_propagates() {
    let Some(worker) = support::worker() else {
        return;
    };
    let terminal = Terminal::fixture(&worker, false);
    terminal.wait_for_row("ready");
    terminal.type_line("exit 7");
    assert_eq!(terminal.exit_code(), Some(7));
}

#[test]
fn screen_matches_after_dec_modes() {
    let Some(worker) = support::worker() else {
        return;
    };
    let terminal = Terminal::fixture(&worker, false);
    terminal.wait_for_row("ready");
    terminal.type_line("dec");
    let screen = terminal.wait_for_screen("the alternate screen", |screen| {
        screen.alt_screen && row(screen, 9) == "ap"
    });
    let x_row = "x".repeat(usize::from(COLS));
    // `wrap` written from the second-to-last column wraps once autowrap is back on.
    let wrapped = format!("{}wr", " ".repeat(usize::from(COLS) - 2));
    let expected = [
        "row one",
        "",
        "    at 3,5",
        "",
        x_row.as_str(),
        "",
        "done",
        "",
        wrapped.as_str(),
        "ap",
    ];
    for (index, text) in expected.iter().enumerate() {
        assert_eq!(row(&screen, index), *text, "row {}", index + 1);
    }

    terminal.type_line("normal");
    let screen = terminal.wait_for_screen("the normal screen", |screen| !screen.alt_screen);
    assert!(has_row(&screen, "ready"), "{:?}", screen.lines);
}

#[test]
fn osc133_and_osc7_are_parsed() {
    let Some(worker) = support::worker() else {
        return;
    };
    let terminal = Terminal::fixture(&worker, true);
    terminal.wait_for_row("ready");
    terminal.type_line("osc");
    terminal.wait_for_row("osc done");

    let deadline = Instant::now() + WAIT;
    let expected = [
        OscEvent::PromptStart,
        OscEvent::CommandStart,
        OscEvent::CommandEnd(Some(0)),
    ];
    while terminal.prompt_marks() != expected {
        assert!(
            Instant::now() < deadline,
            "prompt marks: {:?}",
            terminal.prompt_marks()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let cwd = terminal
        .host
        .session_cwd(&terminal.session)
        .unwrap()
        .expect("an OSC 7 cwd");
    // On Windows a cwd still carrying the URL's slash (/C:/x) is not absolute.
    assert!(cwd.is_absolute(), "{}", cwd.display());
    assert_eq!(
        std::fs::canonicalize(&cwd).unwrap(),
        std::fs::canonicalize(terminal.dir.path()).unwrap()
    );
}

#[test]
fn default_shell_smoke() {
    let Some(worker) = support::worker() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    // Interactive (no command): Windows has no POSIX shell to run one.
    let intent = SpawnIntent {
        remote_launch: None,
        command: None,
        argv: None,
        shell: None,
        cwd: dir.path().to_string_lossy().into_owned(),
        cols: COLS,
        rows: ROWS,
        shell_integration: false,
        starship_preset: None,
        api_port: None,
        env_remove: Vec::new(),
        env: Vec::new(),
        agent_env: Vec::new(),
        login_path: None,
    };
    let spec = intent
        .resolve("smoke", &HostEnvironment::of_process(None, None))
        .expect("an interactive shell resolves");
    let program = spec.command.get_argv()[0].clone();
    let kind = shell_kind(Path::new(&program));
    // The shells this OS's smoke runs, the line it types in them, and whether
    // CI must have one: Windows' table always ends in cmd.exe and Linux's in
    // bash, which CI must not settle for or lack.
    let os = std::env::consts::OS;
    let (expected, line, required): (&[ShellKind], &str, bool) = match os {
        "windows" => (
            &[ShellKind::Pwsh, ShellKind::PowerShell],
            "Write-Output hi; exit 3",
            support::in_ci(),
        ),
        "linux" => (&[ShellKind::Bash], "echo hi; exit 3", support::in_ci()),
        _ => (
            &[ShellKind::Zsh, ShellKind::Bash, ShellKind::Fish],
            "echo hi; exit 3",
            false,
        ),
    };
    if !kind.is_some_and(|kind| expected.contains(&kind)) {
        let reason =
            format!("the default shell is {program:?} ({kind:?}), not one of {expected:?}");
        assert!(!required, "{reason}; CI needs one of them");
        eprintln!("skipping: {reason}");
        return;
    }
    if os == "linux" && !required && !on_path("bash") {
        eprintln!("skipping: bash is not on PATH");
        return;
    }

    let terminal = Terminal::start(&worker, spec, false, dir);
    // Typed once the shell's start-up output (its prompt) has settled.
    terminal.wait_for_screen("the prompt", |screen| {
        screen.lines.iter().any(|row| !row.trim().is_empty())
    });
    terminal.wait_for_quiet(Duration::from_millis(500));
    terminal.type_line(line);
    // Only the output counts: the echoed input line is not exactly `hi`.
    terminal.wait_for_row("hi");
    assert_eq!(terminal.exit_code(), Some(3), "{program:?}");
}
