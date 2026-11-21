// SPDX-License-Identifier: MIT
use super::*;

use std::collections::BTreeMap;
use std::ffi::OsString;

/// A folder name a shell would split, quote or run.
const NASTY: &str = "My Repo's \"x\"; echo pwned";

fn nasty_dir() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(NASTY);
    std::fs::create_dir(&dir).unwrap();
    (root, dir)
}

/// Finds every `OnPath` name under `/usr/bin`, every Mac app, and `$TERMINAL` as `env`.
fn finds_all(env: Option<&'static str>) -> impl Fn(&Find) -> Option<PathBuf> {
    move |find: &Find| match find {
        Find::MacApp { program, .. } | Find::Always(program) => Some(PathBuf::from(program)),
        Find::OnPath(name) => Some(Path::new("/usr/bin").join(name)),
        Find::EnvVar(_) => env.map(PathBuf::from),
    }
}

/// Finds only the named rows' programs.
fn finds_only(names: &'static [&'static str]) -> impl Fn(&Find) -> Option<PathBuf> {
    move |find: &Find| match find {
        Find::OnPath(name) if names.contains(name) => Some(Path::new("/usr/bin").join(name)),
        Find::EnvVar(var) if names.contains(&"$TERMINAL") => {
            Some(PathBuf::from(format!("/opt/{}", var.to_lowercase())))
        }
        Find::MacApp { app, program } if names.contains(app) => Some(PathBuf::from(program)),
        Find::Always(program) => Some(PathBuf::from(program)),
        _ => None,
    }
}

fn ids(detected: &[Detected]) -> Vec<&'static str> {
    detected.iter().map(|d| d.row.id).collect()
}

fn args(launch: &Launch) -> Vec<String> {
    launch
        .args
        .iter()
        .map(|a| a.to_str().unwrap().to_string())
        .collect()
}

#[test]
fn linux_rows_are_in_order() {
    let ids: Vec<_> = terminal_rows("linux").iter().map(|r| r.id).collect();
    assert_eq!(
        ids,
        [
            "x-terminal-emulator",
            "env-terminal",
            "gnome-terminal",
            "ptyxis",
            "kgx",
            "konsole",
            "xfce4-terminal",
            "tilix",
            "terminator",
            "kitty",
            "alacritty",
            "wezterm",
            "foot",
            "ghostty",
            "xterm",
        ]
    );
    assert!(terminal_rows("windows").is_empty());
    let mac: Vec<_> = terminal_rows("macos").iter().map(|r| r.id).collect();
    assert_eq!(mac, ["ghostty", "iterm2", "terminal"]);
}

#[test]
fn each_linux_row_puts_the_folder_in_one_argv_element() {
    let (_root, cwd) = nasty_dir();
    let c = cwd.to_str().unwrap();
    let expected: BTreeMap<&str, Vec<String>> = [
        ("x-terminal-emulator", vec![]),
        ("env-terminal", vec![]),
        ("gnome-terminal", vec![format!("--working-directory={c}")]),
        (
            "ptyxis",
            vec!["--new-window".into(), format!("--working-directory={c}")],
        ),
        ("kgx", vec![format!("--working-directory={c}")]),
        ("konsole", vec!["--workdir".into(), c.into()]),
        ("xfce4-terminal", vec![format!("--working-directory={c}")]),
        ("tilix", vec![format!("--working-directory={c}")]),
        ("terminator", vec![format!("--working-directory={c}")]),
        ("kitty", vec!["--directory".into(), c.into()]),
        ("alacritty", vec!["--working-directory".into(), c.into()]),
        ("wezterm", vec!["start".into(), "--cwd".into(), c.into()]),
        ("foot", vec![format!("--working-directory={c}")]),
        ("ghostty", vec![format!("--working-directory={c}")]),
        ("xterm", vec![]),
    ]
    .into_iter()
    .collect();
    assert_eq!(expected.len(), terminal_rows("linux").len());
    for row in terminal_rows("linux") {
        let program = Path::new("/usr/bin").join(row.id);
        let launch = plan(row, &program, &cwd).unwrap();
        assert_eq!(launch.program, OsString::from(&program), "{}", row.id);
        assert_eq!(args(&launch), expected[&row.id], "{}", row.id);
        assert_eq!(launch.cwd.as_deref(), Some(cwd.as_path()), "{}", row.id);
        assert_eq!(launch.wait, None, "{}", row.id);
    }
}

