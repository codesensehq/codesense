// SPDX-License-Identifier: MIT
//! The platform contract: the same tests on every OS. Test bodies hold no
//! `cfg`; what differs per OS is stated once, in an `expect_*` helper at the
//! end. Process tests drive the `platform-fixture` binary, never a shell;
//! it is the client of the IPC rows.

use std::cell::Cell;
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime};

use codesense_platform::cli::{candidates, named_in, package_dirs, search_path};
use codesense_platform::dirs::{codesense_home, lock_dir};
use codesense_platform::fs::{
    atomic_replace, can_execute, canonicalize, change_stamp, create_dir_new_owner_only,
    create_dir_owner_only, create_new_owner_only, create_owner_only, file_id, file_id_of,
    is_executable, is_owned_by_current_user, is_owner_only, is_text_busy, is_world_writable,
    link_count, link_or_copy, lock_exclusive, open_nofollow, open_nofollow_nonblocking,
    portable_name, set_executable, set_owner_only, try_lock_exclusive, try_lock_shared, unlock,
    Linked, NonPortableName, Open, Reach,
};
use codesense_platform::ipc::{blocking, Endpoint, LocalListener, LocalStream};
use codesense_platform::limits::is_descriptor_exhaustion;
use codesense_platform::process::{
    exited_unreaped, group_and_foreground, is_alive, kill_hard, terminate, terminate_pid,
    ExitWaiter, Identity, Pid, ProcessGroup, ProcessTree,
};
use codesense_platform::testutil::{
    fifo_or_skip, make_group_writable, make_world_writable, pathext, relative_from_cwd,
    symlink_or_skip, Anyone,
};
use codesense_platform::user::{current_user, hostname, login_shell};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

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
fn an_exit_waiter_times_out_while_its_process_runs_and_sees_it_exit() {
    let mut tree = ProcessTree::spawn(fixture(&["exit", "0"]).stdin(Stdio::piped())).unwrap();
    let waiter = match ExitWaiter::open(tree.pid()) {
        Ok(waiter) => waiter,
        Err(error) => {
            assert!(!expect_exit_waiter(), "{error}");
            assert_eq!(error.kind(), ErrorKind::Unsupported, "{error}");
            return;
        }
    };
    assert!(expect_exit_waiter());
    assert!(
        !waiter.wait(Duration::from_millis(200)).unwrap(),
        "the process still runs"
    );
    // The fixture exits once its stdin ends.
    drop(tree.child().stdin.take());
    assert!(waiter.wait(Duration::from_secs(10)).unwrap(), "its exit");
    assert!(tree.wait().unwrap().success());
    assert!(
        waiter.wait(Duration::from_millis(1)).unwrap(),
        "the exit still reads once the process is reaped"
    );
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
fn a_hidden_tree_has_no_console_window() {
    let mut tree = ProcessTree::spawn_hidden(&mut fixture(&["console"])).unwrap();
    assert_eq!(first_line(&mut tree), "no console window");
    assert!(tree.wait().unwrap().success());
}

#[test]
fn a_hidden_tree_is_killed_as_a_whole() {
    let mut tree = ProcessTree::spawn_hidden(&mut fixture(&["tree"])).unwrap();
    let grandchild = Pid::from_raw(first_line(&mut tree).parse().unwrap());
    assert!(is_alive(grandchild));
    kill_hard(&tree).unwrap();
    assert!(eventually(Duration::from_secs(5), || !is_alive(grandchild)));
    assert!(exits_within(&mut tree, Duration::from_secs(5)));
}

/// The group of `tree`'s root: one it leads (unix) or a job it is assigned to
/// (Windows), which holds what the root starts from then on.
fn adopt_tree_group(tree: &ProcessTree) -> ProcessGroup {
    ProcessGroup::adopt(tree.pid())
        .unwrap()
        .expect("a group other than the test's own")
}

/// A fixture tree whose group is adopted before its grandchild starts.
fn spawn_adopted_tree() -> (ProcessTree, ProcessGroup, Pid) {
    let mut command = fixture(&["tree-on-input"]);
    command.stdin(Stdio::piped());
    let mut tree = ProcessTree::spawn(&mut command).unwrap();
    let group = adopt_tree_group(&tree);
    let mut stdin = tree.child().stdin.take().expect("piped stdin");
    writeln!(stdin, "go").unwrap();
    let grandchild = Pid::from_raw(first_line(&mut tree).parse().unwrap());
    assert!(is_alive(grandchild));
    (tree, group, grandchild)
}

#[test]
fn an_adopted_group_is_killed_as_a_whole() {
    let (mut tree, group, grandchild) = spawn_adopted_tree();
    group.kill().unwrap();
    assert!(
        eventually(Duration::from_secs(5), || !is_alive(grandchild)),
        "the grandchild outlived the group kill"
    );
    assert!(exits_within(&mut tree, Duration::from_secs(5)));
    group.kill().unwrap();
    group.terminate().unwrap();
}

#[test]
fn an_adopted_group_is_asked_to_stop() {
    let mut tree = ProcessTree::spawn(&mut fixture(&["ignore-terminate"])).unwrap();
    assert_eq!(first_line(&mut tree), "ready");
    let group = adopt_tree_group(&tree);
    group.terminate().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        tree.try_wait().unwrap().is_none(),
        expect_terminate_can_be_ignored()
    );
    group.kill().unwrap();
    assert!(exits_within(&mut tree, Duration::from_secs(2)));
}

