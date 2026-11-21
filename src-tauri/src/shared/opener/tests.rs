// SPDX-License-Identifier: MIT
use super::*;

use std::cell::RefCell;
use std::collections::{BTreeSet, VecDeque};

/// A filesystem of named files and folders.
#[derive(Default)]
struct FakeFs {
    files: BTreeSet<PathBuf>,
    dirs: BTreeSet<PathBuf>,
}

impl FakeFs {
    fn with(files: &[&str], dirs: &[&str]) -> Self {
        Self {
            files: files.iter().map(PathBuf::from).collect(),
            dirs: dirs.iter().map(PathBuf::from).collect(),
        }
    }
}

impl Fs for FakeFs {
    fn exists(&self, path: &Path) -> bool {
        self.files.contains(path) || self.dirs.contains(path)
    }
    fn is_dir(&self, path: &Path) -> bool {
        self.dirs.contains(path)
    }
}

/// What a recorded command looked like.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Started {
    program: OsString,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    removed: Vec<OsString>,
    wait: Option<Duration>,
}

/// Records each command and answers from a script (spawned and detached once it runs out).
#[derive(Default)]
struct Recorder {
    started: RefCell<Vec<Started>>,
    answers: RefCell<VecDeque<io::Result<Exit>>>,
}

impl Recorder {
    fn answering(answers: Vec<io::Result<Exit>>) -> Self {
        Self {
            started: RefCell::default(),
            answers: RefCell::new(answers.into()),
        }
    }
    fn programs(&self) -> Vec<String> {
        self.started
            .borrow()
            .iter()
            .map(|s| s.program.to_string_lossy().into_owned())
            .collect()
    }
}

impl Spawn for Recorder {
    fn start(&self, command: Command, wait: Option<Duration>) -> io::Result<Exit> {
        self.started.borrow_mut().push(Started {
            program: command.get_program().to_os_string(),
            args: command.get_args().map(OsStr::to_os_string).collect(),
            cwd: command.get_current_dir().map(Path::to_path_buf),
            removed: command
                .get_envs()
                .filter(|(_, value)| value.is_none())
                .map(|(key, _)| key.to_os_string())
                .collect(),
            wait,
        });
        self.answers
            .borrow_mut()
            .pop_front()
            .unwrap_or(Ok(Exit::Detached))
    }

    fn capture(&self, _command: Command, _limit: Duration) -> io::Result<Captured> {
        unreachable!("these tests don't capture")
    }
}

fn not_found() -> io::Result<Exit> {
    Err(io::Error::from(io::ErrorKind::NotFound))
}

fn facts(text_default: Result<&str, TextDefaultMissing>) -> HostFacts {
    HostFacts {
        is_wsl: false,
        xdg_data_home: Some(PathBuf::from("/home/u/.local/share")),
        xdg_data_dirs: vec![
            PathBuf::from("/usr/local/share"),
            PathBuf::from("/usr/share"),
        ],
        text_default: text_default.map(str::to_string),
    }
}

fn programs_and_args(launches: &[Launch]) -> Vec<(String, Vec<String>)> {
    launches
        .iter()
        .map(|l| {
            (
                l.program.to_string_lossy().into_owned(),
                l.args
                    .iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect(),
            )
        })
        .collect()
}

const DIR: &str = "/home/u/My Repo";
const FILE: &str = "/home/u/team/bad-123456.yaml";

#[test]
fn linux_folder_is_the_open_crate_list_in_order() {
    let fs = FakeFs::with(&[], &[DIR]);
    let launches = plans("linux", Open::Folder(Path::new(DIR)), &facts(Ok("")), &fs).unwrap();
    let expected: Vec<(String, Vec<String>)> = [
        ("xdg-open", vec![DIR]),
        ("gio", vec!["open", DIR]),
        ("gnome-open", vec![DIR]),
        ("kde-open", vec![DIR]),
    ]
    .into_iter()
    .map(|(p, a)| (p.to_string(), a.into_iter().map(String::from).collect()))
    .collect();
    assert_eq!(programs_and_args(&launches), expected);
    assert!(launches.iter().all(|l| l.wait.is_none() && l.cwd.is_none()));

    let wsl = HostFacts {
        is_wsl: true,
        ..facts(Ok(""))
    };
    let launches = plans("linux", Open::Folder(Path::new(DIR)), &wsl, &fs).unwrap();
    let programs: Vec<_> = programs_and_args(&launches)
        .into_iter()
        .map(|(p, _)| p)
        .collect();
    assert_eq!(
        programs,
        ["wslview", "xdg-open", "gio", "gnome-open", "kde-open"]
    );
}

