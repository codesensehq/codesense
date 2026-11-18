// SPDX-License-Identifier: MIT
//! The platform contract: the same tests on every OS. Test bodies hold no
//! `cfg`; what differs per OS is stated once, in an `expect_*` helper at the
//! end. Process tests drive the `platform-fixture` binary, never a shell.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use codesense_platform::dirs::codesense_home;
use codesense_platform::fs::{
    atomic_replace, canonicalize, create_new_owner_only, create_owner_only, file_id, file_id_of,
    is_owned_by_current_user, is_owner_only, link_or_copy, lock_exclusive, open_nofollow,
    portable_name, set_owner_only, try_lock_exclusive, Linked, NonPortableName, Open,
};
use codesense_platform::process::{is_alive, kill_hard, terminate, Pid, ProcessTree};
use codesense_platform::testutil::symlink_or_skip;
use codesense_platform::user::current_user;

fn fixture(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_platform-fixture"));
    command.args(args).stdout(Stdio::piped());
    command
}

/// The fixture's first line of output.
fn first_line(tree: &mut ProcessTree) -> String {
    let stdout = tree.child().stdout.take().expect("piped stdout");
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    line.trim().to_owned()
}

/// Poll `done` every 20 ms until it holds or `limit` passes.
fn eventually(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if done() {
            return true;
        }
        if start.elapsed() > limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Whether the tree's root exits (and is reaped) within `limit`.
fn exits_within(tree: &mut ProcessTree, limit: Duration) -> bool {
    eventually(limit, || tree.try_wait().unwrap().is_some())
}

fn spawn_tree() -> (ProcessTree, Pid) {
    let mut tree = ProcessTree::spawn(&mut fixture(&["tree"])).unwrap();
    let grandchild = Pid::from_raw(first_line(&mut tree).parse().unwrap());
    assert!(is_alive(tree.pid()));
    assert!(is_alive(grandchild));
    (tree, grandchild)
}

#[test]
fn terminate_kills_child_and_grandchild() {
    let (mut tree, grandchild) = spawn_tree();
    terminate(&tree).unwrap();
    assert!(
        eventually(Duration::from_secs(5), || !is_alive(grandchild)),
        "the grandchild outlived terminate"
    );
    assert!(exits_within(&mut tree, Duration::from_secs(5)));
    assert!(!is_alive(tree.pid()));
}

#[test]
fn dropping_the_tree_kills_child_and_grandchild() {
    let (tree, grandchild) = spawn_tree();
    let child = tree.pid();
    drop(tree);
    let gone = || !is_alive(grandchild) && !is_alive(child);
    assert!(eventually(Duration::from_secs(5), gone));
}

#[test]
fn kill_hard_ends_a_process_that_ignores_terminate() {
    let mut tree = ProcessTree::spawn(&mut fixture(&["ignore-terminate"])).unwrap();
    assert_eq!(first_line(&mut tree), "ready");
    terminate(&tree).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        tree.try_wait().unwrap().is_none(),
        expect_terminate_can_be_ignored()
    );
    kill_hard(&tree).unwrap();
    assert!(exits_within(&mut tree, Duration::from_secs(2)));
}

#[test]
fn is_alive_is_false_for_pid_zero_and_true_for_this_process() {
    assert!(!is_alive(Pid::from_raw(0)));
    assert!(is_alive(Pid::from_raw(std::process::id())));
}

#[test]
fn current_user_is_stable() {
    let user = current_user().unwrap();
    assert_eq!(user, current_user().unwrap());
    expect_user_id(user.as_str());
}

#[test]
fn home_is_dot_codesense() {
    let home = std::env::var_os(expect_home_variable()).expect("the home variable is set");
    assert_eq!(
        codesense_home().unwrap(),
        PathBuf::from(home).join(".codesense")
    );
}

#[test]
fn set_owner_only_denies_others() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("secret");
    std::fs::write(&file, "secret").unwrap();
    let private = dir.path().join("private");
    std::fs::create_dir(&private).unwrap();
    let owner_only = |path: &Path| {
        let opened = open_nofollow(OpenOptions::new().read(true), path).unwrap();
        is_owner_only(&opened).unwrap()
    };
    let owned = |path: &Path| {
        let opened = open_nofollow(OpenOptions::new().read(true), path).unwrap();
        is_owned_by_current_user(&opened).unwrap()
    };
    for path in [&file, &private] {
        assert_eq!(owned(path), expect_owned(), "{}", path.display());
        assert!(!owner_only(path), "shared before: {}", path.display());
        set_owner_only(path).unwrap();
        assert_eq!(owned(path), expect_owned(), "{}", path.display());
        assert!(owner_only(path), "{}", path.display());
        expect_owner_only_mode(path);
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "secret");
}

