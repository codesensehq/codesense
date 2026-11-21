// SPDX-License-Identifier: MIT
//! Windows: named pipes `\\.\pipe\codesense-<user>-<endpoint>[-<root>]`.
//! One function creates every instance, overlapped for both forms (tokio's,
//! and the blocking one, which waits on each operation it starts): a DACL
//! that grants the current user alone, remote clients refused, the current
//! user as owner, and `FILE_FLAG_FIRST_PIPE_INSTANCE` on a listener's first
//! instance. Clients open with identification-only impersonation and refuse a
//! pipe another user owns. Those two are the user boundary: the DACL keeps
//! other users' clients out of a listener, and the owner check keeps a client
//! off another user's listener. A peer's pid is only looked up.

use std::ffi::OsStr;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer};
use windows_sys::Win32::Foundation::{
    LocalFree, ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
use windows_sys::Win32::Security::{
    InitializeSecurityDescriptor, SetSecurityDescriptorDacl, SetSecurityDescriptorOwner,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SECURITY_DESCRIPTOR,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ALL_ACCESS, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use super::Endpoint;
use crate::process::Pid;
use crate::win::{wide, CurrentUser, SingleUserAcl, SECURITY_DESCRIPTOR_REVISION};

/// The start of every CodeSense pipe name.
const PIPE_PREFIX: &str = r"\\.\pipe\codesense-";
/// What each instance asks for its in and out buffers.
const BUFFER_SIZE: u32 = 64 * 1024;
/// How long a connection waits while every instance is busy.
const BUSY_WAIT: Duration = Duration::from_secs(5);
/// How often an async connection retries a busy pipe.
const BUSY_RETRY: Duration = Duration::from_millis(10);

pub(super) fn address(endpoint: &Endpoint) -> io::Result<PathBuf> {
    let suffix = match endpoint {
        Endpoint::Mcp => "mcp".to_owned(),
        Endpoint::Activity(root) => format!("activity-{}", root_hash(root)),
        Endpoint::SessionServer(root) => format!("session-server-{}", root_hash(root)),
        Endpoint::Ephemeral { name, .. } => name.clone(),
    };
    Ok(PathBuf::from(format!("{}{suffix}", user_prefix()?)))
}

pub(super) fn from_wire(wire: &OsStr) -> io::Result<Endpoint> {
    let prefix = user_prefix()?;
    let name = wire
        .to_str()
        .and_then(|wire| wire.strip_prefix(prefix))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not a pipe of this user's", Path::new(wire).display()),
            )
        })?;
    Ok(Endpoint::Ephemeral {
        dir: PathBuf::new(),
        name: name.to_owned(),
    })
}

/// `\\.\pipe\codesense-<user>-`: the start of this user's pipe names.
fn user_prefix() -> io::Result<&'static str> {
    static PREFIX: OnceLock<String> = OnceLock::new();
    if let Some(prefix) = PREFIX.get() {
        return Ok(prefix);
    }
    let sid = CurrentUser::read()?.sid_string()?;
    Ok(PREFIX.get_or_init(|| format!("{PIPE_PREFIX}{:016x}-", fnv1a(sid.as_bytes()))))
}

/// The root as a hash. The same directory written with either separator, in
/// another case, with a trailing separator or a verbatim prefix hashes the
/// same.
fn root_hash(root: &Path) -> String {
    let plain: PathBuf = dunce::simplified(root).components().collect();
    let text = plain.to_string_lossy().to_lowercase();
    format!("{:016x}", fnv1a(text.as_bytes()))
}

/// 64-bit FNV-1a: the same in every build and release, as std's hasher is
/// not. It keeps names apart; it hides nothing.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Create an instance of the pipe `name` that only the current user may
/// open, and that names the current user as its owner. The `first` of a
/// listener fails with `AddrInUse` when the name already exists, whoever
/// created it.
fn create_instance(name: &Path, first: bool, overlapped: bool) -> io::Result<OwnedHandle> {
    let user = CurrentUser::read()?;
    create_instance_owned_by(name, first, overlapped, user.sid())
}