/// The table is the opener plugin's own list: a crate update that changes it fails here. Runs
/// only on a Linux host, where `open::commands` returns its Linux list.
#[test]
fn linux_folder_table_matches_open_commands_on_linux() {
    if std::env::consts::OS != "linux" {
        return;
    }
    let theirs: Vec<String> = open::commands(DIR)
        .iter()
        .map(|c| c.get_program().to_string_lossy().into_owned())
        .collect();
    let host = HostFacts {
        is_wsl: theirs.first().map(String::as_str) == Some("wslview"),
        ..facts(Ok(""))
    };
    let fs = FakeFs::with(&[], &[DIR]);
    let ours: Vec<String> = plans("linux", Open::Folder(Path::new(DIR)), &host, &fs)
        .unwrap()
        .iter()
        .map(|l| l.program.to_string_lossy().into_owned())
        .collect();
    assert_eq!(ours, theirs);
}

#[test]
fn macos_plans_are_todays_programs() {
    let fs = FakeFs::with(&[FILE], &[DIR]);
    let folder = plans("macos", Open::Folder(Path::new(DIR)), &facts(Ok("")), &fs).unwrap();
    assert_eq!(
        folder,
        vec![Launch {
            program: "/usr/bin/open".into(),
            args: vec!["-R".into(), DIR.into()],
            cwd: None,
            wait: None,
            note: None,
        }]
    );
    let text = plans("macos", Open::Text(Path::new(FILE)), &facts(Ok("")), &fs).unwrap();
    assert_eq!(
        text,
        vec![Launch {
            program: "/usr/bin/open".into(),
            args: vec!["-t".into(), FILE.into()],
            cwd: None,
            wait: Some(LAUNCH_LIMIT),
            note: None,
        }]
    );
}

/// A package folder is a directory, and `open` would launch it: macOS only ever selects a folder
/// in Finder (`-R`), never opens it.
#[test]
fn macos_reveals_a_package_folder_without_launching_it() {
    let app = "/home/u/team/Evil.app";
    let fs = FakeFs::with(&["/home/u/team/Evil.app/Contents/Info.plist"], &[app]);
    let launches = plans("macos", Open::Folder(Path::new(app)), &facts(Ok("")), &fs).unwrap();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].program, OsString::from("/usr/bin/open"));
    assert_eq!(
        launches[0].args,
        vec![OsString::from("-R"), OsString::from(app)]
    );
    assert_eq!(launches[0].wait, None);
}

#[test]
fn windows_and_unknown_oses_are_unsupported() {
    let fs = FakeFs::with(&[FILE], &[DIR]);
    for os in ["windows", "freebsd"] {
        for req in [Open::Folder(Path::new(DIR)), Open::Text(Path::new(FILE))] {
            assert_eq!(
                plans(os, req, &facts(Ok("gedit.desktop")), &fs),
                Err(OpenError::Unsupported { os: os.into() })
            );
            assert_eq!(
                OpenError::Unsupported { os: os.into() }.to_string(),
                format!("opening folders and files isn't supported on {os} yet")
            );
        }
    }
}

#[test]
fn a_folder_must_be_an_absolute_existing_folder_on_every_os() {
    let fs = FakeFs::with(&[FILE], &[DIR]);
    for os in ["macos", "linux"] {
        let file = plans(os, Open::Folder(Path::new(FILE)), &facts(Ok("")), &fs);
        assert_eq!(file, Err(OpenError::NotADirectory(FILE.into())), "{os}");
        let missing = plans(os, Open::Folder(Path::new("/nope")), &facts(Ok("")), &fs);
        assert_eq!(
            missing,
            Err(OpenError::NotADirectory("/nope".into())),
            "{os}"
        );
        let relative = plans(os, Open::Folder(Path::new("My Repo")), &facts(Ok("")), &fs);
        assert_eq!(
            relative,
            Err(OpenError::NotAbsolute("My Repo".into())),
            "{os}"
        );
    }
}

#[test]
fn text_must_be_an_absolute_existing_file_on_every_os() {
    let fs = FakeFs::with(&[FILE], &[DIR]);
    let ok = facts(Ok("org.gnome.TextEditor.desktop"));
    for os in ["macos", "linux"] {
        for (path, error) in [
            (DIR, OpenError::NotAFile(DIR.into())),
            ("/nope.yaml", OpenError::NotAFile("/nope.yaml".into())),
            ("bad.yaml", OpenError::NotAbsolute("bad.yaml".into())),
        ] {
            assert_eq!(
                plans(os, Open::Text(Path::new(path)), &ok, &fs),
                Err(error),
                "{os} {path}"
            );
        }
    }
}