#[test]
fn linux_detection_lists_only_found_rows_and_defaults_to_the_first() {
    let detected = detect("linux", &finds_only(&["konsole", "xterm", "$TERMINAL"]));
    assert_eq!(ids(&detected), ["env-terminal", "konsole", "xterm"]);
    assert_eq!(
        default_terminal("linux", &detected, "ghostty"),
        "env-terminal"
    );
    let tools: Vec<_> = detected.iter().map(Detected::tool).collect();
    assert_eq!(
        tools[0].label, "terminal",
        "$TERMINAL's row is named for its program"
    );
    assert_eq!(tools[1].label, "Konsole");

    let none = detect("linux", &finds_only(&[]));
    assert!(none.is_empty());
    assert_eq!(default_terminal("linux", &none, ""), "");
    assert!(none.iter().all(|d| d.row.id != "terminal"));
}

#[test]
fn macos_detection_is_todays_list_and_default() {
    let all = detect("macos", &finds_all(None));
    assert_eq!(ids(&all), ["ghostty", "iterm2", "terminal"]);
    assert_eq!(default_terminal("macos", &all, "ghostty"), "ghostty");
    assert_eq!(default_terminal("macos", &all, "iTerm.app"), "iterm2");
    assert_eq!(default_terminal("macos", &all, "Apple_Terminal"), "ghostty");
    assert_eq!(default_terminal("macos", &all, ""), "ghostty");

    let bare = detect("macos", &finds_only(&[]));
    assert_eq!(ids(&bare), ["terminal"]);
    assert_eq!(default_terminal("macos", &bare, "ghostty"), "terminal");
    assert_eq!(default_terminal("macos", &bare, "iTerm.app"), "terminal");
    let labels: Vec<_> = all.iter().map(|d| d.tool().label).collect();
    assert_eq!(labels, ["Ghostty", "iTerm2", "Terminal"]);
    // iTerm2 is still found by its bundle, Terminal always; both run `open`.
    assert_eq!(
        terminal_rows("macos")[1].find,
        Find::MacApp {
            app: "iTerm",
            program: "/usr/bin/open"
        }
    );
    assert_eq!(
        terminal_rows("macos")[2].find,
        Find::Always("/usr/bin/open")
    );
    let programs: Vec<_> = all.iter().map(|d| d.program.clone()).collect();
    assert_eq!(
        programs,
        [
            PathBuf::from("/Applications/Ghostty.app/Contents/MacOS/ghostty"),
            PathBuf::from("/usr/bin/open"),
            PathBuf::from("/usr/bin/open"),
        ]
    );
}

#[test]
fn windows_detects_nothing() {
    let detected = detect("windows", &finds_all(Some("/x/term")));
    assert!(detected.is_empty());
    assert_eq!(default_terminal("windows", &detected, ""), "");
}

#[test]
fn terminal_env_is_a_bare_name_on_path_or_an_absolute_executable() {
    let on_path = |name: &str| (name == "foot").then(|| PathBuf::from("/usr/bin/foot"));
    let executable = |path: &Path| path == Path::new("/opt/term/bin/term");
    let env = |value: &str| env_terminal(OsStr::new(value), &on_path, &executable);

    assert_eq!(env("foot"), Some(PathBuf::from("/usr/bin/foot")));
    assert_eq!(
        env("/opt/term/bin/term"),
        Some(PathBuf::from("/opt/term/bin/term"))
    );
    for ignored in [
        "",
        "kitty",
        "foot -e sh",
        "foot\t-e",
        "/opt/term/bin/term --hold",
        "/opt/other",
        "bin/foot",
        "./foot",
        "sh -c 'evil'",
    ] {
        assert_eq!(env(ignored), None, "{ignored:?}");
    }
}

/// `$TERMINAL` set to a command line is not detected, so it is never launched.
#[test]
fn a_terminal_env_with_arguments_is_not_detected() {
    let found = |find: &Find| match find {
        Find::EnvVar(_) => env_terminal(
            OsStr::new("foot --server"),
            &|_: &str| Some(PathBuf::from("/usr/bin/foot")),
            &|_: &Path| true,
        ),
        _ => None,
    };
    assert!(detect("linux", &found).is_empty());
}