#[test]
fn dropping_an_adopted_group_sends_nothing() {
    let (mut tree, group, grandchild) = spawn_adopted_tree();
    // The leader alone, reaped directly: `tree.wait()` would end the group.
    tree.child().kill().unwrap();
    tree.child().wait().unwrap();
    drop(group);
    std::thread::sleep(Duration::from_millis(300));
    assert!(is_alive(grandchild), "dropping the group signalled it");
}

#[test]
fn adopting_a_child_in_this_process_group() {
    let mut child = fixture(&["sleep"]).spawn().unwrap();
    let pid = Pid::from_raw(child.id());
    let group = ProcessGroup::adopt(pid).unwrap();
    assert_eq!(group.is_some(), expect_own_group_adopted());
    drop(group);
    std::thread::sleep(Duration::from_millis(100));
    assert!(is_alive(pid), "dropping the group signalled it");
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn terminate_pid_stops_one_process_not_its_tree() {
    let (mut tree, grandchild) = spawn_tree();
    terminate_pid(tree.pid()).unwrap();
    // The root directly: the tree's own wait would end the rest.
    let root_exited = || tree.child().try_wait().unwrap().is_some();
    assert!(eventually(Duration::from_secs(5), root_exited));
    std::thread::sleep(Duration::from_millis(300));
    assert!(is_alive(grandchild), "the grandchild was stopped too");
    assert!(terminate_pid(Pid::from_raw(0)).is_err());
}

#[test]
fn an_exit_is_seen_without_reaping() {
    let mut child = fixture(&["sleep"]).spawn().unwrap();
    assert!(!exited_unreaped(&child).unwrap());
    child.kill().unwrap();
    let exited = || exited_unreaped(&child).unwrap();
    assert!(eventually(Duration::from_secs(5), exited));
    assert!(exited_unreaped(&child).unwrap(), "still unreaped");
    child.wait().expect("still waitable");
}

#[test]
fn group_and_foreground_reads_a_group_leader() {
    let (tree, _) = spawn_tree();
    expect_group_of_leader(group_and_foreground(tree.pid()), tree.pid());
}

#[test]
fn can_execute_only_a_file_this_process_may_run() {
    let dir = same_volume_tempdir();
    let tool = executable(dir.path(), &expect_executable_name("tool"));
    assert!(can_execute(&tool), "{}", tool.display());
    let plain = dir.path().join("plain");
    std::fs::write(&plain, "x").unwrap();
    assert!(!can_execute(&plain), "a file this OS would not run");
    let directory = dir.path().join(expect_executable_name("named"));
    std::fs::create_dir(&directory).unwrap();
    assert!(!can_execute(&directory), "a directory");
    assert!(!can_execute(
        &dir.path().join(expect_executable_name("missing"))
    ));
}

#[test]
fn descriptor_exhaustion_is_found_in_a_chain_and_a_message() {
    let code = expect_too_many_open_files();
    let exhausted = || std::io::Error::from_raw_os_error(code);
    assert!(is_descriptor_exhaustion(&exhausted()));
    let message = std::io::Error::other(format!(
        "failed to openpty: Os {{ code: {code}, kind: Uncategorized, message: \"Too many open files\" }}"
    ));
    assert!(is_descriptor_exhaustion(&message));
    assert!(is_descriptor_exhaustion(&Wrapped(exhausted())));
    let other = std::io::Error::from(std::io::ErrorKind::NotFound);
    assert!(!is_descriptor_exhaustion(&other));
    assert!(!is_descriptor_exhaustion(&Wrapped(other)));
}

/// An error that names its cause only through `source()`.
#[derive(Debug)]
struct Wrapped(std::io::Error);

impl std::fmt::Display for Wrapped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("failed to dup the pty")
    }
}