#[test]
fn linux_text_launches_the_text_plain_default_through_gio_waited() {
    let desktop = "/usr/share/applications/org.gnome.TextEditor.desktop";
    let fs = FakeFs::with(&[FILE, desktop], &[]);
    let launches = plans(
        "linux",
        Open::Text(Path::new(FILE)),
        &facts(Ok("org.gnome.TextEditor.desktop")),
        &fs,
    )
    .unwrap();
    assert_eq!(
        launches,
        vec![Launch {
            program: "gio".into(),
            args: vec!["launch".into(), desktop.into(), FILE.into()],
            cwd: None,
            wait: Some(LAUNCH_LIMIT),
            note: Some(GIO_LAUNCH_NOTE),
        }]
    );
}

#[test]
fn linux_text_names_each_missing_piece() {
    let fs = FakeFs::with(&[FILE], &[]);
    let text = |default| plans("linux", Open::Text(Path::new(FILE)), &facts(default), &fs);

    let no_xdg_mime = text(Err(TextDefaultMissing::NoXdgMime)).unwrap_err();
    assert!(no_xdg_mime.to_string().contains("xdg-mime isn't installed"));
    let failed = text(Err(TextDefaultMissing::QueryFailed(
        "exit status: 4".into(),
    )))
    .unwrap_err();
    assert!(failed
        .to_string()
        .contains("xdg-mime query default text/plain failed (exit status: 4)"));
    let empty = text(Err(TextDefaultMissing::Empty)).unwrap_err();
    assert!(empty
        .to_string()
        .contains("no default application for text/plain"));

    let unresolved = text(Ok("kate.desktop")).unwrap_err();
    assert_eq!(
        unresolved,
        OpenError::DesktopFileNotFound("kate.desktop".into())
    );
    assert!(unresolved.to_string().contains("kate.desktop"));

    let missing_file = plans(
        "linux",
        Open::Text(Path::new("/gone.yaml")),
        &facts(Ok("kate.desktop")),
        &fs,
    )
    .unwrap_err();
    assert!(missing_file.to_string().contains("/gone.yaml"));

    // gio missing, or too old to know `launch`.
    let desktop = "/usr/share/applications/kate.desktop";
    let fs = FakeFs::with(&[FILE, desktop], &[]);
    let launches = plans(
        "linux",
        Open::Text(Path::new(FILE)),
        &facts(Ok("kate.desktop")),
        &fs,
    )
    .unwrap();
    let no_gio = spawn_first(&launches, &Recorder::answering(vec![not_found()])).unwrap_err();
    let message = no_gio.to_string();
    assert!(
        message.contains("couldn't start gio") && !message.contains("GLib"),
        "{message}"
    );
    let old_gio = spawn_first(
        &launches,
        &Recorder::answering(vec![Ok(Exit::Status {
            success: false,
            describe: "exit status: 1".into(),
        })]),
    )
    .unwrap_err();
    let message = old_gio.to_string();
    assert!(
        message.contains("gio failed (exit status: 1)") && message.contains("GLib 2.68"),
        "{message}"
    );
}

#[test]
fn a_malformed_or_path_bearing_desktop_id_is_refused() {
    for id in [
        "../evil.desktop",
        "/usr/bin/evil.desktop",
        "kde4/kate.desktop",
        "a..b.desktop",
        ".desktop",
        "-x.desktop",
        ".hidden.desktop",
        "kate",
        "kate.desktop --new-window",
        "kate.desktop\nevil.desktop",
        "kate.desktop;",
        "",
        "katé.desktop",
    ] {
        assert!(!valid_desktop_id(id), "{id:?} was accepted");
        let desktop = format!("/usr/share/applications/{id}");
        let fs = FakeFs::with(&[FILE, desktop.as_str()], &[]);
        let result = plans("linux", Open::Text(Path::new(FILE)), &facts(Ok(id)), &fs);
        assert_eq!(
            result,
            Err(OpenError::BadDesktopId(id.trim().into())),
            "{id:?}"
        );
    }
    for id in [
        "code-oss.desktop",
        "org.gnome.TextEditor.desktop",
        "kde4-kate.desktop",
        "gedit.desktop",
        "Mousepad_1.desktop",
    ] {
        assert!(valid_desktop_id(id), "{id:?} was refused");
    }
}

