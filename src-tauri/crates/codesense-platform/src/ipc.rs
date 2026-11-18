// SPDX-License-Identifier: MIT
//! Local IPC between processes of this user: a logical [`Endpoint`] that a
//! [`LocalListener`] binds and a [`LocalStream`] connects to, in async
//! (tokio) and [`blocking`] forms.
//!
//! On unix an endpoint is a Unix socket on the path CodeSense has always
//! used, created mode 0600; a stale socket file left by a process that died
//! is replaced, a live one is [`io::ErrorKind::AddrInUse`]. On Windows it is
//! the named pipe `\\.\pipe\codesense-<user>-<endpoint>[-<root>]` (`<user>`
//! and `<root>` are hashes of the user's SID and the root path), whose every
//! instance grants only the current user, names the current user as its
//! owner and refuses remote clients; the first instance is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a name already served, by this user or
//! another, is `AddrInUse`. A client refuses a pipe another user owns with
//! [`io::ErrorKind::PermissionDenied`].
//!
//! [`LocalStream::peer_pid`] is the one place that says which process is at
//! the other end of a connection.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::process::Pid;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use self::unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as sys;

/// A place a local listener serves, named by what it is rather than where.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Endpoint {
    /// The app's MCP server: `~/.codesense/mcp.sock` on unix.
    Mcp,
    /// The activity ingress of the host rooted at this app-data root:
    /// `<root>/activity.sock` on unix.
    Activity(PathBuf),
    /// The session server of the instance rooted at this app-data root:
    /// `<root>/pty-server.sock` on unix.
    SessionServer(PathBuf),
    /// A per-launch endpoint: on unix the socket `name` in the caller's
    /// `dir`; on Windows `dir` is not used and `name` keeps the pipe unique,
    /// so pick one no other launch uses. `name` is one path component.
    Ephemeral { dir: PathBuf, name: String },
}

impl Endpoint {
    /// Where the endpoint lives on this OS: the socket path on unix, the pipe
    /// name on Windows. Fails when the home directory (for [`Endpoint::Mcp`])
    /// or, on Windows, the current user cannot be read, or when an ephemeral
    /// name is not one path component.
    pub fn address(&self) -> io::Result<PathBuf> {
        if let Self::Ephemeral { name, .. } = self {
            check_ephemeral_name(name)?;
        }
        sys::address(self)
    }

    /// The endpoint as one string for an environment variable or an argument
    /// (`CODESENSE_MCP_SOCK`, a relay or askpass argument): its address, so on
    /// unix exactly the socket path passed today.
    pub fn to_wire(&self) -> io::Result<OsString> {
        self.address().map(PathBuf::into_os_string)
    }

    /// The endpoint a [`to_wire`](Self::to_wire) string names, as an
    /// [`Endpoint::Ephemeral`] with the same address: a socket path on unix;
    /// on Windows a pipe name of this user's.
    pub fn from_wire(wire: &OsStr) -> io::Result<Self> {
        sys::from_wire(wire)
    }
}

fn check_ephemeral_name(name: &str) -> io::Result<()> {
    let bad = name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']);
    if bad {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name:?} is not an endpoint name"),
        ));
    }
    Ok(())
}

/// A bound endpoint, accepting connections. Bind and use it inside a tokio
/// runtime with I/O enabled. On unix, dropping it removes its socket file
/// (unless another listener has replaced it); on Windows the pipe name is
/// free again once the listener and every stream it accepted are dropped.
pub struct LocalListener(sys::Listener);

impl LocalListener {
    /// Bind `endpoint`. [`io::ErrorKind::AddrInUse`] when another listener,
    /// in this process or another, serves it.
    pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        sys::Listener::bind(endpoint).map(Self)
    }

    /// The next connection.
    pub async fn accept(&mut self) -> io::Result<LocalStream> {
        self.0.accept().await.map(LocalStream)
    }
}

/// One connection, from either end. On Windows, dropping it closes the pipe
/// when the runtime next runs: the read in flight is cancelled first.
pub struct LocalStream(sys::Stream);

impl LocalStream {
    /// Connect to the listener serving `endpoint`. On Windows a connection
    /// waits, up to a few seconds, while every pipe instance is busy, and a
    /// pipe another user owns is [`io::ErrorKind::PermissionDenied`].
    pub async fn connect(endpoint: &Endpoint) -> io::Result<Self> {
        sys::Stream::connect(endpoint).await.map(Self)
    }

    /// The process at the other end: the client, on a stream a listener
    /// accepted; the listener's process, on a stream that connected. On
    /// unix a peer running as another user is
    /// [`io::ErrorKind::PermissionDenied`]. On Windows it is only the pid:
    /// the user was checked on the way in, by the listener's DACL, which
    /// lets no other user's client open it, and by `connect`, which refuses
    /// a pipe another user owns.
    pub fn peer_pid(&self) -> io::Result<Pid> {
        self.0.peer_pid()
    }
}

impl AsyncRead for LocalStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl AsyncWrite for LocalStream {
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

/// The same listener and stream for callers without a runtime.
pub mod blocking {
    use std::io::{self, Read, Write};

    use super::{sys, Endpoint};
    use crate::process::Pid;

    /// A bound endpoint, accepting connections; as [`super::LocalListener`].
    pub struct LocalListener(sys::blocking::Listener);

    impl LocalListener {
        /// Bind `endpoint`. [`io::ErrorKind::AddrInUse`] when another
        /// listener, in this process or another, serves it.
        pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
            sys::blocking::Listener::bind(endpoint).map(Self)
        }

        /// Wait for the next connection.
        pub fn accept(&mut self) -> io::Result<LocalStream> {
            self.0.accept().map(LocalStream)
        }
    }

    /// One connection, from either end. On Windows a read and a write on
    /// the same stream run one after the other, never at once: use the
    /// async [`super::LocalStream`] to read and write concurrently.
    pub struct LocalStream(sys::blocking::Stream);

    impl LocalStream {
        /// Connect to the listener serving `endpoint`; as
        /// [`super::LocalStream::connect`]. On Windows a connection waits, up
        /// to a few seconds, while every pipe instance is busy, and a pipe
        /// another user owns is [`io::ErrorKind::PermissionDenied`].
        pub fn connect(endpoint: &Endpoint) -> io::Result<Self> {
            sys::blocking::Stream::connect(endpoint).map(Self)
        }

        /// The process at the other end; as [`super::LocalStream::peer_pid`].
        pub fn peer_pid(&self) -> io::Result<Pid> {
            self.0.peer_pid()
        }
    }

    impl Read for LocalStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for LocalStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
}