impl std::error::Error for Wrapped {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

#[test]
fn is_alive_is_false_for_pid_zero_and_true_for_this_process() {
    assert!(!is_alive(Pid::from_raw(0)));
    assert!(is_alive(Pid::from_raw(std::process::id())));
}

#[test]
fn is_alive_is_true_for_a_process_this_user_cannot_signal() {
    assert!(is_alive(expect_unsignallable_pid()));
}

fn me() -> Identity {
    Identity::inspect(std::process::id()).expect("this process reads")
}

/// A fixture child that sleeps, and its identity.
fn sleeper() -> (std::process::Child, Identity) {
    let child = fixture(&["sleep"]).spawn().unwrap();
    let identity = Identity::inspect(child.id()).expect("the child reads");
    (child, identity)
}

#[test]
fn identity_of_this_process_runs_and_is_itself() {
    let me = me();
    assert_eq!(me.pid, std::process::id());
    assert!(me.runs());
    assert!(me.is(me));
    assert!(!me.retired());
    assert!(me.descends_from(me));
}

#[test]
fn identity_of_the_parent_started_first_and_holds_this_process() {
    let me = me();
    let parent = Identity::inspect(me.parent).expect("the test runner reads");
    assert!(parent.runs());
    assert!(me.descends_from(parent));
    assert!(!parent.descends_from(me));
    assert!(parent.start <= me.start);
}

#[test]
fn a_child_descends_from_this_process_and_an_unrelated_one_does_not() {
    let (mut child, identity) = sleeper();
    let (mut other, unrelated) = sleeper();
    assert_eq!(identity.parent, std::process::id());
    assert!(identity.descends_from(me()));
    assert!(!identity.descends_from(unrelated));
    assert!(!me().descends_from(identity));
    for child in [&mut child, &mut other] {
        child.kill().unwrap();
        child.wait().unwrap();
    }
}

#[test]
fn a_grandchild_descends_from_this_process() {
    let (tree, grandchild) = spawn_tree();
    let grandchild = Identity::inspect(grandchild.as_raw()).expect("the grandchild reads");
    let child = Identity::inspect(tree.pid().as_raw()).expect("the child reads");
    assert!(grandchild.descends_from(child));
    assert!(grandchild.descends_from(me()));
}

#[test]
fn started_after_orders_a_start_against_wall_time() {
    let before = SystemTime::now() - Duration::from_secs(5);
    let (mut child, identity) = sleeper();
    let later = SystemTime::now() + Duration::from_secs(60);
    assert!(identity.started_after(before));
    assert!(!identity.started_after(later));
    assert!(me().started_after(SystemTime::UNIX_EPOCH));
    assert!(!me().started_after(later));
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn an_exited_child_with_no_handle_left_is_retired() {
    let (mut child, identity) = sleeper();
    child.kill().unwrap();
    child.wait().unwrap();
    drop(child);
    assert!(!identity.runs());
    assert!(identity.retired());
}

#[test]
fn an_exited_child_whose_handle_is_open_no_longer_runs() {
    let (mut child, identity) = sleeper();
    child.kill().unwrap();
    assert!(
        eventually(Duration::from_secs(5), || Identity::inspect(identity.pid)
            .is_none()),
        "an exited child still reads"
    );
    assert!(!identity.runs());
    assert_eq!(identity.retired(), expect_retired_while_unreaped());
    child.wait().unwrap();
}

#[test]
fn a_child_that_exits_with_the_still_active_code_no_longer_runs() {
    let mut child = fixture(&["exit", "259"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let identity = Identity::inspect(child.id()).expect("the child reads");
    assert!(identity.runs());
    child.stdin.take().unwrap().write_all(b"exit\n").unwrap();
    assert!(
        eventually(Duration::from_secs(5), || Identity::inspect(identity.pid)
            .is_none()),
        "an exited child still reads"
    );
    assert!(!identity.runs());
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(expect_exit_code(259)));
    assert!(!is_alive(Pid::from_raw(identity.pid)));
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
fn hostname_is_a_stable_name() {
    let name = hostname().expect("a host name");
    assert!(!name.is_empty());
    assert!(!name.contains('\0'), "{name:?}");
    assert_eq!(hostname(), Some(name));
}

#[test]
fn lock_dir_ignores_the_temp_variables() {
    let dir = lock_dir().expect("a lock directory");
    expect_lock_dir(&dir);
    let elsewhere = tempfile::tempdir().unwrap();
    let mut command = fixture(&["lock-dir"]);
    for variable in ["TMP", "TEMP", "TMPDIR"] {
        command.env(variable, elsewhere.path());
    }
    let output = command.output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let theirs = String::from_utf8(output.stdout).unwrap();
    assert_eq!(Path::new(theirs.trim_end()), dir);
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
fn create_dir_owner_only_makes_every_missing_directory_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    let leaf = parent.join("leaf");
    create_dir_owner_only(&leaf).unwrap();
    for path in [&parent, &leaf] {
        let opened = open_nofollow(OpenOptions::new().read(true), path).unwrap();
        assert!(is_owner_only(&opened).unwrap(), "{}", path.display());
        expect_owner_only_mode(path);
    }
    let inner_file = leaf.join("file");
    std::fs::write(&inner_file, "x").unwrap();
    let inner_dir = leaf.join("dir");
    std::fs::create_dir(&inner_dir).unwrap();
    expect_inherits_owner_only(&inner_file);
    expect_inherits_owner_only(&inner_dir);
    create_dir_owner_only(&leaf).unwrap();
    let file = dir.path().join("file");
    std::fs::write(&file, "x").unwrap();
    assert!(
        create_dir_owner_only(&file).is_err(),
        "a file is in the way"
    );
    assert!(create_dir_owner_only(&file.join("below")).is_err());
}

#[test]
fn create_dir_new_owner_only_makes_exactly_one_new_directory() {
    let dir = tempfile::tempdir().unwrap();
    let new = dir.path().join("new");
    create_dir_new_owner_only(&new).unwrap();
    let opened = open_nofollow(OpenOptions::new().read(true), &new).unwrap();
    assert!(is_owner_only(&opened).unwrap());
    expect_owner_only_mode(&new);
    assert_eq!(
        create_dir_new_owner_only(&new).unwrap_err().kind(),
        ErrorKind::AlreadyExists
    );
    let missing = dir.path().join("missing");
    assert!(create_dir_new_owner_only(&missing.join("leaf")).is_err());
    assert!(!missing.exists(), "never a parent");
}

#[test]
fn set_executable_makes_a_file_this_os_runs() {
    let dir = tempfile::tempdir().unwrap();
    for (stem, reach) in [("owner", Reach::Owner), ("everyone", Reach::Everyone)] {
        let path = dir.path().join(expect_executable_name(stem));
        std::fs::write(&path, "x").unwrap();
        set_executable(&path, reach).unwrap();
        assert!(is_executable(&path), "{}", path.display());
        expect_executable_mode(&path, reach);
    }
}

#[test]
fn is_text_busy_is_only_a_busy_file() {
    assert!(is_text_busy(&expect_text_busy_error()));
    assert!(!is_text_busy(&std::io::Error::from(ErrorKind::NotFound)));
    assert!(!is_text_busy(&std::io::Error::other("busy")));
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
fn create_new_owner_only_refuses_a_dangling_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("missing");
    let link = dir.path().join("link");
    if !symlink_or_skip(&target, &link) {
        return;
    }
    let refused = create_new_owner_only(&link).unwrap_err();
    assert_eq!(refused.kind(), ErrorKind::AlreadyExists, "{refused}");
    assert!(!target.exists(), "the link's target was created");
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
    let open = || open_lock_file(&path);
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

#[test]
fn shared_locks_coexist_and_hold_off_an_exclusive_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    let (first, second, third) = (
        open_lock_file(&path),
        open_lock_file(&path),
        open_lock_file(&path),
    );
    assert!(try_lock_shared(&first).unwrap());
    assert!(try_lock_shared(&second).unwrap(), "a second shared holder");
    assert!(!try_lock_exclusive(&third).unwrap(), "both hold it");
    assert_eq!(lock_in_another_process(&path), "busy");
    unlock(&first).unwrap();
    assert!(!try_lock_exclusive(&third).unwrap(), "one still holds it");
    unlock(&second).unwrap();
    assert!(try_lock_exclusive(&third).unwrap(), "both released");
    assert!(!try_lock_shared(&first).unwrap(), "an exclusive holder");
    unlock(&third).unwrap();
    assert!(try_lock_shared(&first).unwrap(), "released");
}

/// Open the lock file at `path`, creating it.
fn open_lock_file(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap()
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

/// How long an IPC row waits for a connection before it fails.
const CONNECT_LIMIT: Duration = Duration::from_secs(10);

/// The fixture as a client of `endpoint`, reached through its wire form.
fn ipc_fixture(mode: &str, endpoint: &Endpoint, rest: &[&str]) -> ProcessTree {
    let mut command = fixture(&[mode]);
    command.arg(endpoint.to_wire().unwrap()).args(rest);
    ProcessTree::spawn(&mut command).unwrap()
}

/// An endpoint of this test's own: in `dir` on unix, and named after `dir`,
/// which is unique, so unique on Windows too.
fn ephemeral(dir: &Path, tag: &str) -> Endpoint {
    let unique = dir.file_name().unwrap().to_str().unwrap();
    Endpoint::Ephemeral {
        dir: dir.to_owned(),
        name: format!("{tag}{unique}"),
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

async fn accept_within(listener: &mut LocalListener) -> LocalStream {
    tokio::time::timeout(CONNECT_LIMIT, listener.accept())
        .await
        .expect("a client connects")
        .unwrap()
}

/// The blocking listener's next connection, failing the test rather than
/// hanging when none comes.
fn accept_blocking_within(
    mut listener: blocking::LocalListener,
) -> (blocking::LocalListener, blocking::LocalStream) {
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || {
        let stream = listener.accept();
        let _ = sent.send((listener, stream));
    });
    let (listener, stream) = received
        .recv_timeout(CONNECT_LIMIT)
        .expect("a client connects");
    (listener, stream.unwrap())
}

/// [`exits_within`] five seconds, letting the runtime run meanwhile: on
/// Windows a dropped async stream closes when the runtime next polls.
async fn exits_soon(tree: &mut ProcessTree) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if tree.try_wait().unwrap().is_some() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

fn assert_in_use<T>(bound: std::io::Result<T>) {
    let error = bound.err().expect("bound over a live listener");
    assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse, "{error}");
}

/// Each fixture `send`s to its own endpoint; each listener hears only its
/// own client.
fn assert_kept_apart(endpoints: [Endpoint; 2]) {
    runtime().block_on(async {
        let mut listeners = endpoints
            .each_ref()
            .map(|endpoint| LocalListener::bind(endpoint).unwrap());
        let mut clients: Vec<_> = endpoints
            .iter()
            .enumerate()
            .map(|(i, endpoint)| ipc_fixture("send", endpoint, &[&format!("client-{i}")]))
            .collect();
        for (i, listener) in listeners.iter_mut().enumerate() {
            let stream = accept_within(listener).await;
            let mut line = String::new();
            tokio::io::BufReader::new(stream)
                .read_line(&mut line)
                .await
                .unwrap();
            assert_eq!(line.trim(), format!("client-{i}"), "{:?}", endpoints[i]);
        }
        for client in &mut clients {
            assert!(exits_soon(client).await);
        }
    });
}

#[test]
fn endpoint_echoes_one_mebibyte() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = ephemeral(dir.path(), "echo");
    let echoed = runtime().block_on(async {
        let mut listener = LocalListener::bind(&endpoint).unwrap();
        let mut client = ipc_fixture("echo", &endpoint, &[]);
        let mut stream = accept_within(&mut listener).await;
        let mut buffer = vec![0; 64 * 1024];
        let mut echoed = 0;
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            stream.write_all(&buffer[..read]).await.unwrap();
            echoed += read;
        }
        assert_eq!(first_line(&mut client), "ok", "every byte back in order");
        assert!(client.wait().unwrap().success());
        echoed
    });
    assert_eq!(echoed, 1 << 20);
}

#[test]
fn two_endpoints_do_not_cross() {
    let root = tempfile::tempdir().unwrap();
    assert_kept_apart([
        Endpoint::Activity(root.path().to_owned()),
        Endpoint::SessionServer(root.path().to_owned()),
    ]);
}

#[test]
fn two_roots_do_not_cross() {
    let (first, second) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    assert_kept_apart([
        Endpoint::Activity(first.path().to_owned()),
        Endpoint::Activity(second.path().to_owned()),
    ]);
}

#[test]
fn wire_form_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    for endpoint in [
        Endpoint::Mcp,
        Endpoint::Activity(dir.path().to_owned()),
        Endpoint::SessionServer(dir.path().to_owned()),
        ephemeral(dir.path(), "wire"),
    ] {
        let wire = endpoint.to_wire().unwrap();
        let back = Endpoint::from_wire(&wire).unwrap();
        assert_eq!(back.address().unwrap(), endpoint.address().unwrap());
        assert_eq!(back.to_wire().unwrap(), wire, "{endpoint:?}");
    }

    // A client given only the wire form reaches the listener.
    let endpoint = Endpoint::SessionServer(dir.path().to_owned());
    let listener = blocking::LocalListener::bind(&endpoint).unwrap();
    let mut client = ipc_fixture("send", &endpoint, &["by wire"]);
    let (_listener, stream) = accept_blocking_within(listener);
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "by wire");
    assert!(exits_within(&mut client, Duration::from_secs(5)));
}

#[test]
fn peer_pid_is_the_client() {
    let dir = tempfile::tempdir().unwrap();
    let this_process = Pid::from_raw(std::process::id());

    let endpoint = ephemeral(dir.path(), "peer");
    let listener = blocking::LocalListener::bind(&endpoint).unwrap();
    let mut client = ipc_fixture("peer", &endpoint, &[]);
    let (_listener, stream) = accept_blocking_within(listener);
    assert_eq!(stream.peer_pid().unwrap(), client.pid());
    assert_eq!(
        first_line(&mut client),
        this_process.to_string(),
        "the client sees the listener's process"
    );
    drop(stream);
    assert!(exits_within(&mut client, Duration::from_secs(5)));

    runtime().block_on(async {
        let endpoint = ephemeral(dir.path(), "peer-async");
        let mut listener = LocalListener::bind(&endpoint).unwrap();
        let mut client = ipc_fixture("peer", &endpoint, &[]);
        let accepted = accept_within(&mut listener).await;
        assert_eq!(accepted.peer_pid().unwrap(), client.pid());
        assert_eq!(first_line(&mut client), this_process.to_string());
        drop(accepted);
        assert!(exits_soon(&mut client).await);

        // The async client's end sees the listener's process.
        let connected = LocalStream::connect(&endpoint).await.unwrap();
        let _accepted = accept_within(&mut listener).await;
        assert_eq!(connected.peer_pid().unwrap(), this_process);
    });
}

#[test]
fn stale_endpoint_rebinds() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = ephemeral(dir.path(), "stale");