#[test]
fn the_desktop_id_is_trimmed_before_it_is_checked() {
    let desktop = "/usr/share/applications/gedit.desktop";
    let fs = FakeFs::with(&[FILE, desktop], &[]);
    let launches = plans(
        "linux",
        Open::Text(Path::new(FILE)),
        &facts(Ok("  gedit.desktop\n")),
        &fs,
    )
    .unwrap();
    assert_eq!(launches[0].args[1], OsString::from(desktop));
}

#[test]
fn resolve_desktop_id_on_a_real_tree() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home-share");
    let local = root.path().join("local-share");
    let usr = root.path().join("usr-share");
    let put = |dir: &Path, name: &str| {
        let path = dir.join("applications").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "[Desktop Entry]\n").unwrap();
        path
    };
    let is_file = |p: &Path| p.is_file();
    let dirs = vec![local.clone(), usr.clone()];

    // The home wins over the data dirs, and the first data dir over the next.
    let in_usr = put(&usr, "gedit.desktop");
    assert_eq!(
        resolve_desktop_id("gedit.desktop", Some(&home), &dirs, &is_file),
        Some(in_usr)
    );
    let in_local = put(&local, "gedit.desktop");
    assert_eq!(
        resolve_desktop_id("gedit.desktop", Some(&home), &dirs, &is_file),
        Some(in_local)
    );
    let in_home = put(&home, "gedit.desktop");
    assert_eq!(
        resolve_desktop_id("gedit.desktop", Some(&home), &dirs, &is_file),
        Some(in_home)
    );

    // The literal ID first, then `-` → `/` splits from the left.
    let literal = put(&usr, "code-oss.desktop");
    put(&usr, "code/oss.desktop");
    assert_eq!(
        resolve_desktop_id("code-oss.desktop", None, &dirs, &is_file),
        Some(literal)
    );
    let nested = put(&usr, "kde4/kate.desktop");
    assert_eq!(
        resolve_desktop_id("kde4-kate.desktop", None, &dirs, &is_file),
        Some(nested)
    );
    let second_split = put(&usr, "org-kde/kwrite.desktop");
    assert_eq!(
        resolve_desktop_id("org-kde-kwrite.desktop", None, &dirs, &is_file),
        Some(second_split)
    );

    // Relative directories are ignored, and an unknown ID resolves to nothing.
    assert_eq!(
        resolve_desktop_id(
            "gedit.desktop",
            Some(Path::new("relative")),
            &[PathBuf::from("also/relative")],
            &|_: &Path| true
        ),
        None
    );
    assert_eq!(
        resolve_desktop_id("nothing.desktop", Some(&home), &dirs, &is_file),
        None
    );
    // A malformed ID never reaches the filesystem.
    assert_eq!(
        resolve_desktop_id("../gedit.desktop", None, &dirs, &|_: &Path| true),
        None
    );
    // A folder named like a desktop file isn't one.
    std::fs::create_dir_all(usr.join("applications/folder.desktop")).unwrap();
    assert_eq!(
        resolve_desktop_id("folder.desktop", None, &dirs, &is_file),
        None
    );
}

#[test]
fn xdg_dirs_follow_the_spec_defaults() {
    let home = Path::new("/home/u");
    assert_eq!(
        data_home(None, Some(home)),
        Some(PathBuf::from("/home/u/.local/share"))
    );
    assert_eq!(
        data_home(Some(OsStr::new("")), Some(home)),
        Some(PathBuf::from("/home/u/.local/share"))
    );
    assert_eq!(
        data_home(Some(OsStr::new("rel/share")), Some(home)),
        Some(PathBuf::from("/home/u/.local/share"))
    );
    assert_eq!(
        data_home(Some(OsStr::new("/data")), Some(home)),
        Some(PathBuf::from("/data"))
    );
    assert_eq!(data_home(None, None), None);

    let default = vec![
        PathBuf::from("/usr/local/share"),
        PathBuf::from("/usr/share"),
    ];
    assert_eq!(data_dirs(None), default);
    assert_eq!(data_dirs(Some(OsStr::new(""))), default);
    assert_eq!(data_dirs(Some(OsStr::new("rel:also"))), default);
    assert_eq!(
        data_dirs(Some(OsStr::new("/opt/share:rel:/usr/share"))),
        vec![PathBuf::from("/opt/share"), PathBuf::from("/usr/share")]
    );
}