#[test]
fn open_terminal_id_rules() {
    let (_root, cwd) = nasty_dir();
    let is_dir = |p: &Path| p.is_dir();
    let found = finds_only(&["konsole", "kitty"]);
    let launch = |id: &str| terminal_launch("linux", id, &cwd, "", &found, &is_dir);

    // A detected id launches that row.
    let kitty = launch("kitty").unwrap();
    assert_eq!(kitty.launch.program, OsString::from("/usr/bin/kitty"));
    assert_eq!(kitty.label, "kitty");
    assert_eq!(kitty.clipboard, None);
    // A known row that isn't installed names itself.
    assert_eq!(
        launch("gnome-terminal"),
        Err(TerminalError::NotInstalled {
            label: "GNOME Terminal".into()
        })
    );
    assert_eq!(
        launch("gnome-terminal").unwrap_err().to_string(),
        "GNOME Terminal is not installed"
    );
    // Empty, unknown and the legacy macOS id take the first detected row.
    for id in ["", "nope", "terminal", "iterm2"] {
        let chosen = launch(id).unwrap();
        assert_eq!(
            chosen.launch.program,
            OsString::from("/usr/bin/konsole"),
            "{id:?}"
        );
        assert_eq!(args(&chosen.launch), ["--workdir", cwd.to_str().unwrap()]);
        assert_eq!(chosen.launch.cwd.as_deref(), Some(cwd.as_path()));
    }

    // The folder must be absolute and exist.
    let relative = terminal_launch("linux", "kitty", Path::new("repo"), "", &found, &is_dir);
    assert_eq!(relative, Err(TerminalError::NotAbsolute("repo".into())));
    let gone = cwd.join("gone");
    let missing = terminal_launch("linux", "kitty", &gone, "", &found, &is_dir);
    assert_eq!(missing, Err(TerminalError::NotADirectory(gone)));
    let file = cwd.join("file");
    std::fs::write(&file, "").unwrap();
    let not_dir = terminal_launch("linux", "kitty", &file, "", &found, &is_dir);
    assert_eq!(not_dir, Err(TerminalError::NotADirectory(file)));
}

#[test]
fn with_no_terminal_the_error_names_every_row_and_terminal_env() {
    let (_root, cwd) = nasty_dir();
    let err = terminal_launch("linux", "", &cwd, "", &finds_only(&[]), &|p: &Path| {
        p.is_dir()
    })
    .unwrap_err();
    assert_eq!(
        err.to_string(),
        "No terminal found (tried x-terminal-emulator, $TERMINAL, gnome-terminal, ptyxis, kgx, \
         konsole, xfce4-terminal, tilix, terminator, kitty, alacritty, wezterm, foot, ghostty, \
         xterm); install one or set TERMINAL"
    );
}

#[test]
fn run_command_is_refused_off_macos_and_windows_is_unsupported() {
    let (_root, cwd) = nasty_dir();
    let is_dir = |p: &Path| p.is_dir();
    assert_eq!(
        terminal_launch("linux", "kitty", &cwd, "make", &finds_all(None), &is_dir),
        Err(TerminalError::RunCommandUnsupported { os: "linux".into() })
    );
    assert_eq!(
        terminal_launch("windows", "", &cwd, "", &finds_all(None), &is_dir),
        Err(TerminalError::Unsupported {
            os: "windows".into()
        })
    );
}

#[test]
fn macos_ghostty_is_the_binary_plus_the_clipboard() {
    let (_root, cwd) = nasty_dir();
    let is_dir = |p: &Path| p.is_dir();
    let chosen = terminal_launch(
        "macos",
        "ghostty",
        &cwd,
        "make dev",
        &finds_all(None),
        &is_dir,
    )
    .unwrap();
    assert_eq!(
        chosen.launch.program,
        OsString::from("/Applications/Ghostty.app/Contents/MacOS/ghostty")
    );
    assert_eq!(
        args(&chosen.launch),
        [format!("--working-directory={}", cwd.to_str().unwrap())]
    );
    let clipboard = chosen.clipboard.expect("the command goes on the clipboard");
    assert_eq!(clipboard.launch.program, OsString::from("/usr/bin/pbcopy"));
    assert!(clipboard.launch.args.is_empty());
    assert_eq!(clipboard.text, "make dev");
    let plain = terminal_launch("macos", "ghostty", &cwd, "", &finds_all(None), &is_dir).unwrap();
    assert_eq!(plain.clipboard, None);
}

