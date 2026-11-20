// SPDX-License-Identifier: MIT
//! The activity ingress on a Unix socket: the host's listener, and the helper's client
//! that reports, binds and asks through it. The named-pipe port replaces this file.
use super::*;
use crate::activity::{engine, inbox, launch, ActivityOwner};
use codesense_host_proto::inbox_wait as wire_inbox;
use codesense_platform::process::Identity as Process;
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(crate) type Connection = UnixStream;

/// RAII lifetime is the owning host, not any desktop transport connection.
pub struct ActivityService {
    path: PathBuf,
    inode: u64,
    stop: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

impl ActivityService {
    /// `root` must already be a private directory belonging to this user. `bridge` is the
    /// host's `codesense-bridge`, placed in `root` for Claude's hooks.
    pub fn start(
        root: &Path,
        owner: &Arc<ActivityOwner>,
        bridge: Option<&Path>,
    ) -> io::Result<Self> {
        Self::start_with(root, owner, bridge, HelperLink::Hard)
    }

    /// [`Self::start`], choosing how the shells' helper and the bridge are placed. A
    /// private-account host must never hard-link its installed binary: that
    /// install refuses any file with a second link.
    pub fn start_with(
        root: &Path,
        owner: &Arc<ActivityOwner>,
        bridge: Option<&Path>,
        link: HelperLink,
    ) -> io::Result<Self> {
        let metadata = std::fs::symlink_metadata(root)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "activity root is not private",
            ));
        }
        let path = root.join(SOCKET_NAME);
        if let Ok(previous) = std::fs::symlink_metadata(&path) {
            if !previous.file_type().is_socket() || previous.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "activity endpoint is not an owned socket",
                ));
            }
            let probe = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
            match probe.connect_timeout(&socket2::SockAddr::unix(&path)?, Duration::from_millis(50))
            {
                Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
                    let current = std::fs::symlink_metadata(&path)?;
                    if current.ino() != previous.ino() || current.dev() != previous.dev() {
                        return Err(invalid());
                    }
                    std::fs::remove_file(&path)?;
                }
                Err(error) => return Err(error),
                Ok(()) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "activity owner already listening",
                    ))
                }
            }
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let inode = std::fs::symlink_metadata(&path)?.ino();
        listener.set_nonblocking(true)?;
        let helper = std::env::current_exe()?;
        // A CLI typed in a shell still starts without it, unobserved.
        if let Err(error) = refresh_helper(root, &helper, link) {
            log::warn!("activity helper for typed agents unavailable: {error}");
        }
        // Claude's status and guard hooks run this host's bridge; without it they do nothing.
        if let Err(error) = crate::notify_hook::install(root, bridge, link) {
            log::warn!("Claude hooks unavailable: {error}");
        }
        sweep_stale_launches(root, std::time::SystemTime::now());
        owner.configure_ingress(path.clone(), helper);
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let owner = Arc::downgrade(owner);
        let thread = std::thread::Builder::new()
            .name("activity-ingress".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                let mut workers: Vec<JoinHandle<()>> = Vec::new();
                let mut swept = Instant::now();
                while !stopping.load(Ordering::Acquire) && owner.strong_count() != 0 {
                    workers.retain(|worker| !worker.is_finished());
                    if swept.elapsed() >= DECAY_INTERVAL {
                        swept = Instant::now();
                        if let Some(owner) = owner.upgrade() {
                            owner.decay(swept);
                        }
                    }
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if active.load(Ordering::Acquire) >= MAX_CONNECTIONS {
                                continue;
                            }
                            let Some(owner) = owner.upgrade() else {
                                break;
                            };
                            active.fetch_add(1, Ordering::AcqRel);
                            let count = active.clone();
                            match std::thread::Builder::new()
                                .name("activity-report".into())
                                .spawn(move || {
                                    let _ = receive(stream, owner);
                                    count.fetch_sub(1, Ordering::AcqRel);
                                }) {
                                Ok(worker) => workers.push(worker),
                                Err(_) => {
                                    active.fetch_sub(1, Ordering::AcqRel);
                                }
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                }
                for worker in workers {
                    let _ = worker.join();
                }
            })?;
        Ok(Self {
            path,
            inode,
            stop,
            listener: Some(thread),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// What every shell of this host exports so a CLI typed in it reports here.
    pub fn shell_env(&self) -> Option<(&'static str, String)> {
        let root = self.path.parent()?.to_str()?;
        Some((HOST_ENV, root.to_owned()))
    }
}

/// Put this binary at `<root>/activity-helper`, replacing whatever an older
/// install left there in one rename. A hard link pins this very build, so a
/// later rebuild or update of the file it came from can never leave the
/// shells a helper that does not know `--activity-run`; across filesystems it
/// falls back to a symbolic link.
fn refresh_helper(root: &Path, helper: &Path, how: HelperLink) -> io::Result<()> {
    let link = root.join(HELPER_NAME);
    let current = std::fs::metadata(helper)?;
    let placed = match how {
        HelperLink::Hard => std::fs::symlink_metadata(&link)
            .is_ok_and(|placed| placed.ino() == current.ino() && placed.dev() == current.dev()),
        HelperLink::Symbolic => std::fs::read_link(&link).is_ok_and(|to| to == helper),
    };
    if placed {
        return Ok(());
    }
    let partial = root.join(format!(".{HELPER_NAME}.{}", uuid::Uuid::new_v4().simple()));
    match how {
        HelperLink::Hard => std::fs::hard_link(helper, &partial)
            .or_else(|_| std::os::unix::fs::symlink(helper, &partial))?,
        HelperLink::Symbolic => std::os::unix::fs::symlink(helper, &partial)?,
    }
    std::fs::rename(&partial, &link).inspect_err(|_| {
        let _ = std::fs::remove_file(&partial);
    })
}

/// Launch directories outlive a host that crashed. Each holds a private copy
/// of a person's settings, so one no live CLI could still be reading is
/// removed: only the owned file names, and only past a day old.
fn sweep_stale_launches(root: &Path, now: std::time::SystemTime) {
    const STALE: Duration = Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let named = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("activity-launch-"));
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let old = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE);
        if !named || !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } || !old {
            continue;
        }
        for name in ["bootstrap.json", "settings.json"] {
            let _ = std::fs::remove_file(path.join(name));
        }
        let _ = std::fs::remove_dir(&path);
    }
}