#[test]
fn spawn_first_tries_the_next_launcher_only_when_one_cannot_start() {
    let fs = FakeFs::with(&[], &[DIR]);
    let launches = plans("linux", Open::Folder(Path::new(DIR)), &facts(Ok("")), &fs).unwrap();

    let recorder = Recorder::answering(vec![not_found(), not_found(), Ok(Exit::Detached)]);
    assert_eq!(spawn_first(&launches, &recorder), Ok(()));
    assert_eq!(recorder.programs(), ["xdg-open", "gio", "gnome-open"]);

    let recorder = Recorder::answering((0..4).map(|_| not_found()).collect());
    let Err(OpenError::NoLauncher { tried }) = spawn_first(&launches, &recorder) else {
        panic!("expected NoLauncher");
    };
    let tried: Vec<_> = tried.iter().map(|t| t.program.as_str()).collect();
    assert_eq!(tried, ["xdg-open", "gio", "gnome-open", "kde-open"]);

    // A waited launcher that ran and failed is an error; the next isn't tried.
    let waited: Vec<Launch> = launches
        .iter()
        .cloned()
        .map(|l| l.waited(LAUNCH_LIMIT))
        .collect();
    let recorder = Recorder::answering(vec![Ok(Exit::Status {
        success: false,
        describe: "exit status: 2".into(),
    })]);
    assert_eq!(
        spawn_first(&waited, &recorder),
        Err(OpenError::Failed {
            program: "xdg-open".into(),
            status: "exit status: 2".into(),
            note: None,
        })
    );
    assert_eq!(recorder.programs(), ["xdg-open"]);
    assert_eq!(recorder.started.borrow()[0].wait, Some(LAUNCH_LIMIT));

    assert_eq!(
        spawn_first(&[], &Recorder::default()),
        Err(OpenError::NoLauncher { tried: vec![] })
    );
}

#[test]
fn every_launch_drops_the_app_owned_webkit_env() {
    let _owned = crate::linux_startup::force_app_owned_for_test(true);
    let fs = FakeFs::with(&[], &[DIR]);
    let launches = plans("linux", Open::Folder(Path::new(DIR)), &facts(Ok("")), &fs).unwrap();
    let recorder = Recorder::answering((0..4).map(|_| not_found()).collect());
    let _ = spawn_first(&launches, &recorder);
    let started = recorder.started.borrow();
    assert_eq!(started.len(), 4);
    for s in started.iter() {
        let removed: BTreeSet<_> = s
            .removed
            .iter()
            .map(|k| k.to_string_lossy().into_owned())
            .collect();
        assert!(
            removed.contains("WEBKIT_DISABLE_DMABUF_RENDERER")
                && removed.contains("CODESENSE_WEBKIT_DMABUF_DEFAULT"),
            "{s:?}"
        );
        assert_eq!(s.args.last(), Some(&OsString::from(DIR)));
        assert_eq!(s.cwd, None);
    }
}

#[test]
fn a_timed_out_launcher_is_an_error_and_the_next_is_not_tried() {
    let fs = FakeFs::with(&[], &[DIR]);
    let launches: Vec<Launch> = plans("linux", Open::Folder(Path::new(DIR)), &facts(Ok("")), &fs)
        .unwrap()
        .into_iter()
        .map(|l| l.waited(Duration::from_secs(30)))
        .collect();
    let recorder = Recorder::answering(vec![Ok(Exit::TimedOut { pid: 4242 })]);
    let error = spawn_first(&launches, &recorder).unwrap_err();
    assert_eq!(
        error,
        OpenError::TimedOut {
            program: "xdg-open".into(),
            limit: Duration::from_secs(30),
        }
    );
    assert_eq!(recorder.programs(), ["xdg-open"]);
    assert_eq!(
        error.to_string(),
        "xdg-open didn't finish within 30 s; it may still open"
    );
    let short = OpenError::TimedOut {
        program: "gio".into(),
        limit: Duration::from_millis(250),
    };
    assert_eq!(
        short.to_string(),
        "gio didn't finish within 250 ms; it may still open"
    );
}

