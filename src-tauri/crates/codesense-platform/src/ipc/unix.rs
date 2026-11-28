// SPDX-License-Identifier: MIT
//! Unix: sockets on the paths CodeSense has always used. Binding checks an
//! existing file the way the activity ingress does (an owned socket, probed
//! before it is removed) and makes the new socket 0600, as the MCP server
//! does; peer credentials are the code the activity ingress and the session
//! server read them with.

use std::ffi::OsStr;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::Endpoint;
use crate::process::Pid;

/// The MCP server's socket in the codesense home.
const MCP_SOCKET: &str = "mcp.sock";
/// The activity ingress's socket in its host's root.
const ACTIVITY_SOCKET: &str = "activity.sock";
/// The session server's socket in its instance's root.
const SESSION_SERVER_SOCKET: &str = "pty-server.sock";

pub(super) fn address(endpoint: &Endpoint) -> io::Result<PathBuf> {
    Ok(match endpoint {
        Endpoint::Mcp => crate::dirs::codesense_home()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?
            .join(MCP_SOCKET),
        Endpoint::Activity(root) => root.join(ACTIVITY_SOCKET),
        Endpoint::SessionServer(root) => root.join(SESSION_SERVER_SOCKET),
        Endpoint::Ephemeral { dir, name } => dir.join(name),
    })
}

pub(super) fn from_wire(wire: &OsStr) -> io::Result<Endpoint> {
    let path = Path::new(wire);
    let name = path.file_name().and_then(OsStr::to_str).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a socket path", path.display()),
        )
    })?;
    Ok(Endpoint::Ephemeral {
        dir: path.parent().unwrap_or(Path::new("")).to_owned(),
        name: name.to_owned(),
    })
}

/// The socket file a listener bound, removed when the listener drops unless
/// another listener has replaced it since.
struct BoundSocket {
    path: PathBuf,
    identity: (u64, u64),
}

impl Drop for BoundSocket {
    fn drop(&mut self) {
        if file_identity(&self.path).ok() == Some(self.identity) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The file's device and inode, not following a link.
fn file_identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = std::fs::symlink_metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

/// Bind the endpoint's socket, 0600, replacing a stale one.
fn bind(endpoint: &Endpoint) -> io::Result<(net::UnixListener, BoundSocket)> {
    let path = endpoint.address()?;
    remove_stale(&path)?;
    let listener = net::UnixListener::bind(&path)?;
    let bound = BoundSocket {
        identity: file_identity(&path)?,
        path,
    };
    std::fs::set_permissions(&bound.path, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, bound))
}

/// Remove a socket left at `path` by a listener that is gone. Anything else
/// there stays: a live listener is `AddrInUse`, and a file that is not a
/// socket of this user's is `PermissionDenied`. A socket gone meanwhile needs
/// no removing.
fn remove_stale(path: &Path) -> io::Result<()> {
    let previous = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    // SAFETY: geteuid has no preconditions.
    if !previous.file_type().is_socket() || previous.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not a socket of this user's", path.display()),
        ));
    }
    let removed = match probe(path) {
        Ok(()) => return Err(in_use(path)),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Err(in_use(path)),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            match file_identity(path) {
                Ok(identity) if identity != (previous.dev(), previous.ino()) => {
                    return Err(in_use(path));
                }
                Ok(_) => std::fs::remove_file(path),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

/// Connect to the socket at `path` without waiting. Linux answers a listener
/// whose backlog is full with `WouldBlock`; macOS answers it with
/// `ConnectionRefused`, as it does a socket no one listens on, so there a
/// listener that busy reads as gone and its socket is replaced.
fn probe(path: &Path) -> io::Result<()> {
    // SAFETY: socket has no preconditions; a negative result is its error.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the descriptor is open and owned by nothing else.
    let socket = unsafe { OwnedFd::from_raw_fd(fd) };
    // SAFETY: fcntl reads and sets the open descriptor's flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: an all-zero sockaddr_un is a valid value.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = path.as_os_str().as_bytes();
    // The path and its NUL must fit.
    if bytes.len() >= address.sun_path.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is too long for a socket path", path.display()),
        ));
    }
    for (slot, &byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = byte as libc::c_char;
    }
    let length = std::mem::size_of_val(&address) as libc::socklen_t;
    // SAFETY: the address is a whole sockaddr_un of `length` bytes.
    let connected = unsafe {
        libc::connect(
            socket.as_raw_fd(),
            std::ptr::addr_of!(address).cast(),
            length,
        )
    };
    if connected != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn in_use(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::AddrInUse,
        format!("a listener already serves {}", path.display()),
    )
}

/// The pid at the other end of the socket `fd`, when it runs as this user.
#[cfg(target_os = "linux")]
fn peer_pid(fd: RawFd) -> io::Result<Pid> {
    // SAFETY: an all-zero ucred is a valid value.
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of_val(&credentials) as libc::socklen_t;
    // SAFETY: SO_PEERCRED fills the bounded credentials buffer.
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    same_user(credentials.uid)?;
    positive_pid(credentials.pid)
}