/// With no command, Terminal and iTerm2 open the folder with `open -a <bundle>`, waited, the
/// folder one argv element. With one, the folder reaches AppleScript only as an argv element, and
/// the shell only through `quoted form of`: it appears in no script or shell text.
#[test]
fn macos_applescript_rows_take_the_folder_as_argv() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("it's \"a\"; $(touch pwned) `x` dir");
    std::fs::create_dir(&cwd).unwrap();
    let is_dir = |p: &Path| p.is_dir();
    for (id, bundle, script) in [
        ("iterm2", ITERM_APP, ITERM2_SCRIPT),
        ("terminal", TERMINAL_APP, TERMINAL_SCRIPT),
    ] {
        let chosen = terminal_launch("macos", id, &cwd, "", &finds_all(None), &is_dir).unwrap();
        assert_eq!(
            chosen.launch.program,
            OsString::from("/usr/bin/open"),
            "{id}"
        );
        assert_eq!(
            args(&chosen.launch),
            ["-a", bundle, cwd.to_str().unwrap()],
            "{id}"
        );
        assert_eq!(chosen.launch.wait, Some(LAUNCH_LIMIT), "{id}");
        assert_eq!(chosen.clipboard, None);

        // A command runs through the AppleScript: the folder and the command are argv items.
        let with_cmd =
            terminal_launch("macos", id, &cwd, "make dev", &finds_all(None), &is_dir).unwrap();
        assert_eq!(
            with_cmd.launch.program,
            OsString::from("/usr/bin/osascript"),
            "{id}"
        );
        let a = args(&with_cmd.launch);
        assert_eq!(a, ["-e", script, cwd.to_str().unwrap(), "make dev"], "{id}");
        assert!(
            script.contains("on run argv") && script.contains("quoted form of (item 1 of argv)")
        );
        for text in &a[..2] {
            assert!(
                !text.contains("pwned") && !text.contains("it's"),
                "{id}: {text}"
            );
        }
        assert_eq!(with_cmd.launch.wait, None, "{id}");
        assert_eq!(with_cmd.clipboard, None);
    }
}

/// Typed into an interactive shell, a backslash reads differently in fish and control bytes act
/// before any quoting (`^U` kills the line), so the AppleScript rows refuse them when they run a
/// command. With no command nothing is typed, so `open -a` opens any folder.
#[test]
fn macos_applescript_rows_refuse_a_backslash_or_control_bytes() {
    let root = tempfile::tempdir().unwrap();
    let is_dir = |p: &Path| p.is_dir();
    for (name, what) in [
        ("back\\slash", "a backslash"),
        ("x\u{3}y", "a control character"),
        ("x\u{15}touch pwned; :", "a control character"),
        ("x\u{1b}y", "a control character"),
        ("x\ny", "a control character"),
        ("x\ty", "a control character"),
        ("x\u{7f}y", "a control character"),
    ] {
        let cwd = root.path().join(name);
        std::fs::create_dir(&cwd).unwrap();
        for (id, label) in [("iterm2", "iTerm2"), ("terminal", "Terminal")] {
            let err =
                terminal_launch("macos", id, &cwd, "pwd", &finds_all(None), &is_dir).unwrap_err();
            assert_eq!(
                err,
                TerminalError::ShellUnsafe {
                    label: label.into(),
                    cwd: cwd.clone(),
                    what,
                },
                "{name:?}"
            );
            assert!(err.to_string().contains(what));
            let opened = terminal_launch("macos", id, &cwd, "", &finds_all(None), &is_dir);
            assert_eq!(
                opened.map(|chosen| chosen.launch.args.last().cloned()),
                Ok(Some(cwd.clone().into_os_string())),
                "{id} {name:?}"
            );
        }
        // Ghostty takes the folder as its own flag, so it opens there.
        assert!(
            terminal_launch("macos", "ghostty", &cwd, "", &finds_all(None), &is_dir).is_ok(),
            "{name:?}"
        );
    }
}

/// A folder named with non-ASCII text opens with `open -a` when no command runs, and is refused
/// when the AppleScript would type it. The folder is planned, never created: `is_dir` is injected.
#[test]
fn macos_rows_open_a_non_ascii_folder_only_without_a_command() {
    let cwd = Path::new("/tmp/caf\u{e9}");
    let is_dir = |_: &Path| true;
    for (id, label, bundle) in [
        ("iterm2", "iTerm2", ITERM_APP),
        ("terminal", "Terminal", TERMINAL_APP),
    ] {
        let opened = terminal_launch("macos", id, cwd, "", &finds_all(None), &is_dir).unwrap();
        assert_eq!(opened.launch.program, OsString::from("/usr/bin/open"));
        assert_eq!(
            args(&opened.launch),
            ["-a", bundle, "/tmp/caf\u{e9}"],
            "{id}"
        );
        assert_eq!(opened.launch.wait, Some(LAUNCH_LIMIT), "{id}");

        let refused =
            terminal_launch("macos", id, cwd, "pwd", &finds_all(None), &is_dir).unwrap_err();
        assert_eq!(
            refused,
            TerminalError::ShellUnsafe {
                label: label.into(),
                cwd: cwd.into(),
                what: "a non-ASCII character",
            },
            "{id}"
        );
        assert!(refused.to_string().contains("a non-ASCII character"));
    }
}