#[test]
fn a_path_the_os_owns_is_neither_owned_nor_owner_only() {
    let Some(path) = expect_foreign_owned_path() else {
        return;
    };
    let opened = open_nofollow(OpenOptions::new().read(true), &path).unwrap();
    assert!(
        !is_owned_by_current_user(&opened).unwrap(),
        "{}",
        path.display()
    );
    assert!(!is_owner_only(&opened).unwrap(), "{}", path.display());
}

#[test]
fn a_file_this_user_makes_is_theirs_and_an_owner_only_create_is_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let opened = |path: &Path| open_nofollow(OpenOptions::new().read(true), path).unwrap();
    let shared = dir.path().join("shared");
    std::fs::write(&shared, "shared").unwrap();
    assert_eq!(
        is_owned_by_current_user(&opened(&shared)).unwrap(),
        expect_owned()
    );
    assert_eq!(
        is_owned_by_current_user(&opened(dir.path())).unwrap(),
        expect_owned()
    );

    let private = dir.path().join("private");
    let file = create_owner_only(&private, Open::Follow).unwrap();
    assert_eq!(is_owned_by_current_user(&file).unwrap(), expect_owned());
    assert!(is_owner_only(&file).unwrap());
    assert!(is_owner_only(&opened(&private)).unwrap());
    expect_owner_only_mode(&private);

    let new = dir.path().join("new");
    let file = create_new_owner_only(&new).unwrap();
    assert!(is_owner_only(&file).unwrap());
    assert!(is_owner_only(&opened(&new)).unwrap());
    expect_owner_only_mode(&new);
}

#[test]
fn create_owner_only_keeps_an_existing_files_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing");
    std::fs::write(&path, "kept").unwrap();
    for open in [Open::Follow, Open::NoFollow] {
        let mut file = create_owner_only(&path, open).unwrap();
        let mut held = String::new();
        file.read_to_string(&mut held).unwrap();
        assert_eq!(held, "kept", "{open:?}");
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "kept");
}

#[test]
fn create_owner_only_with_no_follow_refuses_a_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, "target").unwrap();
    let link = dir.path().join("link");
    if !symlink_or_skip(&target, &link) {
        return;
    }
    assert!(create_owner_only(&link, Open::NoFollow).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "target");
}

#[test]
fn create_new_owner_only_refuses_an_existing_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("once");
    create_new_owner_only(&path)
        .unwrap()
        .write_all(b"first")
        .unwrap();
    let again = create_new_owner_only(&path).unwrap_err();
    assert_eq!(again.kind(), ErrorKind::AlreadyExists, "{again}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
}

#[test]
fn file_id_is_stable_and_changes_when_the_file_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    std::fs::write(&path, "old").unwrap();
    let id = file_id(&path).unwrap();
    assert_eq!(id, file_id(&path).unwrap());
    assert_eq!(id, file_id_of(&File::open(&path).unwrap()).unwrap());
    atomic_replace(&path, b"new").unwrap();
    assert_ne!(id, file_id(&path).unwrap());
}

/// The old directory is moved aside rather than deleted before the new one
/// is made, so a file system that reuses a freed inode cannot hand the new
/// one the same number: the identity follows the directory, not the path.
#[test]
fn file_id_of_a_directory_changes_when_it_is_removed_and_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dir");
    std::fs::create_dir(&path).unwrap();
    let id = file_id(&path).unwrap();
    assert_eq!(id, file_id(&path).unwrap());
    let aside = dir.path().join("aside");
    // Renamed, not deleted: a deleted directory's inode may be reused at once.
    std::fs::rename(&path, &aside).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_ne!(id, file_id(&path).unwrap());
    assert_eq!(id, file_id(&aside).unwrap());
}

#[test]
fn file_id_of_a_link_is_the_links_own() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::create_dir(&target).unwrap();
    let link = dir.path().join("link");
    if !symlink_or_skip(&target, &link) {
        return;
    }
    let id = file_id(&link).unwrap();
    assert_eq!(id, file_id(&link).unwrap());
    assert_ne!(id, file_id(&target).unwrap());
}