/// [`create_instance`] with `owner` as the pipe's owner; the DACL still
/// grants the current user alone.
fn create_instance_owned_by(
    name: &Path,
    first: bool,
    overlapped: bool,
    owner: PSID,
) -> io::Result<OwnedHandle> {
    let user = CurrentUser::read()?;
    let acl = SingleUserAcl::new(user.sid(), 0, FILE_ALL_ACCESS)?;
    // SAFETY: an all-zero SECURITY_DESCRIPTOR is a valid value to initialize.
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let descriptor_ptr = std::ptr::addr_of_mut!(descriptor).cast();
    // SAFETY: the descriptor is writable and the size InitializeSecurityDescriptor expects.
    if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the descriptor points at the ACL, which outlives the create below.
    if unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl.as_ptr(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // An explicit owner: an elevated token's default owner is Administrators,
    // which a client could not tell from another user's.
    // SAFETY: the descriptor points at the owner's SID, which outlives the
    // create below.
    if unsafe { SetSecurityDescriptorOwner(descriptor_ptr, owner, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor_ptr,
        bInheritHandle: 0,
    };
    let mut open_mode = PIPE_ACCESS_DUPLEX;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    if overlapped {
        open_mode |= FILE_FLAG_OVERLAPPED;
    }
    let wide_name = wide(name);
    // SAFETY: the name is NUL-terminated; the attributes, descriptor, ACL and
    // SID live across the call.
    let handle = unsafe {
        CreateNamedPipeW(
            wide_name.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER_SIZE,
            BUFFER_SIZE,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        if first && error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!("a listener already serves {}", name.display()),
            ));
        }
        return Err(error);
    }
    // SAFETY: the handle is open and owned by nothing else.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// A security descriptor the system allocated with LocalAlloc, freed on drop.
struct LocalDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for LocalDescriptor {
    fn drop(&mut self) {
        // SAFETY: the descriptor was LocalAlloc'd for this value alone.
        unsafe { LocalFree(self.0) };
    }
}

/// Refuse the pipe `handle` unless the current user owns it. Another
/// account could create a pipe under this user's name first; it cannot make
/// this user its owner.
fn check_owner(handle: HANDLE) -> io::Result<()> {
    let mut owner: PSID = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: the handle is an open pipe with READ_CONTROL (a duplex
    // client's generic read); the out pointers are writable.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // The owner points into the descriptor, freed on return.
    let _descriptor = LocalDescriptor(descriptor);
    if owner.is_null() || !CurrentUser::read()?.is(owner) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "another user owns the pipe",
        ));
    }
    Ok(())
}

/// The pid of the other end of the pipe `handle`: the client's on a
/// listener's instance, the listener's on a client's handle. It checks no
/// user: the DACL and the client's owner check have already.
fn peer_pid(handle: HANDLE, is_server: bool) -> io::Result<Pid> {
    let mut pid = 0u32;
    // SAFETY: the handle is an open pipe; `pid` is writable.
    let read = unsafe {
        if is_server {
            GetNamedPipeClientProcessId(handle, &mut pid)
        } else {
            GetNamedPipeServerProcessId(handle, &mut pid)
        }
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Pid::from_raw(pid))
}

fn is_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
}

pub(crate) struct Listener {
    name: PathBuf,
    /// The instance the next client connects to.
    next: NamedPipeServer,
}

impl Listener {
    pub(crate) fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        let name = endpoint.address()?;
        let next = server(create_instance(&name, true, true)?)?;
        Ok(Self { name, next })
    }

    pub(crate) async fn accept(&mut self) -> io::Result<Stream> {
        self.next.connect().await?;
        let following = server(create_instance(&self.name, false, true)?)?;
        Ok(Stream::Server(std::mem::replace(&mut self.next, following)))
    }
}

/// An overlapped instance as tokio's server end, registered with the
/// current runtime.
fn server(handle: OwnedHandle) -> io::Result<NamedPipeServer> {
    // SAFETY: the handle is an overlapped pipe instance, passed on whole.
    unsafe { NamedPipeServer::from_raw_handle(handle.into_raw_handle()) }
}

pub(crate) enum Stream {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}

impl Stream {
    pub(crate) async fn connect(endpoint: &Endpoint) -> io::Result<Self> {
        let name = endpoint.address()?;
        let start = Instant::now();
        loop {
            // tokio's client asks for identification-only impersonation.
            match ClientOptions::new().open(&name) {
                Err(error) if is_busy(&error) && start.elapsed() < BUSY_WAIT => {
                    tokio::time::sleep(BUSY_RETRY).await;
                }
                Err(error) => return Err(error),
                Ok(pipe) => {
                    check_owner(pipe.as_raw_handle())?;
                    return Ok(Self::Client(pipe));
                }
            }
        }
    }

