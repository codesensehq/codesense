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
//! The answer blocks for up to [`TIMEOUT`] on Linux: call it off the main
//! thread.

use std::time::Duration;

/// How long the Linux read waits for the session bus.
pub const TIMEOUT: Duration = Duration::from_millis(500);

/// Whether a tray item built now would show in a tray.
pub fn status_notifier_host_registered() -> bool {
    host_registered(read_host_registered)
}

/// The answer from one `read` of the watcher's property: false on any error.
pub fn host_registered<E>(read: impl FnOnce(Duration) -> Result<bool, E>) -> bool {
    read(TIMEOUT).unwrap_or(false)
}

#[cfg(all(target_os = "linux", feature = "tray-host"))]
fn read_host_registered(timeout: Duration) -> Result<bool, dbus::Error> {
    linux::read(dbus::blocking::Connection::new_session()?, timeout)
}

#[cfg(all(target_os = "linux", not(feature = "tray-host")))]
fn read_host_registered(_timeout: Duration) -> Result<bool, &'static str> {
    Err("built without the session-bus read")
}

#[cfg(not(target_os = "linux"))]
fn read_host_registered(_timeout: Duration) -> Result<bool, std::convert::Infallible> {
    Ok(true)
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
    pub(super) fn read(connection: Connection, timeout: Duration) -> Result<bool, dbus::Error> {
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

    #[test]
    fn an_error_reads_as_no_host() {
        assert!(!host_registered(|_| Err("no session bus")));
        assert!(host_registered(|_| Ok::<_, ()>(true)));
        assert!(!host_registered(|_| Ok::<_, ()>(false)));
    }

    #[test]
    fn the_read_is_bounded_by_the_timeout() {
        let mut asked = None;
        host_registered(|timeout| {
            asked = Some(timeout);
            Ok::<_, ()>(true)
        });
        assert_eq!(asked, Some(TIMEOUT));
        assert!(TIMEOUT <= Duration::from_secs(1));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn elsewhere_a_tray_always_shows() {
        assert!(status_notifier_host_registered());
    }

    /// A bus that can't be reached, injected by address, is no host.
    #[cfg(all(target_os = "linux", feature = "tray-host"))]
    #[test]
    fn an_unreachable_bus_is_no_host() {
        let dir = std::env::temp_dir().join(format!("no-bus-{}", std::process::id()));
        let address = format!("unix:path={}/bus", dir.display());
        assert!(!host_registered(|timeout| {
            linux::read(linux::connect(&address)?, timeout)
        }));
    }
}