#[test]
fn set_owner_only_refuses_a_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, "x").unwrap();
    let link = dir.path().join("link");
    if link_or_copy(&target, &link).unwrap() == Linked::Symlink {
        assert!(set_owner_only(&link).is_err());
    }
}

#[test]
fn atomic_replace_under_open_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.txt");
    atomic_replace(&path, b"old").unwrap();
    let mut reader = open_nofollow(OpenOptions::new().read(true), &path).unwrap();
    atomic_replace(&path, b"new").unwrap();
    let mut held = String::new();
    reader.read_to_string(&mut held).unwrap();
    assert_eq!(held, "old", "the open reader keeps the old bytes");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    assert_eq!(temp_siblings(dir.path()), 0);
}

#[test]
fn atomic_replace_reports_busy_for_foreign_handle() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.txt");
    std::fs::write(&path, "old").unwrap();
    let foreign = expect_foreign_handle(&path);
    let result = atomic_replace(&path, b"new");
    expect_replace_past_foreign_handle(result, &path);
    drop(foreign);
    assert_eq!(temp_siblings(dir.path()), 0, "never a partial file left");
}

#[test]
fn lock_exclusive_blocks_second_holder() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    let open = || {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .unwrap()
    };
    let first = open();
    lock_exclusive(&first).unwrap();
    let second = open();
    assert!(!try_lock_exclusive(&second).unwrap(), "a second handle");
    assert_eq!(lock_in_another_process(&path), "busy");
    drop(first);
    assert!(try_lock_exclusive(&second).unwrap(), "released on drop");
    drop(second);
    assert_eq!(lock_in_another_process(&path), "locked");
}

fn lock_in_another_process(path: &Path) -> String {
    let output = fixture(&["try-lock", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn open_nofollow_refuses_links() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, "bytes").unwrap();
    let link = dir.path().join("link");
    let linked = link_or_copy(&target, &link).unwrap();
    assert!(open_nofollow(OpenOptions::new().read(true), &target).is_ok());
    let through_link = open_nofollow(OpenOptions::new().read(true), &link);
    assert_eq!(
        through_link.is_err(),
        linked == Linked::Symlink,
        "{linked:?}: {through_link:?}"
    );
}

#[test]
fn open_nofollow_refuses_a_directory_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::create_dir(&target).unwrap();
    let link = dir.path().join("link");
    if !symlink_or_skip(&target, &link) {
        return;
    }
    assert!(open_nofollow(OpenOptions::new().read(true), &target).is_ok());
    assert!(open_nofollow(OpenOptions::new().read(true), &link).is_err());
}

#[test]
fn link_or_copy_takes_a_relative_target_from_the_link() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("target"), "beside the link").unwrap();
    let link = dir.path().join("link");
    link_or_copy(Path::new("target"), &link).unwrap();
    assert_eq!(std::fs::read(&link).unwrap(), b"beside the link");
}

#[test]
fn link_or_copy_yields_same_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, "same bytes").unwrap();
    let link = dir.path().join("link");
    expect_linked(link_or_copy(&target, &link).unwrap());
    assert_eq!(std::fs::read(&link).unwrap(), b"same bytes");
}

#[test]
fn canonicalize_has_no_verbatim_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "a").unwrap();
    let canonical = canonicalize(&file).unwrap();
    assert!(canonical.is_absolute());
    assert!(
        !canonical.to_string_lossy().starts_with(r"\\?\"),
        "{}",
        canonical.display()
    );
    assert_eq!(std::fs::read_to_string(&canonical).unwrap(), "a");
    expect_canonical(&file, &canonical);
}

#[test]
fn canonicalize_keeps_a_unc_path_unc() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "a").unwrap();
    let Some(unc) = expect_unc_form(&file) else {
        return;
    };
    let canonical = canonicalize(&unc).unwrap();
    let text = canonical.to_string_lossy();
    assert!(
        text.starts_with(r"\\") && !text.starts_with(r"\\?\"),
        "{text}"
    );
    assert_eq!(std::fs::read_to_string(&canonical).unwrap(), "a");
}

