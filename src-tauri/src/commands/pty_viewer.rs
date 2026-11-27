// SPDX-License-Identifier: MIT
//! Terminal viewer identity, one per window. Each terminal host keeps a viewer's own focus,
//! scroll and requested size, so every window is its own viewer there: `main` is `app` (the id
//! the app has always used, so a host's layout under it stays valid across app restarts) and
//! any other window is `app:<installId>:<label>`. The install segment keeps two apps sharing
//! one host apart. Each viewer has its own viewport and its own boot slot.
//!
//! This is the one place that spells those ids (`codesense-guards` `windows_viewer_guard`).
//! A caller with no calling window (an MCP verb, a routine, a restore) acts as `main`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use codesense_pty_core::domain::{ClientBootId, ViewerId, ViewportId};

use crate::windows::is_main;

/// `main`'s viewer: the one the app used before it had other windows.
const MAIN_VIEWER: &str = "app";

/// `main`'s viewport.
const MAIN_VIEWPORT: &str = "webview";

/// Why a window other than `main` cannot show terminals without an install id.
pub(crate) const INSTALL_ID_UNREADABLE: &str =
    "this install's id could not be read, so only the main window can show terminals";

/// This install's id (the routines host id), read once at startup; it keeps two installs'
/// windows apart on one host. Unreadable, only `main` has a viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallId(Option<String>);

impl InstallId {
    pub(crate) fn new(id: impl Into<String>) -> Self {
        Self(Some(id.into())).checked()
    }

    pub(crate) fn unreadable() -> Self {
        Self(None)
    }

    /// An empty id, or one with a `:`, would blur the viewer prefix: it reads as unreadable.
    fn checked(self) -> Self {
        Self(self.0.filter(|id| !id.is_empty() && !id.contains(':')))
    }

    /// The prefix of every viewer this install's windows other than `main` use on a host.
    pub(crate) fn satellite_prefix(&self) -> Option<String> {
        self.0.as_ref().map(|id| format!("{MAIN_VIEWER}:{id}:"))
    }
}

/// `main`'s viewer, which every caller with no calling window uses.
pub(crate) fn main_viewer() -> ViewerId {
    ViewerId::new(MAIN_VIEWER)
}

/// The viewer of the window labelled `label`: `app` for `main`, else
/// `app:<installId>:<label>`. A window other than `main` is refused when the install id is
/// unreadable.
pub(crate) fn viewer_for(label: &str, install: &InstallId) -> Result<ViewerId, String> {
    if is_main(label) {
        return Ok(main_viewer());
    }
    let prefix = install
        .satellite_prefix()
        .ok_or_else(|| INSTALL_ID_UNREADABLE.to_string())?;
    Ok(ViewerId::new(format!("{prefix}{label}")))
}

/// Whether `viewer` is `main`'s.
pub(crate) fn is_main_viewer(viewer: &ViewerId) -> bool {
    viewer.as_str() == MAIN_VIEWER
}

/// The viewport a viewer shows a session through: `webview` for `main`, one of its own for
/// any other window, so two windows showing one session never replace each other's stream.
pub(crate) fn viewport_for(viewer: &ViewerId) -> ViewportId {
    if is_main_viewer(viewer) {
        ViewportId::new(MAIN_VIEWPORT)
    } else {
        ViewportId::new(format!("{MAIN_VIEWPORT}:{viewer}"))
    }
}

/// The app launch each viewer last asked the hosts' layout under, so a read on its behalf
/// (the MCP viewer state) asks under the same one: a read under another would prune the
/// exited tabs it still shows.
#[derive(Default)]
pub(crate) struct Boots(Mutex<HashMap<ViewerId, ClientBootId>>);

impl Boots {
    /// Record `id` as `viewer`'s boot. True for a new boot (its first ask, or a reload).
    pub(crate) fn adopt(&self, viewer: &ViewerId, id: &ClientBootId) -> bool {
        let previous = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(viewer.clone(), id.clone());
        previous.as_ref() != Some(id)
    }

    pub(crate) fn of(&self, viewer: &ViewerId) -> Option<ClientBootId> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(viewer)
            .cloned()
    }

    /// Forget `viewer`'s boot (its window closed).
    pub(crate) fn forget(&self, viewer: &ViewerId) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(viewer);
    }
}

static BOOTS: LazyLock<Boots> = LazyLock::new(Boots::default);

/// The app's boot slots, one per viewer.
pub(crate) fn boots() -> &'static Boots {
    &BOOTS
}

/// `main`'s boot, which every caller with no calling window reads under; `None` before
/// `main` first read the layout.
pub(crate) fn main_boot() -> Option<ClientBootId> {
    BOOTS.of(&main_viewer())
}

/// What one layout read by a viewer sets off. Only `main`'s reads have app-wide effects:
/// a new boot of `main` is the frontend re-registering (announce the sessions source and
/// re-sync the connection manager), and its reads restore the launch and claim the held
/// sessions. Another window's read only adopts its own boot slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LayoutRead {
    /// The viewer's boot changed (its first ask, or a reload).
    pub(crate) new_boot: bool,
    /// The read is `main`'s, so it restores the launch and claims the held sessions.
    pub(crate) app_wide: bool,
}

impl LayoutRead {
    /// Announce the sessions source and re-sync the connection manager.
    pub(crate) fn announces(&self) -> bool {
        self.app_wide && self.new_boot
    }
}

/// Adopt `boot` as `viewer`'s in `boots` and say what the read sets off.
pub(crate) fn layout_read(boots: &Boots, viewer: &ViewerId, boot: &ClientBootId) -> LayoutRead {
    LayoutRead {
        new_boot: boots.adopt(viewer, boot),
        app_wide: is_main_viewer(viewer),
    }
}

#[cfg(test)]
mod helper_tests;

#[cfg(test)]
mod boot_tests;