/// A raw byte of 0x80 or more, which readline in a non-UTF-8 locale can read as a control key
/// (0x95 as `^U`, 0x9b as ESC), is refused with a command and kept intact without one.
#[cfg(unix)]
#[test]
fn macos_rows_refuse_a_raw_high_byte_with_a_command() {
    use std::os::unix::ffi::OsStrExt;
    let is_dir = |_: &Path| true;
    for byte in [0x80u8, 0x95, 0x9b, 0xff] {
        let raw = [b"/tmp/x".as_slice(), &[byte][..], b"y".as_slice()].concat();
        let cwd = Path::new(OsStr::from_bytes(&raw));
        for id in ["iterm2", "terminal"] {
            let refused =
                terminal_launch("macos", id, cwd, "pwd", &finds_all(None), &is_dir).unwrap_err();
            assert!(
                matches!(
                    refused,
                    TerminalError::ShellUnsafe {
                        what: "a non-ASCII character",
                        ..
                    }
                ),
                "{id} {byte:#x}: {refused:?}"
            );
            let opened = terminal_launch("macos", id, cwd, "", &finds_all(None), &is_dir).unwrap();
            assert_eq!(opened.launch.program, OsString::from("/usr/bin/open"));
            assert_eq!(
                opened.launch.args.last(),
                Some(&cwd.as_os_str().to_os_string()),
                "{id} {byte:#x}"
            );
        }
    }
}

/// Records the commands it is handed, so a test sees what the spawn would get.
#[derive(Default)]
struct Recorder(std::cell::RefCell<Vec<(OsString, Option<PathBuf>)>>);

impl crate::shared::opener::Spawn for Recorder {
    fn start(
        &self,
        command: std::process::Command,
        _wait: Option<std::time::Duration>,
    ) -> std::io::Result<crate::shared::opener::Exit> {
        self.0.borrow_mut().push((
            command.get_program().to_os_string(),
            command.get_current_dir().map(Path::to_path_buf),
        ));
        Ok(crate::shared::opener::Exit::Detached)
    }

    fn capture(
        &self,
        _command: std::process::Command,
        _limit: std::time::Duration,
    ) -> std::io::Result<crate::shared::opener::Captured> {
        unreachable!("opening a terminal captures nothing")
    }
}

/// x-terminal-emulator, `$TERMINAL` and xterm take no folder flag: the folder reaches them only
/// as the spawned command's working directory.
#[test]
fn rows_without_a_folder_flag_start_in_the_folder() {
    let (_root, cwd) = nasty_dir();
    let is_dir = |p: &Path| p.is_dir();
    const ROWS: [(&str, &[&str]); 3] = [
        ("x-terminal-emulator", &["x-terminal-emulator"]),
        ("env-terminal", &["$TERMINAL"]),
        ("xterm", &["xterm"]),
    ];
    for (id, names) in ROWS {
        let chosen = terminal_launch("linux", id, &cwd, "", &finds_only(names), &is_dir).unwrap();
        assert!(chosen.launch.args.is_empty(), "{id}");
        let recorder = Recorder::default();
        crate::shared::opener::spawn_first(std::slice::from_ref(&chosen.launch), &recorder)
            .unwrap();
        let started = recorder.0.borrow();
        assert_eq!(started.len(), 1, "{id}");
        assert_eq!(started[0].0, chosen.launch.program, "{id}");
        assert_eq!(started[0].1.as_deref(), Some(cwd.as_path()), "{id}");
    }
}

/// The host lookups, on the host: macOS always has Terminal and a default; Linux never lists the
/// macOS Terminal, and its default is the first terminal found or none. A bare name resolves to
/// an absolute path on `PATH`.
#[test]
fn host_detection_on_this_host() {
    let os = std::env::consts::OS;
    if os != "macos" && os != "linux" {
        return;
    }
    let tools = super::super::detect_tools_impl().unwrap();
    let ids: Vec<_> = tools.terminals.iter().map(|t| t.id.as_str()).collect();
    if os == "macos" {
        assert!(ids.contains(&"terminal"), "{ids:?}");
        assert!(!tools.default_terminal.is_empty());
        assert_eq!(
            host_find(&Find::Always("/usr/bin/open")),
            Some(PathBuf::from("/usr/bin/open"))
        );
    } else {
        assert!(!ids.contains(&"terminal"), "{ids:?}");
        assert_eq!(
            tools.default_terminal,
            ids.first().copied().unwrap_or_default()
        );
    }
    let sh = host_find(&Find::OnPath("sh")).expect("sh is on PATH");
    assert!(sh.is_absolute() && sh.ends_with("sh"), "{sh:?}");
    assert_eq!(host_find(&Find::OnPath("no-such-terminal-here")), None);
}
