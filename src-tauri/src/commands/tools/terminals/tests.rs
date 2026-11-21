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
        assert!(!launch.wait, "{}", row.id);
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
    assert_eq!(chosen.clipboard.as_deref(), Some("make dev"));
    let plain = terminal_launch("macos", "ghostty", &cwd, "", &finds_all(None), &is_dir).unwrap();
    assert_eq!(plain.clipboard, None);
}

/// The folder reaches AppleScript only as an argv element, and the shell only through
/// `quoted form of`: it appears in no script or shell text.
#[test]
fn macos_applescript_rows_take_the_folder_as_argv() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("it's \"a\"; $(touch pwned) `x` dir");
    std::fs::create_dir(&cwd).unwrap();
    let is_dir = |p: &Path| p.is_dir();
    for (id, script) in [("iterm2", ITERM2_SCRIPT), ("terminal", TERMINAL_SCRIPT)] {
        let chosen = terminal_launch("macos", id, &cwd, "", &finds_all(None), &is_dir).unwrap();
        assert_eq!(chosen.launch.program, OsString::from("osascript"), "{id}");
        let a = args(&chosen.launch);
        assert_eq!(a, ["-e", script, cwd.to_str().unwrap()], "{id}");
        assert!(
            script.contains("on run argv") && script.contains("quoted form of (item 1 of argv)")
        );
        for text in &a[..2] {
            assert!(
                !text.contains("pwned") && !text.contains("it's"),
                "{id}: {text}"
            );
        }
        assert_eq!(chosen.clipboard, None);

        // A command to run is the second argv item, not script text.
        let with_cmd =
            terminal_launch("macos", id, &cwd, "make dev", &finds_all(None), &is_dir).unwrap();
        assert_eq!(
            args(&with_cmd.launch)[2..],
            [cwd.to_str().unwrap(), "make dev"]
        );
        assert_eq!(with_cmd.clipboard, None);
    }
}

#[test]
fn macos_applescript_rows_refuse_a_backslash() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("back\\slash");
    std::fs::create_dir(&cwd).unwrap();
    let is_dir = |p: &Path| p.is_dir();
    for (id, label) in [("iterm2", "iTerm2"), ("terminal", "Terminal")] {
        let err = terminal_launch("macos", id, &cwd, "", &finds_all(None), &is_dir).unwrap_err();
        assert_eq!(
            err,
            TerminalError::Backslash {
                label: label.into(),
                cwd: cwd.clone()
            }
        );
        assert!(err.to_string().contains("backslash"));
    }
    // Ghostty takes the folder as its own flag, so a backslash is fine there.
    assert!(terminal_launch("macos", "ghostty", &cwd, "", &finds_all(None), &is_dir).is_ok());
}