    let listener = blocking::LocalListener::bind(&endpoint).unwrap();
    assert_in_use(blocking::LocalListener::bind(&endpoint));
    runtime().block_on(async { assert_in_use(LocalListener::bind(&endpoint)) });
    drop(listener);
    drop(blocking::LocalListener::bind(&endpoint).unwrap());

    // A listener whose process dies without cleaning up.
    let mut owner = ipc_fixture("listen", &endpoint, &[]);
    assert_eq!(first_line(&mut owner), "ready");
    assert_in_use(blocking::LocalListener::bind(&endpoint));
    kill_hard(&owner).unwrap();
    assert!(exits_within(&mut owner, Duration::from_secs(5)));
    let rebinds = || blocking::LocalListener::bind(&endpoint).is_ok();
    assert!(eventually(Duration::from_secs(5), rebinds));
}

#[test]
fn is_executable_accepts_only_an_absolute_executable_file() {
    let dir = same_volume_tempdir();
    let name = expect_executable_name("tool");
    let tool = executable(dir.path(), &name);
    assert!(is_executable(&tool), "{}", tool.display());
    let plain = dir.path().join("plain");
    std::fs::write(&plain, "x").unwrap();
    assert!(!is_executable(&plain), "a file this OS would not run");
    let directory = dir.path().join(expect_executable_name("named"));
    std::fs::create_dir(&directory).unwrap();
    assert!(!is_executable(&directory), "a directory");
    let relative = relative_from_cwd(&tool);
    assert!(!is_executable(&relative), "{}", relative.display());
    assert!(!is_executable(
        &dir.path().join(expect_executable_name("missing"))
    ));
}