impl Drop for ActivityService {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.listener.take() {
            let _ = thread.join();
        }
        if std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| metadata.ino() == self.inode)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn monotonic_ns() -> io::Result<u64> {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: clock_gettime writes one initialized timespec.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((time.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(time.tv_nsec as u64))
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "activity report rejected")
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(invalid)
}

fn read_exact_until(
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> io::Result<()> {
    while !bytes.is_empty() {
        match stream.set_read_timeout(Some(remaining(deadline)?)) {
            // Darwin refuses a timeout once the peer has closed; what it sent
            // is still buffered and the read below cannot block.
            Err(error) if error.raw_os_error() == Some(libc::EINVAL) => {}
            result => result?,
        }
        match stream.read(bytes) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                bytes = &mut bytes[n..];
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn write_all_until(stream: &mut UnixStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        match stream.write(bytes) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(n) => bytes = &bytes[n..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn receive(mut stream: UnixStream, owner: Arc<ActivityOwner>) -> io::Result<()> {
    let accepted = Instant::now();
    let receive_deadline = accepted + BUDGET;
    let peer = Process::of_unix_peer(&stream).ok_or_else(invalid)?;
    let mut length = [0; 4];
    read_exact_until(&mut stream, &mut length, receive_deadline)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_REPORT {
        return Err(invalid());
    }
    let mut bytes = vec![0; length];
    read_exact_until(&mut stream, &mut bytes, receive_deadline)?;
    let mut envelope: Envelope = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let remaining = envelope
        .deadline_ns
        .checked_sub(monotonic_ns()?)
        .filter(|v| *v > 0)
        .ok_or_else(invalid)?;
    let deadline = (Instant::now() + Duration::from_nanos(remaining)).min(accepted + BUDGET);
    let token = std::mem::take(&mut envelope.token);
    match envelope.into_operation().ok_or_else(invalid)? {
        Operation::Engine { engine } => {
            owner
                .bind_engine(&token, peer, engine.pid, engine.endpoint, engine.home)
                .map_err(|_| invalid())?;
        }
        Operation::Inbox { ask } => return serve_inbox(stream, owner, peer, token, ask),
        Operation::Claim { provider, batch } => {
            let claimed =
                launch::claim_shell_launch(&owner, peer, provider, batch).map_err(|_| invalid())?;
            let bytes = serde_json::to_vec(&claimed).map_err(|_| invalid())?;
            write_all_until(&mut stream, b"A", deadline)?;
            write_all_until(&mut stream, &(bytes.len() as u32).to_be_bytes(), deadline)?;
            return write_all_until(&mut stream, &bytes, deadline);
        }
        Operation::Report { report } => {
            owner
                .report(&token, peer, report, deadline)
                .map_err(|_| invalid())?;
        }
        Operation::Bind {
            bind: Bind::EngineLost,
            ..
        } => {
            owner.engine_lost(&token, peer).map_err(|_| invalid())?;
        }
        Operation::Bind {
            bind: Bind::InboxUpdateRequired,
            ..
        } => {
            if !owner.require_inbox_update(&token, Some(peer.pid)) {
                return Err(invalid());
            }
        }
        Operation::Bind {
            bind: Bind::ManagedShellInvocation,
            batch,
        } => {
            owner
                .bind_shell(&token, peer, deadline, batch)
                .map_err(|_| invalid())?;
        }
    }
    write_all_until(&mut stream, b"A", deadline)
}

/// Serves an inbox hook's helper asking for its agent's notice, on a thread of its own.
fn serve_inbox(
    mut stream: UnixStream,
    owner: Arc<ActivityOwner>,
    peer: Process,
    token: String,
    ask: inbox::Ask,
) -> io::Result<()> {
    // Served on a thread of its own: a waiter holds no report slot while it waits.
    static WAITING: AtomicUsize = AtomicUsize::new(0);
    if WAITING.fetch_add(1, Ordering::AcqRel) >= MAX_INBOX_WAITERS {
        WAITING.fetch_sub(1, Ordering::AcqRel);
        // Answered, so its helper ends rather than takes the host for unreachable.
        let replaced = wire_inbox::answer_lines(&wire_inbox::InboxWait::Replaced, "");
        return wire_inbox::send_lines(&mut stream, &replaced);
    }
    /// Gives the waiter's slot back however its thread ends.
    struct Slot;
    impl Drop for Slot {
        fn drop(&mut self) {
            WAITING.fetch_sub(1, Ordering::AcqRel);
        }
    }
    let slot = Slot;
    std::thread::Builder::new()
        .name("inbox-wait".into())
        .spawn(move || {
            let _slot = slot;
            inbox::serve(&owner, stream, peer, &token, ask);
        })
        .map(drop)
}

/// One bounded attempt; callers exit neutrally even if delivery fails. This
/// entry accepts only the normalized whitelist, never raw provider content.
pub fn report_from_stdin() -> io::Result<()> {
    let mut input = Vec::new();
    let deadline = Instant::now() + BUDGET;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(invalid)?;
        let mut descriptor = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // The helper owns stdin; poll prevents a broken producer keeping it alive.
        let ready = unsafe { libc::poll(&mut descriptor, 1, remaining.as_millis().max(1) as i32) };
        if ready <= 0 {
            return Err(invalid());
        }
        let mut chunk = [0u8; 8192];
        let read =
            unsafe { libc::read(libc::STDIN_FILENO, chunk.as_mut_ptr().cast(), chunk.len()) };
        if read < 0 {
            return Err(invalid());
        }
        if read == 0 {
            break;
        }
        input.extend_from_slice(&chunk[..read as usize]);
        if input.len() as u64 > INPUT_LIMIT {
            return Err(invalid());
        }
    }
    let binding = engine::Binding::from_env().ok_or_else(invalid)?;
    let report = match std::env::args().nth(2) {
        Some(cli) => {
            let cli: crate::agent_cli::AgentCli = cli.parse().map_err(|_| invalid())?;
            let adapter = crate::agent_cli::adapter(cli);
            // Only a CLI qualified by its version is told that its probe passed.
            let qualified = matches!(
                adapter.probe().activity,
                crate::agent_cli::ActivityProbe::Version
            ) && binding.qualified;
            adapter.normalize(&input, qualified).ok_or_else(invalid)?
        }
        None => serde_json::from_slice::<Report>(&input).map_err(|_| invalid())?,
    };
    send(&binding.socket, &binding.token, report)
}

fn send(socket: &Path, token: &str, report: Report) -> io::Result<()> {
    send_operation(socket, token, Operation::Report { report }).map(drop)
}

pub(super) fn bind_shell(socket: &Path, token: &str, batch: bool) -> io::Result<()> {
    send_operation(
        socket,
        token,
        Operation::Bind {
            bind: Bind::ManagedShellInvocation,
            batch,
        },
    )
    .map(drop)
}

pub(super) fn engine_lost(socket: &Path, token: &str) -> io::Result<()> {
    send_operation(
        socket,
        token,
        Operation::Bind {
            bind: Bind::EngineLost,
            batch: false,
        },
    )
    .map(drop)
}

pub(super) fn require_inbox_update(socket: &Path, token: &str) -> io::Result<()> {
    send_operation(
        socket,
        token,
        Operation::Bind {
            bind: Bind::InboxUpdateRequired,
            batch: false,
        },
    )
    .map(drop)
}

/// Claim an invocation for the CLI this process is about to become, as a
/// process running under one of the host's shells.
pub(super) fn claim_shell(
    socket: &Path,
    provider: crate::agent_cli::AgentCli,
    batch: bool,
) -> io::Result<Claimed> {
    let mut stream = send_operation(socket, "", Operation::Claim { provider, batch })?;
    let deadline = Instant::now() + BUDGET;
    let mut length = [0; 4];
    read_exact_until(&mut stream, &mut length, deadline)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_REPORT {
        return Err(invalid());
    }
    let mut bytes = vec![0; length];
    read_exact_until(&mut stream, &mut bytes, deadline)?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

/// Names the engine `pid`, serving on `endpoint`, that this process (its launch helper,
/// about to become the CLI `token` names) started under itself.
pub(super) fn bind_engine(
    socket: &Path,
    token: &str,
    pid: u32,
    endpoint: &Path,
    home: Option<PathBuf>,
) -> io::Result<()> {
    let engine = EngineBind {
        home,
        pid,
        endpoint: endpoint.to_path_buf(),
    };
    send_operation(socket, token, Operation::Engine { engine }).map(drop)
}

/// An inbox hook's helper's connection to its host, `token` naming its CLI's invocation,
/// once it asked: the host's answer follows as the waiter's lines.
pub(super) fn ask_inbox(socket: &Path, token: &str, ask: inbox::Ask) -> io::Result<UnixStream> {
    connect_and_send(socket, token, Operation::Inbox { ask }).map(|(stream, _)| stream)
}

/// The acknowledged connection, for an operation whose answer follows.
fn send_operation(socket: &Path, token: &str, operation: Operation) -> io::Result<UnixStream> {
    let (mut stream, deadline) = connect_and_send(socket, token, operation)?;
    let mut ack = [0];
    read_exact_until(&mut stream, &mut ack, deadline)?;
    if ack != [b'A'] {
        return Err(invalid());
    }
    Ok(stream)
}

/// The connection that sent `operation`, and the deadline it was sent under.
fn connect_and_send(
    socket: &Path,
    token: &str,
    operation: Operation,
) -> io::Result<(UnixStream, Instant)> {
    let start = Instant::now();
    let deadline_ns = monotonic_ns()?.saturating_add(BUDGET.as_nanos() as u64);
    let mut envelope = Envelope {
        token: token.into(),
        deadline_ns,
        report: None,
        bind: None,
        claim: None,
        batch: false,
        inbox: None,
        engine: None,
    };
    match operation {
        Operation::Report { report } => envelope.report = Some(report),
        Operation::Bind { bind, batch } => (envelope.bind, envelope.batch) = (Some(bind), batch),
        Operation::Claim { provider, batch } => {
            (envelope.claim, envelope.batch) = (Some(provider), batch);
        }
        Operation::Inbox { ask } => envelope.inbox = Some(ask),
        Operation::Engine { engine } => envelope.engine = Some(engine),
    }
    let bytes = serde_json::to_vec(&envelope).map_err(|_| invalid())?;
    if bytes.len() > MAX_REPORT {
        return Err(invalid());
    }
    let transport = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
    transport.connect_timeout(
        &socket2::SockAddr::unix(socket)?,
        BUDGET.checked_sub(start.elapsed()).ok_or_else(invalid)?,
    )?;
    let fd: std::os::fd::OwnedFd = transport.into();
    let mut stream = UnixStream::from(fd);
    let deadline = start + BUDGET;
    write_all_until(&mut stream, &(bytes.len() as u32).to_be_bytes(), deadline)?;
    write_all_until(&mut stream, &bytes, deadline)?;
    Ok((stream, deadline))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::{Event, Scope, State};
    use crate::agent_cli::AgentCli;

    fn report(event: Event, id: &str) -> Report {
        Report {
            provider: AgentCli::Claude,
            event,
            scope: Scope::Main,
            report_id: id.into(),
            provider_session: Some("provider-session".into()),
            turn: None,
            tool: None,
            tool_name: None,
            reason: None,
            agent: None,
            subagents: None,
        }
    }

    #[test]
    fn host_ingress_retains_activity_without_a_viewer_and_rejects_retired_writer() {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = Arc::new(ActivityOwner::new());
        let service = ActivityService::start(root.path(), &owner, None).unwrap();
        let writer = owner
            .prepare_native(
                "session",
                AgentCli::Claude,
                service.path().to_str().unwrap(),
            )
            .unwrap();
        let incarnation = owner.register("session", Some(std::process::id())).unwrap();
        assert_eq!(writer.identity.session_incarnation, incarnation);
        // No desktop/control connection exists. The reporting process and owner
        // alone are sufficient; a later snapshot recovers identical evidence.
        send(
            service.path(),
            &writer.token,
            report(Event::Started, "start"),
        )
        .unwrap();
        send(
            service.path(),
            &writer.token,
            report(Event::Submitted, "turn"),
        )
        .unwrap();
        let mut retained = owner.snapshots().pop().unwrap();
        let retained_evidence_at = owner.evidence_at_for_test("session").unwrap();
        assert_eq!(retained.state, State::Thinking);
        assert_eq!(retained.identity, writer.identity);
        assert!(!serde_json::to_string(&retained)
            .unwrap()
            .contains(&writer.token));
        send(
            service.path(),
            &writer.token,
            report(Event::Submitted, "turn"),
        )
        .unwrap();
        let replayed = owner.snapshots();
        assert_eq!(replayed.len(), 1);
        assert_eq!(
            owner.evidence_at_for_test("session"),
            Some(retained_evidence_at)
        );
        // Capture age advances with wall time; all retained evidence must
        // remain identical, and replaying the report must not reset its age.
        assert!(replayed[0].activity_age_ms.unwrap() >= retained.activity_age_ms.unwrap());
        retained.activity_age_ms = replayed[0].activity_age_ms;
        assert_eq!(replayed, vec![retained]);
        owner.remove("session", &incarnation);
        let replacement = owner
            .prepare_native(
                "session",
                AgentCli::Claude,
                service.path().to_str().unwrap(),
            )
            .unwrap();
        owner.register("session", Some(std::process::id()));
        assert_ne!(replacement.identity, writer.identity);
        assert!(send(
            service.path(),
            &writer.token,
            report(Event::Stopped, "late")
        )
        .is_err());
        assert!(!owner.snapshots()[0].observed);
        let path = service.path().to_owned();
        drop(service);
        assert!(!path.exists());
    }

    /// A CLI typed by hand and one CodeSense launched fold the same hook stream
    /// into the same states, through the same socket.
    #[test]
    fn hand_typed_claim_and_launched_invocation_fold_hooks_identically() {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = Arc::new(ActivityOwner::new());
        let service = ActivityService::start(root.path(), &owner, None).unwrap();
        let (name, value) = service.shell_env().unwrap();
        assert_eq!(name, crate::activity::HOST_ENV);
        assert_eq!(Path::new(&value), root.path());
        // The helper is this very build, pinned: a rebuild of the file it came
        // from does not change what the shells run.
        let placed = std::fs::metadata(root.path().join(crate::activity::HELPER_NAME)).unwrap();
        let built = std::fs::metadata(std::env::current_exe().unwrap()).unwrap();
        assert_eq!((placed.ino(), placed.dev()), (built.ino(), built.dev()));
        // No old status script is left where Claude's hooks look; with no bridge given,
        // none is placed.
        assert!(!root.path().join(crate::notify_hook::NAME).exists());
        assert!(!root
            .path()
            .join(codesense_host_proto::hook::BRIDGE)
            .exists());
        // This test process is the hand-typed CLI; its parent stands in for the
        // shell the host spawned.
        let shell = unsafe { libc::getppid() } as u32;
        owner.register("typed", Some(shell));
        let claimed = claim_shell(service.path(), AgentCli::Claude, false).unwrap();
        assert!(claimed.directory.starts_with(root.path()));
        assert!(claimed.directory.is_dir());
        let launched = owner
            .prepare_native(
                "launched",
                AgentCli::Claude,
                service.path().to_str().unwrap(),
            )
            .unwrap();
        owner.register("launched", Some(std::process::id()));
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/http/routes/fixtures/claude-hooks");
        let stream = [
            "UserPromptSubmit",
            "PreToolUse",
            "PermissionRequest",
            "PostToolUse",
            "StopFailure",
            "UserPromptSubmit",
            "Stop",
        ];
        let mut states = [Vec::new(), Vec::new()];
        for (index, token) in [&claimed.token, &launched.token].into_iter().enumerate() {
            let start =
                serde_json::json!({"hook_event_name": "SessionStart", "session_id": "provider"});
            let report = crate::agent_cli::adapter(AgentCli::Claude)
                .normalize(&serde_json::to_vec(&start).unwrap(), false)
                .unwrap();
            send(service.path(), token, report).unwrap();
            for name in stream {
                let mut payload: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(fixtures.join(format!("{name}.json"))).unwrap(),
                )
                .unwrap();
                payload["session_id"] = "provider".into();
                if payload.get("tool_use_id").is_some() {
                    payload["tool_use_id"] = "tool".into();
                }
                let report = crate::agent_cli::adapter(AgentCli::Claude)
                    .normalize(&serde_json::to_vec(&payload).unwrap(), false)
                    .unwrap();
                send(service.path(), token, report).unwrap();
                let session = ["typed", "launched"][index];
                let snapshot = owner.snapshot(session).unwrap();
                states[index].push((snapshot.state, snapshot.reason));
            }
        }
        assert_eq!(states[0], states[1]);
        assert_eq!(
            states[0]
                .iter()
                .map(|(state, _)| *state)
                .collect::<Vec<_>>(),
            [
                State::Thinking,
                State::Working,
                State::NeedsPermission,
                State::Thinking,
                State::Errored,
                State::Thinking,
                State::Done
            ]
        );
        assert_eq!(states[0][4].1.as_deref(), Some("model_not_found"));
        // A process outside every shell of this host claims nothing.
        owner.remove(
            "typed",
            &owner
                .snapshot("typed")
                .unwrap()
                .identity
                .session_incarnation,
        );
        assert!(claim_shell(service.path(), AgentCli::Claude, false).is_err());
    }

    #[test]
    fn a_helper_that_cannot_be_placed_does_not_stop_the_service_and_stale_launches_are_swept() {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        // Something that is not ours sits where the helper goes.
        std::fs::create_dir(root.path().join(crate::activity::HELPER_NAME)).unwrap();
        let stale = root.path().join("activity-launch-stale");
        let fresh = root.path().join("activity-launch-fresh");
        for directory in [&stale, &fresh] {
            std::fs::create_dir(directory).unwrap();
            std::fs::write(directory.join("settings.json"), "{}").unwrap();
        }
        let foreign = stale.join("user-hook-artifact");
        std::fs::write(&foreign, "keep").unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(25 * 60 * 60);
        sweep_stale_launches(root.path(), later);
        // A launch directory with something not ours in it keeps that.
        assert!(foreign.exists());
        assert!(!stale.join("settings.json").exists());
        std::fs::remove_file(&foreign).unwrap();
        sweep_stale_launches(root.path(), later);
        assert!(!stale.exists());
        assert!(!fresh.exists(), "both were past a day at `later`");
        std::fs::create_dir(&fresh).unwrap();
        std::fs::write(fresh.join("settings.json"), "{}").unwrap();
        let owner = Arc::new(ActivityOwner::new());
        let service = ActivityService::start(root.path(), &owner, None).unwrap();
        // A launch from a few moments ago may still be read by its CLI.
        assert!(fresh.join("settings.json").exists());
        assert!(service.path().exists());
    }

    #[test]
    fn expired_report_child_stop_and_unknown_payload_do_not_mutate_owner() {
        let owner = ActivityOwner::new();
        let writer = owner
            .prepare_native("session", AgentCli::Claude, "unused")
            .unwrap();
        owner.register("session", Some(std::process::id()));
        let peer = Process::inspect(std::process::id()).unwrap();
        let before = owner.snapshots();
        assert!(owner
            .report(
                &writer.token,
                peer,
                report(Event::Started, "expired"),
                Instant::now()
            )
            .is_err());
        let mut child = report(Event::Stopped, "child");
        child.scope = Scope::Child;
        assert!(owner
            .report(&writer.token, peer, child, Instant::now() + BUDGET)
            .is_err());
        let mut raw = serde_json::to_value(report(Event::Started, "extra")).unwrap();
        raw["prompt"] = "not admitted".into();
        assert!(serde_json::from_value::<Report>(raw).is_err());
        assert_eq!(before, owner.snapshots());
    }

    #[test]
    fn slow_drip_cannot_extend_receive_or_host_shutdown_deadline() {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = Arc::new(ActivityOwner::new());
        let service = ActivityService::start(root.path(), &owner, None).unwrap();
        let mut client = UnixStream::connect(service.path()).unwrap();
        let start = Instant::now();
        // Sending one header byte each 100 ms used to reset SO_RCVTIMEO.
        let drip = std::thread::spawn(move || {
            for byte in [0, 0, 0, 100, b'{', b'"', b'a'] {
                if client.write_all(&[byte]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        std::thread::sleep(Duration::from_millis(40));
        drop(service);
        assert!(start.elapsed() < Duration::from_millis(600));
        drip.join().unwrap();
        assert!(owner.snapshots().is_empty());
    }
}