/// The pid at the other end of the socket `fd`, when it runs as this user.
#[cfg(target_os = "macos")]
fn peer_pid(fd: RawFd) -> io::Result<Pid> {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: getpeereid writes the two scalar credentials.
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    same_user(uid)?;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    // Darwin LOCAL_PEERPID (level SOL_LOCAL 0, option 2) is a
    // kernel-authenticated pid (sys/un.h).
    // SAFETY: the option fills the bounded pid.
    let result =
        unsafe { libc::getsockopt(fd, 0, 2, (&mut pid as *mut libc::pid_t).cast(), &mut len) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    positive_pid(pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn peer_pid(_: RawFd) -> io::Result<Pid> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer credentials are not read on this OS",
    ))
}

fn same_user(uid: libc::uid_t) -> io::Result<()> {
    // SAFETY: geteuid has no preconditions.
    if uid != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the peer runs as another user",
        ));
    }
    Ok(())
}

fn positive_pid(pid: libc::pid_t) -> io::Result<Pid> {
    if pid <= 0 {
        return Err(io::Error::other("the peer has no pid"));
    }
    Ok(Pid::from_raw(pid as u32))
}

pub(crate) struct Listener {
    listener: tokio::net::UnixListener,
    _bound: BoundSocket,
}

impl Listener {
    pub(crate) fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        let (listener, bound) = bind(endpoint)?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener: tokio::net::UnixListener::from_std(listener)?,
            _bound: bound,
        })
    }

    pub(crate) async fn accept(&mut self) -> io::Result<Stream> {
        let (stream, _) = self.listener.accept().await?;
        Ok(Stream(stream))
    }
}

pub(crate) struct Stream(tokio::net::UnixStream);

impl Stream {
    pub(crate) async fn connect(endpoint: &Endpoint) -> io::Result<Self> {
        tokio::net::UnixStream::connect(endpoint.address()?)
            .await
            .map(Self)
    }

    pub(crate) fn peer_pid(&self) -> io::Result<Pid> {
        peer_pid(self.0.as_raw_fd())
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

pub(crate) mod blocking {
    use std::io::{Read, Write};
    use std::time::Duration;

    use super::*;

    pub(crate) struct Listener {
        listener: net::UnixListener,
        _bound: BoundSocket,
    }

    impl Listener {
        pub(crate) fn bind(endpoint: &Endpoint) -> io::Result<Self> {
            let (listener, bound) = bind(endpoint)?;
            Ok(Self {
                listener,
                _bound: bound,
            })
        }

        pub(crate) fn accept(&mut self) -> io::Result<Stream> {
            let (stream, _) = self.listener.accept()?;
            Ok(Stream(stream))
        }
    }

    pub(crate) struct Stream(net::UnixStream);

    impl Stream {
        pub(crate) fn connect(endpoint: &Endpoint) -> io::Result<Self> {
            net::UnixStream::connect(endpoint.address()?).map(Self)
        }

        pub(crate) fn peer_pid(&self) -> io::Result<Pid> {
            peer_pid(self.0.as_raw_fd())
        }

        pub(crate) fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
            self.0.set_read_timeout(timeout)
        }

        pub(crate) fn set_write_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
            self.0.set_write_timeout(timeout)
        }

        pub(crate) fn try_clone(&self) -> io::Result<Self> {
            self.0.try_clone().map(Self)
        }

        pub(crate) fn shutdown(&self) -> io::Result<()> {
            self.0.shutdown(std::net::Shutdown::Both)
        }
    }

    /// A blocking socket's timeout shows as `WouldBlock`; say what it is.
    fn timed_out(error: io::Error) -> io::Error {
        if error.kind() == io::ErrorKind::WouldBlock {
            io::Error::new(io::ErrorKind::TimedOut, error)
        } else {
            error
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf).map_err(timed_out)
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf).map_err(timed_out)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paths today's listeners and clients use, as literals: the MCP
    /// server's and the bridge's `~/.codesense/mcp.sock`, the activity
    /// ingress's `<root>/activity.sock` and the session server's
    /// `<root>/pty-server.sock`; an ephemeral socket is the file the caller
    /// names. The wire form is the same path.
    #[test]
    fn unix_endpoint_paths_are_unchanged() {
        let home = ::dirs::home_dir().unwrap();
        let root = PathBuf::from("/var/app/root");
        let cases = [
            (Endpoint::Mcp, home.join(".codesense/mcp.sock")),
            (
                Endpoint::Activity(root.clone()),
                PathBuf::from("/var/app/root/activity.sock"),
            ),
            (
                Endpoint::SessionServer(root),
                PathBuf::from("/var/app/root/pty-server.sock"),
            ),
            (
                Endpoint::Ephemeral {
                    dir: PathBuf::from("/tmp/relay.Ab12"),
                    name: "s".into(),
                },
                PathBuf::from("/tmp/relay.Ab12/s"),
            ),
        ];
        for (endpoint, path) in cases {
            assert_eq!(endpoint.address().unwrap(), path, "{endpoint:?}");
            assert_eq!(endpoint.to_wire().unwrap(), path.into_os_string());
        }
    }
}
