// SPDX-License-Identifier: MIT
//! The platform contract: the same tests on every OS. Test bodies hold no
//! `cfg`; what differs per OS is stated once, in an `expect_*` helper at the
//! end. Process tests drive the `platform-fixture` binary, never a shell;
//! it is the client of the IPC rows.

use std::cell::Cell;
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use codesense_platform::cli::{candidates, named_in, package_dirs, search_path};
use codesense_platform::dirs::codesense_home;
use codesense_platform::fs::{
    atomic_replace, canonicalize, create_new_owner_only, create_owner_only, file_id, file_id_of,
    is_executable, is_owned_by_current_user, is_owner_only, link_or_copy, lock_exclusive,
    open_nofollow, portable_name, set_owner_only, try_lock_exclusive, Linked, NonPortableName,
    Open,
};
use codesense_platform::ipc::{blocking, Endpoint, LocalListener, LocalStream};
use codesense_platform::process::{is_alive, kill_hard, terminate, Pid, ProcessTree};
use codesense_platform::testutil::{pathext, set_executable, symlink_or_skip};
use codesense_platform::user::current_user;
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

/// The relative path from the working directory to the absolute `path`: one
/// `..` per component of the working directory, then `path` without its root.
/// It reaches `path` (asserted), so a check that accepts it is not refusing
/// relative paths.
fn relative_from_cwd(path: &Path) -> PathBuf {
    fn normal(component: &Component) -> bool {
        matches!(component, Component::Normal(_))
    }
    let cwd = std::env::current_dir().unwrap();
    let mut relative: PathBuf = cwd.components().filter(normal).map(|_| "..").collect();
    relative.extend(path.components().filter(normal));
    assert!(
        relative.is_relative() && relative.exists(),
        "{}",
        relative.display()
    );
    relative
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

/// Write the file `name` in `dir` (made if missing) and make it executable.
fn executable(dir: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    set_executable(&path);
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
