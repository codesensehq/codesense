// SPDX-License-Identifier: MIT
//! Whether a tray item shows anywhere.
//!
//! - Linux: an AppIndicator item shows only while a StatusNotifier host (the
//!   panel's tray, or GNOME's AppIndicator extension) is registered with the
//!   session bus's `org.kde.StatusNotifierWatcher`. Stock GNOME has none, so an
//!   item built there shows nowhere. The answer is read from the watcher's
//!   `IsStatusNotifierHostRegistered` property within [`TIMEOUT`]; no bus, no
//!   watcher, a timeout or any other error is false, and so is a build without
//!   the `tray-host` feature (the sidecars), which never reads the bus.
//! - macOS and Windows: true. The menu bar and the notification area are always
//!   there.
//!
//! A [`HostCheck`] keeps its session-bus connection between answers. Until a
//! connect succeeds, every answer tries it again, and a connect waits up to
//! libdbus's default reply timeout (about 25 s), answering false meanwhile; once
//! connected, each answer is the read alone, bounded by [`TIMEOUT`], until the
//! connection drops. Either can block for that long: ask off the main thread.

use std::time::Duration;

/// How long the Linux read waits for the session bus.
pub const TIMEOUT: Duration = Duration::from_millis(500);

/// Whether a tray item built now would show in a tray, on a connection of its
/// own. A caller that asks repeatedly keeps a [`HostCheck`] instead.
pub fn status_notifier_host_registered() -> bool {
    HostCheck::new().registered()
}

/// Asks whether a tray host is registered, keeping the connection it opened
/// for the next answer.
#[derive(Default)]
pub struct HostCheck {
    #[cfg(all(target_os = "linux", feature = "tray-host"))]
    connection: Option<dbus::blocking::Connection>,
}

impl HostCheck {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a tray item built now would show in a tray.
    #[cfg(all(target_os = "linux", feature = "tray-host"))]
    pub fn registered(&mut self) -> bool {
        registered_on(
            &mut self.connection,
            dbus::blocking::Connection::new_session,
            linux::read,
            |connection| connection.channel().is_connected(),
        )
    }

    /// Whether a tray item built now would show in a tray: never, in a build
    /// without the session-bus read.
    #[cfg(all(target_os = "linux", not(feature = "tray-host")))]
    pub fn registered(&mut self) -> bool {
        false
    }

    /// Whether a tray item built now would show in a tray: always.
    #[cfg(not(target_os = "linux"))]
    pub fn registered(&mut self) -> bool {
        true
    }
}

/// One answer on the connection in `kept`, opened with `connect` when there is
/// none: `read` within [`TIMEOUT`], false on any error. The connection is kept
/// while `alive` says it is still connected, so a missing watcher (an error on
/// a good connection) doesn't reconnect, and a dropped bus does next time.
pub fn registered_on<C, E>(
    kept: &mut Option<C>,
    connect: impl FnOnce() -> Result<C, E>,
    read: impl FnOnce(&C, Duration) -> Result<bool, E>,
    alive: impl FnOnce(&C) -> bool,
) -> bool {
    let connection = match kept.take() {
        Some(connection) => connection,
        None => match connect() {
            Ok(connection) => connection,
            Err(_) => return false,
        },
    };
    let answer = read(&connection, TIMEOUT).unwrap_or(false);
    if alive(&connection) {
        *kept = Some(connection);
    }
    answer
}

#[cfg(all(target_os = "linux", feature = "tray-host"))]
mod linux {
    use std::time::Duration;

    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;

    const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    const WATCHER_PATH: &str = "/StatusNotifierWatcher";
    const HOST_REGISTERED: &str = "IsStatusNotifierHostRegistered";

    /// The watcher's `IsStatusNotifierHostRegistered` on `connection`.
    pub(super) fn read(connection: &Connection, timeout: Duration) -> Result<bool, dbus::Error> {
        connection
            .with_proxy(WATCHER, WATCHER_PATH, timeout)
            .get::<bool>(WATCHER, HOST_REGISTERED)
    }

    /// A connection to the bus at `address`, as a test injects one.
    #[cfg(test)]
    pub(super) fn connect(address: &str) -> Result<Connection, dbus::Error> {
        let mut channel = dbus::channel::Channel::open_private(address)?;
        channel.register()?;
        Ok(Connection::from(channel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// One answer through `registered_on`, counting connects.
    fn answer(
        kept: &mut Option<u32>,
        connects: &Cell<u32>,
        connect: Result<u32, &'static str>,
        read: Result<bool, &'static str>,
        alive: bool,
    ) -> bool {
        registered_on(
            kept,
            || {
                connects.set(connects.get() + 1);
                connect
            },
            |_, timeout| {
                assert_eq!(timeout, TIMEOUT, "the read is bounded by the timeout");
                read
            },
            |_| alive,
        )
    }

    #[test]
    fn an_error_reads_as_no_host() {
        let connects = Cell::new(0);
        assert!(!answer(
            &mut None,
            &connects,
            Err("no session bus"),
            Ok(true),
            true
        ));
        assert!(!answer(
            &mut None,
            &connects,
            Ok(1),
            Err("no watcher"),
            true
        ));
        assert!(answer(&mut None, &connects, Ok(1), Ok(true), true));
        assert!(!answer(&mut None, &connects, Ok(1), Ok(false), true));
        assert!(TIMEOUT <= Duration::from_secs(1));
    }

    /// The connection is opened once and reused while it stays connected, a
    /// missing watcher included; a dropped one is opened again next time.
    #[test]
    fn the_connection_is_kept_until_it_drops() {
        let connects = Cell::new(0);
        let mut kept = None;
        assert!(answer(&mut kept, &connects, Ok(7), Ok(true), true));
        assert_eq!((connects.get(), kept), (1, Some(7)));
        assert!(!answer(
            &mut kept,
            &connects,
            Ok(8),
            Err("no watcher"),
            true
        ));
        assert_eq!(
            (connects.get(), kept),
            (1, Some(7)),
            "a read error keeps it"
        );
        assert!(!answer(
            &mut kept,
            &connects,
            Ok(8),
            Err("disconnected"),
            false
        ));
        assert_eq!((connects.get(), kept), (1, None), "a dropped one goes");
        assert!(answer(&mut kept, &connects, Ok(9), Ok(true), true));
        assert_eq!((connects.get(), kept), (2, Some(9)), "and is opened again");
        assert!(!answer(&mut None, &connects, Err("no bus"), Ok(true), true));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn elsewhere_a_tray_always_shows() {
        assert!(status_notifier_host_registered());
        assert!(HostCheck::new().registered());
    }

    /// A bus that can't be reached, injected by address, is no host.
    #[cfg(all(target_os = "linux", feature = "tray-host"))]
    #[test]
    fn an_unreachable_bus_is_no_host() {
        let dir = std::env::temp_dir().join(format!("no-bus-{}", std::process::id()));
        let address = format!("unix:path={}/bus", dir.display());
        let mut kept = None;
        assert!(!registered_on(
            &mut kept,
            || linux::connect(&address),
            linux::read,
            |connection| connection.channel().is_connected(),
        ));
        assert!(kept.is_none());
    }
}