#[test]
fn portable_name_table() {
    for name in [
        "a:b", "a/b", "a\\b", "a*b", "a?b", "a|b", "a\"b", "a<b", "a>b",
    ] {
        assert!(
            matches!(portable_name(name), Err(NonPortableName::Char(_))),
            "{name}"
        );
    }
    for name in [
        "CON",
        "con",
        "con.txt",
        "NUL",
        "nul.tar.gz",
        "COM1",
        "LPT9",
        "AUX",
        "PRN",
    ] {
        assert_eq!(
            portable_name(name),
            Err(NonPortableName::Reserved),
            "{name}"
        );
    }
    for name in ["trailing.", "trailing ", ".", ".."] {
        assert_eq!(
            portable_name(name),
            Err(NonPortableName::TrailingDotOrSpace),
            "{name}"
        );
    }
    assert_eq!(portable_name(""), Err(NonPortableName::Empty));
    assert_eq!(portable_name("tab\there"), Err(NonPortableName::Char('\t')));
    for name in [
        "console",
        "CON1",
        "COM10",
        "notes.md",
        ".env",
        "LPT",
        "a b.txt",
        "naïve.md",
    ] {
        assert_eq!(portable_name(name), Ok(()), "{name}");
    }
}

/// How many `.tmp.` siblings an atomic write left in `dir`.
fn temp_siblings(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
        .count()
}

// Per-OS expectations.

/// Unix: SIGTERM is a request a process may ignore. Windows: terminate ends
/// the job outright.
fn expect_terminate_can_be_ignored() -> bool {
    cfg!(unix)
}

/// Unix: the effective uid. Windows: a SID string.
fn expect_user_id(id: &str) {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        assert_eq!(id, unsafe { libc::geteuid() }.to_string());
    }
    #[cfg(windows)]
    {
        assert!(id.starts_with("S-1-5-"), "{id}");
    }
}

/// The variable naming the user's home directory.
fn expect_home_variable() -> &'static str {
    if cfg!(windows) {
        "USERPROFILE"
    } else {
        "HOME"
    }
}

/// A directory that exists and that another account owns. Unix: `/`, owned
/// by root; `None` (and the test skips) when this process runs as root.
/// Windows: the system root (`C:\Windows`), owned by TrustedInstaller, so
/// not by the user or an elevated token's Administrators.
fn expect_foreign_owned_path() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: running as root, which owns /");
            return None;
        }
        Some(PathBuf::from("/"))
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        Some(PathBuf::from(root))
    }
}

/// Whether a file this process made counts as owned by it. Unix: its uid is
/// the effective uid. Windows: its owner is the token's user or its default
/// owner, which for an elevated job (as CI may run) is
/// `BUILTIN\Administrators`, so either way it is.
fn expect_owned() -> bool {
    true
}

/// Unix: exactly 0600 for a file and 0700 for a directory. Windows: the
/// owner-only ACL, already checked by `is_owner_only`.
fn expect_owner_only_mode(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let wanted = if path.is_dir() { 0o700 } else { 0o600 };
        assert_eq!(mode, wanted, "{}", path.display());
    }
    #[cfg(windows)]
    let _ = path;
}

/// A handle another process might hold. Windows: shared for reading only,
/// without `FILE_SHARE_DELETE`. Unix: any open.
fn expect_foreign_handle(path: &Path) -> std::fs::File {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
    }
    options.open(path).unwrap()
}

/// Unix: an open file never blocks a rename. Windows: a typed `Busy` after
/// the bounded retry, and the old bytes untouched.
fn expect_replace_past_foreign_handle(
    result: Result<(), codesense_platform::fs::ReplaceError>,
    path: &Path,
) {
    if cfg!(windows) {
        assert!(
            matches!(result, Err(codesense_platform::fs::ReplaceError::Busy)),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "old");
    } else {
        result.unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "new");
    }
}

/// Unix: always a symlink. Windows: a symlink, or a copy where the account
/// may not create one.
fn expect_linked(linked: Linked) {
    if cfg!(unix) {
        assert_eq!(linked, Linked::Symlink);
    }
}

/// The UNC form of the local `path` (`\\localhost\C$\…`), where this host
/// serves its administrative share; `None` (and the test skips) elsewhere.
/// Unix has no UNC paths.
fn expect_unc_form(path: &Path) -> Option<PathBuf> {
    if cfg!(unix) {
        return None;
    }
    let text = path.to_str()?;
    let (drive, rest) = text.split_once(':')?;
    let unc = PathBuf::from(format!(r"\\localhost\{drive}${rest}"));
    if unc.exists() {
        Some(unc)
    } else {
        eprintln!("skipped: {} is not reachable", unc.display());
        None
    }
}

/// Unix: exactly `std::fs::canonicalize`. Windows: the same file without the
/// verbatim prefix, checked by the caller.
fn expect_canonical(path: &Path, canonical: &Path) {
    if cfg!(unix) {
        assert_eq!(canonical, std::fs::canonicalize(path).unwrap());
    }
}