/// Every launcher the executor waits for reaches it with a limit; the folder launchers aren't
/// waited.
#[test]
fn every_waited_row_carries_a_limit() {
    let desktop = "/usr/share/applications/gedit.desktop";
    let fs = FakeFs::with(&[FILE, desktop], &[DIR]);
    let facts = facts(Ok("gedit.desktop"));
    for os in ["macos", "linux"] {
        let text = plans(os, Open::Text(Path::new(FILE)), &facts, &fs).unwrap();
        let recorder = Recorder::answering(vec![Ok(Exit::Status {
            success: true,
            describe: "exit status: 0".into(),
        })]);
        assert_eq!(spawn_first(&text, &recorder), Ok(()), "{os}");
        let waits: Vec<_> = recorder.started.borrow().iter().map(|s| s.wait).collect();
        assert_eq!(waits, [Some(LAUNCH_LIMIT)], "{os}");

        let folder = plans(os, Open::Folder(Path::new(DIR)), &facts, &fs).unwrap();
        assert!(folder.iter().all(|l| l.wait.is_none()), "{os}");
    }
    assert_eq!(QUERY_LIMIT, Duration::from_secs(10));
    assert_eq!(LAUNCH_LIMIT, Duration::from_secs(30));
}

#[cfg(unix)]
fn sh(script: &str, args: &[&OsStr]) -> Command {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(script).arg("sh").args(args);
    command
}

/// Whether `kill(pid, 0)` finds nothing (ESRCH).
#[cfg(unix)]
fn pid_is_gone(pid: u32) -> bool {
    let found = unsafe { libc::kill(pid as libc::pid_t, 0) };
    found == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// A real child still running at its limit is killed and reaped well within the test's time,
/// and its pid is gone afterwards.
#[cfg(unix)]
#[test]
fn a_waited_child_past_its_limit_is_killed_and_reaped() {
    let started = Instant::now();
    let exit = HostSpawn
        .start(sh("sleep 5", &[]), Some(Duration::from_millis(200)))
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "{exit:?}");
    let Exit::TimedOut { pid } = exit else {
        panic!("expected TimedOut, got {exit:?}");
    };
    assert!(pid_is_gone(pid), "pid {pid} is still there");
}

/// A launcher that exits in time reports its status and leaves what it started running.
#[cfg(unix)]
#[test]
fn a_waited_launcher_that_exits_in_time_leaves_what_it_started() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let exit = HostSpawn
        .start(
            sh(
                "sleep 5 >/dev/null 2>&1 & echo $! > \"$1\"",
                &[pid_file.as_os_str()],
            ),
            Some(Duration::from_secs(5)),
        )
        .unwrap();
    assert!(
        matches!(exit, Exit::Status { success: true, .. }),
        "{exit:?}"
    );
    let pid: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    assert!(alive, "the launcher's child {pid} was killed");

    let failed = HostSpawn
        .start(sh("exit 3", &[]), Some(Duration::from_secs(5)))
        .unwrap();
    assert!(
        matches!(&failed, Exit::Status { success: false, describe } if describe.contains('3')),
        "{failed:?}"
    );
}

/// The reader drains the pipe while the child runs, so more output than a pipe holds still
/// completes.
#[cfg(unix)]
#[test]
fn a_capture_of_more_than_a_pipe_holds_completes() {
    let captured = HostSpawn
        .capture(sh("head -c 100000 /dev/zero", &[]), Duration::from_secs(10))
        .unwrap();
    assert!(
        matches!(captured.exit, Exit::Status { success: true, .. }),
        "{:?}",
        captured.exit
    );
    assert_eq!(captured.stdout.len(), 100_000);
}

/// A capture returns at its root's exit even when the root left a child holding stdout: the
/// rest of the tree is killed then, which closes the pipe.
#[cfg(unix)]
#[test]
fn a_capture_returns_when_its_root_exits_despite_a_child_holding_stdout() {
    let started = Instant::now();
    let captured = HostSpawn
        .capture(sh("sleep 5 & echo $!", &[]), Duration::from_secs(10))
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "{captured:?}");
    assert!(
        matches!(captured.exit, Exit::Status { success: true, .. }),
        "{:?}",
        captured.exit
    );
    let printed = String::from_utf8_lossy(&captured.stdout);
    assert!(printed.trim().parse::<u32>().is_ok(), "{printed:?}");
}

/// A capture still running at its limit is killed, and its reader returns.
#[cfg(unix)]
#[test]
fn a_capture_past_its_limit_is_killed() {
    let started = Instant::now();
    let captured = HostSpawn
        .capture(sh("echo early; sleep 5", &[]), Duration::from_millis(200))
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "{captured:?}");
    let Exit::TimedOut { pid } = captured.exit else {
        panic!("expected TimedOut, got {:?}", captured.exit);
    };
    assert!(pid_is_gone(pid), "pid {pid} is still there");
    assert_eq!(captured.stdout, b"early\n");
}