/// A temp dir under cargo's target directory, so it shares a volume with the
/// working directory and [`relative_from_cwd`] can reach it. The directory is
/// created first: an archived test run starts without it.
fn same_volume_tempdir() -> tempfile::TempDir {
    std::fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).unwrap();
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// The fixture installs of `tool`: every spelling an OS might run.
const TOOL_FILES: [&str; 3] = ["tool", "tool.cmd", "tool.exe"];

fn path_of(dirs: &[&Path]) -> OsString {
    std::env::join_paths(dirs).unwrap()
}

#[test]
fn cli_candidates_follow_pathext_order() {
    let tmp = same_volume_tempdir();
    let dir = |name: &str| tmp.path().join(name);
    for install in ["a", "b", "c"] {
        for file in TOOL_FILES {
            executable(&dir(install), file);
        }
    }
    // A file this OS would not run, and directories named like the tool.
    std::fs::create_dir(dir("decoy")).unwrap();
    std::fs::write(dir("decoy").join("tool"), "x").unwrap();
    for file in TOOL_FILES {
        std::fs::create_dir_all(dir("named").join(file)).unwrap();
    }
    let path = path_of(&[
        &dir("a"),
        Path::new(""),
        &relative_from_cwd(&dir("c")),
        &dir("decoy"),
        &dir("named"),
        &dir("b"),
    ]);
    let expected = [expect_installs(&dir("a")), expect_installs(&dir("b"))].concat();
    assert_eq!(candidates(&path, "tool"), expected);
    assert!(candidates(OsStr::new(""), "tool").is_empty());
    assert!(candidates(&path, "other").is_empty());
    let relative = path_of(&[&relative_from_cwd(&dir("c"))]);
    assert!(candidates(&relative, "tool").is_empty(), "{relative:?}");
}