    pub(crate) fn peer_pid(&self) -> io::Result<Pid> {
        match self {
            Self::Server(pipe) => peer_pid(pipe.as_raw_handle(), true),
            Self::Client(pipe) => peer_pid(pipe.as_raw_handle(), false),
        }
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(pipe) => Pin::new(pipe).poll_read(cx, buf),
            Self::Client(pipe) => Pin::new(pipe).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Server(pipe) => Pin::new(pipe).poll_write(cx, buf),
            Self::Client(pipe) => Pin::new(pipe).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(pipe) => Pin::new(pipe).poll_flush(cx),
            Self::Client(pipe) => Pin::new(pipe).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(pipe) => Pin::new(pipe).poll_shutdown(cx),
            Self::Client(pipe) => Pin::new(pipe).poll_shutdown(cx),
        }
    }
}

pub(crate) mod blocking {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, SECURITY_IDENTIFICATION};
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, WaitNamedPipeW};
    use windows_sys::Win32::System::Threading::{CreateEventW, INFINITE};
    use windows_sys::Win32::System::IO::{
        CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED,
    };

    use super::*;

    // Every handle here is overlapped, and every call waits for its own
    // completion, so the stream still blocks; the wait is what bounds a
    // timeout. A timed-out operation is cancelled with `CancelIoEx`, which
    // names that one operation, and waited out before its buffer is let go.
    // A stream's clones share its pipe, each with its own event, so one clone
    // reads while another writes; a stream's operations wait in slices of
    // `SHUT_POLL`, so a shutdown on any clone ends them within one.

    /// How long an operation on a stream waits before it looks again whether
    /// a clone shut the stream down.
    const SHUT_POLL: Duration = Duration::from_millis(50);

    /// `duration` as a wait's milliseconds: at least 1, short of `INFINITE`.
    fn wait_millis(duration: Duration) -> u32 {
        u32::try_from(duration.as_millis())
            .map_or(INFINITE - 1, |millis| millis.clamp(1, INFINITE - 1))
    }

    /// What an operation on a stream that was shut down fails with.
    fn shut_down() -> io::Error {
        io::Error::new(io::ErrorKind::NotConnected, "the pipe was shut down")
    }

    /// A manual-reset event an operation's `OVERLAPPED` signals.
    fn new_event() -> io::Result<OwnedHandle> {
        // SAFETY: no attributes or name; a null return is an error.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh handle this function owns.
        Ok(unsafe { OwnedHandle::from_raw_handle(event) })
    }

    /// An `OVERLAPPED` for one operation, signalling `event`.
    fn overlapped(event: &OwnedHandle) -> OVERLAPPED {
        // SAFETY: all zeros is a valid OVERLAPPED (offset 0, no event).
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.as_raw_handle();
        overlapped
    }

    /// The outcome of the operation `started` on `handle` with `overlapped`
    /// (whether its call returned true), waiting up to `timeout`, for ever
    /// when `None`: its byte count. One still pending then is cancelled and
    /// waited out, and is [`io::ErrorKind::TimedOut`]. With `shut`, the wait
    /// also ends within [`SHUT_POLL`] of `shut` being set, the operation
    /// cancelled the same way, and is [`io::ErrorKind::NotConnected`].
    fn finish(
        handle: HANDLE,
        overlapped: &OVERLAPPED,
        started: bool,
        timeout: Option<Duration>,
        shut: Option<&AtomicBool>,
    ) -> io::Result<u32> {
        if !started {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        let is_shut = || shut.is_some_and(|shut| shut.load(Ordering::Acquire));
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        let mut transferred: u32 = 0;
        let ended_by_shut = loop {
            let left = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
            let slice = match (left, shut) {
                (Some(left), Some(_)) => Some(left.min(SHUT_POLL)),
                (left, None) => left,
                (None, Some(_)) => Some(SHUT_POLL),
            };
            let millis = slice.map_or(INFINITE, wait_millis);
            // SAFETY: the operation was started on `handle` with
            // `overlapped`, which outlives this wait.
            if unsafe { GetOverlappedResultEx(handle, overlapped, &mut transferred, millis, 0) }
                != 0
            {
                return Ok(transferred);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(WAIT_TIMEOUT as i32) {
                // A shutdown's own cancel ends the operation this way.
                return Err(if is_shut() { shut_down() } else { error });
            }
            if is_shut() {
                break true;
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                break false;
            }
        };
        // SAFETY: cancels this one operation; then wait until it is done, so
        // the caller's buffer and `overlapped` are no longer in use.
        unsafe { CancelIoEx(handle, overlapped) };
        let completed =
            unsafe { GetOverlappedResult(handle, overlapped, &mut transferred, 1) } != 0;
        // It completed before the cancel reached it, or moved some bytes
        // first: those count, as `Read` and `Write` require.
        if completed || transferred > 0 {
            return Ok(transferred);
        }
        Err(if ended_by_shut {
            shut_down()
        } else {
            io::Error::new(io::ErrorKind::TimedOut, "the pipe timed out")
        })
    }

    pub(crate) struct Listener {
        name: PathBuf,
        /// The instance the next client connects to.
        next: OwnedHandle,
    }

    impl Listener {
        pub(crate) fn bind(endpoint: &Endpoint) -> io::Result<Self> {
            let name = endpoint.address()?;
            let next = create_instance(&name, true, true)?;
            Ok(Self { name, next })
        }

        pub(crate) fn accept(&mut self) -> io::Result<Stream> {
            let event = new_event()?;
            let mut connecting = overlapped(&event);
            let handle = self.next.as_raw_handle();
            // SAFETY: the instance is open and overlapped; `connecting` lives
            // until `finish` has seen the operation through.
            let started = unsafe { ConnectNamedPipe(handle, &mut connecting) } != 0;
            if let Err(error) = finish(handle, &connecting, started, None, None) {
                // Already connected, or connected and gone again (its bytes
                // are still read): either way a connection, as tokio counts it.
                let connected = [ERROR_PIPE_CONNECTED, ERROR_NO_DATA]
                    .iter()
                    .any(|&code| error.raw_os_error() == Some(code as i32));
                if !connected {
                    return Err(error);
                }
            }
            let following = create_instance(&self.name, false, true)?;
            Ok(Stream::new(
                std::mem::replace(&mut self.next, following),
                event,
                true,
            ))
        }

        #[cfg(test)]
        pub(super) fn pending_instance(&self) -> HANDLE {
            self.next.as_raw_handle()
        }
    }

    /// One connected pipe instance, shared by a stream and its clones.
    struct Pipe {
        handle: OwnedHandle,
        /// Set once any clone shut the stream down.
        shut: AtomicBool,
    }

    pub(crate) struct Stream {
        pipe: Arc<Pipe>,
        /// Signalled as each operation of this clone completes; one at a
        /// time.
        event: OwnedHandle,
        is_server: bool,
        read_timeout: Option<Duration>,
        write_timeout: Option<Duration>,
    }

    impl Stream {
        fn new(pipe: OwnedHandle, event: OwnedHandle, is_server: bool) -> Self {
            Self {
                pipe: Arc::new(Pipe {
                    handle: pipe,
                    shut: AtomicBool::new(false),
                }),
                event,
                is_server,
                read_timeout: None,
                write_timeout: None,
            }
        }

        /// Another stream on the same pipe, with its own event and its own
        /// timeouts, starting from this one's.
        pub(crate) fn try_clone(&self) -> io::Result<Self> {
            Ok(Self {
                pipe: Arc::clone(&self.pipe),
                event: new_event()?,
                is_server: self.is_server,
                read_timeout: self.read_timeout,
                write_timeout: self.write_timeout,
            })
        }

        /// Shut the stream and every clone down: an operation in flight on
        /// any of them ends within [`SHUT_POLL`], and every later one fails.
        /// The pipe itself closes once the last clone is dropped.
        pub(crate) fn shutdown(&self) -> io::Result<()> {
            self.pipe.shut.store(true, Ordering::Release);
            // SAFETY: cancels what this process has in flight on the pipe;
            // each operation's own wait sees it end. Nothing in flight is
            // `ERROR_NOT_FOUND`, which is not a failure here.
            unsafe { CancelIoEx(self.pipe.handle.as_raw_handle(), std::ptr::null()) };
            Ok(())
        }

        fn check_open(&self) -> io::Result<()> {
            if self.pipe.shut.load(Ordering::Acquire) {
                return Err(shut_down());
            }
            Ok(())
        }

        pub(crate) fn connect(endpoint: &Endpoint) -> io::Result<Self> {
            let name = endpoint.address()?;
            let start = Instant::now();
            loop {
                let opened = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(FILE_FLAG_OVERLAPPED)
                    .security_qos_flags(SECURITY_IDENTIFICATION)
                    .open(&name);
                match opened {
                    Err(error) if is_busy(&error) => {
                        let left = BUSY_WAIT.saturating_sub(start.elapsed());
                        if left.is_zero() {
                            return Err(error);
                        }
                        let wide_name = wide(&name);
                        // SAFETY: the name is NUL-terminated. A timeout or a
                        // pipe gone meanwhile shows in the next open.
                        unsafe { WaitNamedPipeW(wide_name.as_ptr(), left.as_millis() as u32) };
                    }
                    Err(error) => return Err(error),
                    Ok(pipe) => {
                        check_owner(pipe.as_raw_handle())?;
                        return Ok(Self::new(OwnedHandle::from(pipe), new_event()?, false));
                    }
                }
            }
        }

        pub(crate) fn peer_pid(&self) -> io::Result<Pid> {
            peer_pid(self.pipe.handle.as_raw_handle(), self.is_server)
        }

        pub(crate) fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
            self.read_timeout = checked(timeout)?;
            Ok(())
        }

        pub(crate) fn set_write_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
            self.write_timeout = checked(timeout)?;
            Ok(())
        }
    }

    /// A zero timeout is refused, as std's sockets refuse it.
    fn checked(timeout: Option<Duration>) -> io::Result<Option<Duration>> {
        if timeout == Some(Duration::ZERO) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot set a 0 duration timeout",
            ));
        }
        Ok(timeout)
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.check_open()?;
            let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
            let mut reading = overlapped(&self.event);
            let handle = self.pipe.handle.as_raw_handle();
            // SAFETY: `buf` and `reading` outlive the operation: `finish`
            // returns only once it completed or was cancelled.
            let started = unsafe {
                ReadFile(
                    handle,
                    buf.as_mut_ptr(),
                    len,
                    std::ptr::null_mut(),
                    &mut reading,
                )
            } != 0;
            match finish(handle, &reading, started, self.read_timeout, Some(&self.pipe.shut)) {
                Ok(read) => Ok(read as usize),
                // The other end closed: the end of the stream.
                Err(error) if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => Ok(0),
                Err(error) => Err(error),
            }
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.check_open()?;
            let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
            let mut writing = overlapped(&self.event);
            let handle = self.pipe.handle.as_raw_handle();
            // SAFETY: as for `read`.
            let started = unsafe {
                WriteFile(
                    handle,
                    buf.as_ptr(),
                    len,
                    std::ptr::null_mut(),
                    &mut writing,
                )
            } != 0;
            finish(
                handle,
                &writing,
                started,
                self.write_timeout,
                Some(&self.pipe.shut),
            )
            .map(|written| written as usize)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::ERROR_INVALID_OWNER;
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, GetAce, WinBuiltinAdministratorsSid, ACCESS_ALLOWED_ACE, ACE_HEADER,
        ACL, DACL_SECURITY_INFORMATION,
    };

    use super::*;

    /// `ACCESS_ALLOWED_ACE_TYPE`.
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    fn unique(name: &str) -> Endpoint {
        Endpoint::Ephemeral {
            dir: PathBuf::new(),
            name: format!("test-{name}-{}", std::process::id()),
        }
    }

    /// Read the owner and DACL of the pipe instance `handle` back: the
    /// current user owns it, and one ACE grants the current user.
    fn assert_current_user_only(handle: HANDLE) {
        let user = CurrentUser::read().unwrap();
        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: the instance's handle has READ_CONTROL (a duplex pipe's
        // generic read); the out pointers are writable.
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS);
        let _descriptor = LocalDescriptor(descriptor);
        assert!(
            !owner.is_null() && user.is(owner),
            "the current user owns it"
        );
        assert!(check_owner(handle).is_ok());
        assert!(!dacl.is_null(), "a null DACL lets everyone in");
        // SAFETY: the DACL lives in `descriptor`, freed after these reads.
        unsafe {
            assert_eq!((*dacl).AceCount, 1, "no ACE but the current user's");
            let mut ace: *mut c_void = std::ptr::null_mut();
            assert_ne!(GetAce(dacl, 0, &mut ace), 0);
            assert_eq!((*ace.cast::<ACE_HEADER>()).AceType, ACCESS_ALLOWED_ACE_TYPE);
            let sid = std::ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart);
            assert!(user.is(sid.cast()), "the ACE names the current user");
        }
    }

    #[test]
    fn pipe_dacl_is_current_user_only() {
        let endpoint = unique("dacl");
        let mut listener = blocking::Listener::bind(&endpoint).unwrap();
        assert_current_user_only(listener.pending_instance());
        let client = std::thread::spawn({
            let endpoint = endpoint.clone();
            move || blocking::Stream::connect(&endpoint).unwrap()
        });
        let accepted = listener.accept().unwrap();
        let _client = client.join().unwrap();
        // Every later instance carries the same DACL.
        assert_current_user_only(listener.pending_instance());
        drop(accepted);
    }

    #[test]
    fn a_pipe_another_user_owns_is_refused() {
        // BUILTIN\Administrators: an owner other than the current user that
        // an elevated process may give its pipe. SECURITY_MAX_SID_SIZE bytes.
        let mut admins = [0u32; 17];
        let mut size = std::mem::size_of_val(&admins) as u32;
        // SAFETY: the buffer is writable and `size` bytes long.
        let made = unsafe {
            CreateWellKnownSid(
                WinBuiltinAdministratorsSid,
                std::ptr::null_mut(),
                admins.as_mut_ptr().cast(),
                &mut size,
            )
        };
        assert_ne!(made, 0, "{}", io::Error::last_os_error());
        let endpoint = unique("owner");
        let name = endpoint.address().unwrap();
        let owned = create_instance_owned_by(&name, true, false, admins.as_mut_ptr().cast());
        let _instance = match owned {
            Ok(instance) => instance,
            Err(error) if error.raw_os_error() == Some(ERROR_INVALID_OWNER as i32) => {
                eprintln!("skipped: this token may not name Administrators as an owner");
                return;
            }
            Err(error) => panic!("{error}"),
        };
        match blocking::Stream::connect(&endpoint) {
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}"),
            Ok(_) => panic!("connected to a pipe another user owns"),
        }
    }

    #[test]
    fn pipe_names_carry_the_user_and_root_hashes() {
        let prefix = user_prefix().unwrap();
        let hex = prefix
            .strip_prefix(r"\\.\pipe\codesense-")
            .and_then(|rest| rest.strip_suffix('-'))
            .unwrap();
        assert_eq!(hex.len(), 16);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()), "{prefix}");

        let name = |endpoint: Endpoint| {
            endpoint
                .address()
                .unwrap()
                .into_os_string()
                .into_string()
                .unwrap()
        };
        assert_eq!(name(Endpoint::Mcp), format!("{prefix}mcp"));
        let root = PathBuf::from(r"C:\Data\Instances\Codesense");
        let activity = name(Endpoint::Activity(root.clone()));
        let rest = activity
            .strip_prefix(&format!("{prefix}activity-"))
            .unwrap();
        assert_eq!(rest.len(), 16, "{activity}");
        let session = name(Endpoint::SessionServer(root.clone()));
        assert!(
            session.starts_with(&format!("{prefix}session-server-")),
            "{session}"
        );
        assert!(session.ends_with(rest), "the same root hash: {session}");
        for same in [
            r"c:\data\instances\codesense",
            r"C:/Data/Instances/Codesense/",
            r"\\?\C:\Data\Instances\Codesense",
        ] {
            assert_eq!(name(Endpoint::Activity(same.into())), activity, "{same}");
        }
        assert_ne!(
            name(Endpoint::Activity(root.join("other"))),
            activity,
            "another root"
        );
        let ephemeral = |dir: &str| Endpoint::Ephemeral {
            dir: dir.into(),
            name: "relay-7".into(),
        };
        assert_eq!(name(ephemeral(r"C:\a")), format!("{prefix}relay-7"));
        assert_eq!(
            name(ephemeral(r"C:\b")),
            format!("{prefix}relay-7"),
            "dir is not used"
        );
    }
}