#[test]
fn cli_candidates_dedupe_by_canonical_path() {
    let tmp = tempfile::tempdir().unwrap();
    let real = tmp.path().join("real");
    for file in TOOL_FILES {
        executable(&real, file);
    }
    // The same directory listed twice is one install.
    let twice = path_of(&[&real, &real]);
    assert_eq!(candidates(&twice, "tool"), expect_installs(&real));
    // A link and its target are one install; the first spelling is kept.
    let links = tmp.path().join("links");
    if !symlink_or_skip(&real, &links) {
        return;
    }
    let path = path_of(&[&links, &real]);
    assert_eq!(candidates(&path, "tool"), expect_installs(&links));
}

#[test]
fn cli_named_in_templates_any_name() {
    let dirs = [PathBuf::from("first"), PathBuf::from("second")];
    assert_eq!(named_in(&dirs, "zzagent"), expect_named(&dirs, "zzagent"));
    assert_eq!(
        named_in(&dirs, "zzagent.exe"),
        vec![dirs[0].join("zzagent.exe"), dirs[1].join("zzagent.exe")]
    );
    assert!(named_in(&[], "zzagent").is_empty());
}

#[test]
fn cli_package_dirs_per_os() {
    assert_eq!(package_dirs(), expect_package_dirs());
}

#[test]
fn cli_search_path_per_os() {
    let probed = Cell::new(false);
    let found = search_path(|| {
        probed.set(true);
        Some("from the probe".to_owned())
    });
    expect_search_path(found, probed.get());
}

/// An owner-only directory `home` under `dir`.
fn owner_only_dir(dir: &Path) -> PathBuf {
    let home = dir.join("home");
    std::fs::create_dir(&home).unwrap();
    set_owner_only(&home).unwrap();
    home
}

#[test]
fn is_world_writable_once_any_broad_group_may_write() {
    for anyone in [Anyone::Everyone, Anyone::Users, Anyone::AuthenticatedUsers] {
        let dir = tempfile::tempdir().unwrap();
        let home = owner_only_dir(dir.path());
        let opened = || open_nofollow(OpenOptions::new().read(true), &home).unwrap();
        assert!(
            !is_world_writable(&opened()).unwrap(),
            "{anyone:?}: owner-only"
        );
        make_world_writable(&home, anyone);
        assert!(
            is_world_writable(&opened()).unwrap(),
            "{anyone:?} may write"
        );
    }
}

#[test]
fn a_group_writable_directory_is_not_world_writable() {
    let dir = tempfile::tempdir().unwrap();
    let home = owner_only_dir(dir.path());
    make_group_writable(&home);
    let opened = open_nofollow(OpenOptions::new().read(true), &home).unwrap();
    assert!(!is_world_writable(&opened).unwrap());
}

#[test]
fn link_count_counts_every_hard_link() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    std::fs::write(&first, "bytes").unwrap();
    let opened = |path: &Path| open_nofollow(OpenOptions::new().read(true), path).unwrap();
    assert_eq!(link_count(&opened(&first)).unwrap(), 1);
    let second = dir.path().join("second");
    std::fs::hard_link(&first, &second).unwrap();
    assert_eq!(link_count(&opened(&first)).unwrap(), 2);
    assert_eq!(link_count(&opened(&second)).unwrap(), 2);
}

#[test]
fn open_nofollow_nonblocking_opens_a_file_and_refuses_a_link() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, "bytes").unwrap();
    let mut read = String::new();
    open_nofollow_nonblocking(OpenOptions::new().read(true), &target)
        .unwrap()
        .read_to_string(&mut read)
        .unwrap();
    assert_eq!(read, "bytes");
    let link = dir.path().join("link");
    if !symlink_or_skip(&target, &link) {
        return;
    }
    assert!(open_nofollow_nonblocking(OpenOptions::new().read(true), &link).is_err());
}

#[test]
fn open_nofollow_nonblocking_opens_a_fifo_without_waiting_for_a_writer() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("fifo");
    if !fifo_or_skip(&fifo) {
        return;
    }
    let (done, opened) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(open_nofollow_nonblocking(OpenOptions::new().read(true), &fifo).is_ok());
    });
    assert_eq!(opened.recv_timeout(Duration::from_secs(5)), Ok(true));
}

#[test]
fn change_stamp_sees_an_in_place_rewrite_that_keeps_length_and_mtime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("program");
    std::fs::write(&path, "old!").unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let stamp = change_stamp(&path).unwrap();
    // Past the file system's timestamp granularity.
    std::thread::sleep(Duration::from_millis(50));
    let mut file = OpenOptions::new().write(true).open(&path).unwrap();
    file.write_all(b"new!").unwrap();
    file.set_modified(modified).unwrap();
    drop(file);
    let metadata = std::fs::metadata(&path).unwrap();
    assert_eq!(
        (metadata.len(), metadata.modified().unwrap()),
        (4, modified)
    );
    assert_eq!(
        stamp != change_stamp(&path).unwrap(),
        expect_in_place_rewrite_changes_the_stamp()
    );
}

#[test]
fn change_stamp_holds_for_an_untouched_file_and_changes_when_it_is_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("program");
    std::fs::write(&path, "old").unwrap();
    let stamp = change_stamp(&path).unwrap();
    assert_eq!(stamp, change_stamp(&path).unwrap(), "untouched");
    atomic_replace(&path, b"new").unwrap();
    let rewritten = change_stamp(&path).unwrap();
    assert_ne!(stamp, rewritten, "rewritten");
    assert_eq!(rewritten, change_stamp(&path).unwrap(), "untouched since");
    assert!(change_stamp(&dir.path().join("missing")).is_err());
}

/// Write the file `name` in `dir` (made if missing) and make it executable.
fn executable(dir: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    set_executable(&path, Reach::Everyone).unwrap();
    path
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

/// Unix: the stamp holds the inode change time, which the write and the
/// restored mtime both move. Windows: it holds the last-write time, which
/// the restore puts back, so the same file id and time read as untouched.
fn expect_in_place_rewrite_changes_the_stamp() -> bool {
    cfg!(unix)
}

/// Windows opens a waiter on any process of this user's; unix has none to
/// open.
fn expect_exit_waiter() -> bool {
    cfg!(windows)
}

/// Unix: SIGTERM is a request a process may ignore. Windows: terminate ends
/// the job outright.
fn expect_terminate_can_be_ignored() -> bool {
    cfg!(unix)
}

/// A live process this user may not signal. Unix: pid 1, the init process
/// (root's). Windows: pid 4, the System process.
fn expect_unsignallable_pid() -> Pid {
    Pid::from_raw(if cfg!(windows) { 4 } else { 1 })
}

/// A directory either way. Unix: `/tmp`. Windows: `locks` in the codesense
/// home, owner-only.
fn expect_lock_dir(dir: &Path) {
    assert!(dir.is_dir(), "{}", dir.display());
    if cfg!(windows) {
        assert_eq!(dir, codesense_home().unwrap().join("locks"));
        let opened = open_nofollow(OpenOptions::new().read(true), dir).unwrap();
        assert!(is_owner_only(&opened).unwrap(), "{}", dir.display());
    } else {
        assert_eq!(dir, Path::new("/tmp"));
    }
}

/// What a plain file or directory made inside an owner-only directory gets.
/// Windows: the directory's inheritable ACE, so it is owner-only too. Unix:
/// its mode comes from the umask, not the directory, so nothing to check.
fn expect_inherits_owner_only(path: &Path) {
    if cfg!(windows) {
        let opened = open_nofollow(OpenOptions::new().read(true), path).unwrap();
        assert!(is_owner_only(&opened).unwrap(), "{}", path.display());
    }
}

/// The error a busy file gives. Unix: `ETXTBSY`. Windows:
/// `ERROR_SHARING_VIOLATION`.
fn expect_text_busy_error() -> std::io::Error {
    #[cfg(unix)]
    let code = libc::ETXTBSY;
    #[cfg(windows)]
    let code = windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32;
    std::io::Error::from_raw_os_error(code)
}

/// Unix: mode 0700 for the owner and 0755 for everyone. Windows: no mode;
/// the extension made it executable.
fn expect_executable_mode(path: &Path, reach: Reach) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let wanted = match reach {
            Reach::Owner => 0o700,
            Reach::Everyone => 0o755,
        };
        assert_eq!(mode, wanted, "{}", path.display());
    }
    #[cfg(windows)]
    let _ = (path, reach);
}

/// Unix: a plain child shares this process's group, which is never adopted.
/// Windows: any process is adopted into a job.
fn expect_own_group_adopted() -> bool {
    cfg!(windows)
}

/// macOS and Linux: a group leader's group is its own pid. Elsewhere there is
/// nothing to read.
fn expect_group_of_leader(read: Option<(i32, i32)>, leader: Pid) {
    if cfg!(any(target_os = "macos", target_os = "linux")) {
        assert_eq!(read.map(|(group, _)| group), Some(leader.as_raw() as i32));
    } else {
        assert_eq!(read, None);
    }
}

/// The OS error for running out of descriptors: `EMFILE` on unix,
/// `ERROR_TOO_MANY_OPEN_FILES` on Windows.
fn expect_too_many_open_files() -> i32 {
    #[cfg(unix)]
    return libc::EMFILE;
    #[cfg(windows)]
    return 4;
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

/// The file name of an executable `stem`: unix needs no extension; Windows
/// runs a file by its extension.
fn expect_executable_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_owned()
    }
}

/// What `candidates` finds of [`TOOL_FILES`] in `dir`. Unix: `tool`, the one
/// named file. Windows: `tool.exe` and `tool.cmd` in `PATHEXT` order, spelled
/// with its extensions.
fn expect_installs(dir: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        pathext()
            .into_iter()
            .filter(|ext| {
                [".exe", ".cmd"]
                    .iter()
                    .any(|ours| ext.eq_ignore_ascii_case(ours))
            })
            .map(|ext| dir.join(format!("tool{ext}")))
            .collect()
    } else {
        vec![dir.join("tool")]
    }
}

/// What `named_in` names for a bare `name`. Unix: `dir/name`. Windows:
/// `dir/name<ext>` for each `PATHEXT` extension.
fn expect_named(dirs: &[PathBuf], name: &str) -> Vec<PathBuf> {
    let files = if cfg!(windows) {
        pathext().iter().map(|ext| format!("{name}{ext}")).collect()
    } else {
        vec![name.to_owned()]
    };
    dirs.iter()
        .flat_map(|dir| files.iter().map(move |file| dir.join(file)))
        .collect()
}

/// The package-manager bin directories, in order. Unix: Homebrew, then the
/// user-local, npm, bun and pnpm directories under the home. Windows: npm,
/// Scoop, WinGet and bun.
fn expect_package_dirs() -> Vec<PathBuf> {
    let var = |name: &str| PathBuf::from(std::env::var_os(name).expect(name));
    if cfg!(windows) {
        let home = var("USERPROFILE");
        vec![
            var("APPDATA").join("npm"),
            home.join("scoop").join("shims"),
            var("LOCALAPPDATA")
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
            home.join(".bun").join("bin"),
        ]
    } else {
        let home = var("HOME");
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
            home.join("Library/pnpm"),
            home.join(".local/share/pnpm"),
        ]
    }
}

/// Unix: the login shell's `$PATH`, so the probe's answer. Windows: the
/// process `PATH`, and the probe is never called.
fn expect_search_path(found: Option<String>, probed: bool) {
    if cfg!(windows) {
        assert!(!probed, "Windows has no login shell to probe");
        assert_eq!(found, std::env::var("PATH").ok());
    } else {
        assert!(probed);
        assert_eq!(found.as_deref(), Some("from the probe"));
    }
}

#[test]
fn login_shell_is_the_accounts_shell() {
    expect_login_shell(login_shell());
}

/// Unix: the passwd entry's shell, an absolute path (every macOS and Linux
/// account has one). Windows: none, as it has no login shell.
fn expect_login_shell(shell: Option<String>) {
    if cfg!(windows) {
        assert_eq!(shell, None);
    } else {
        let shell = shell.expect("a login shell in the passwd entry");
        assert!(shell.starts_with('/'), "{shell}");
    }
}

/// Unix: an exited child not yet reaped is a zombie that holds its pid, so it
/// is not retired. Windows: `is_alive` sees its handle signalled, so it is.
fn expect_retired_while_unreaped() -> bool {
    cfg!(windows)
}

/// The code a parent reads for a child that exits with `code`. Unix keeps
/// only its low 8 bits; Windows keeps all 32.
fn expect_exit_code(code: i32) -> i32 {
    if cfg!(unix) {
        code & 0xff
    } else {
        code
    }
}
