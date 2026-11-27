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
use std::sync::{Arc, LazyLock, Mutex};

use codesense_pty_core::domain::{ClientBootId, TerminalDomain, ViewerId, ViewportId};
use codesense_pty_core::TerminalHost;
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::host_connection_manager::{
    ConnectedBackendSnapshot, HostConnectionManager, HostConnectionState, ManagerEvent,
};
use crate::terminal::session_server::{SessionServerClient, SessionServerState};
use crate::windows::is_main;

/// `main`'s viewer: the one the app used before it had other windows.
const MAIN_VIEWER: &str = "app";

/// `main`'s viewport.
const MAIN_VIEWPORT: &str = "webview";

/// Why a window other than `main` cannot show terminals without an install id.
pub(crate) const INSTALL_ID_UNREADABLE: &str =
    "this install's id could not be read, so only the main window can show terminals";

/// Why a host cannot take a window's terminals: its server predates viewer detach.
pub(crate) const UPDATE_TO_MOVE: &str =
    "Update the terminal server to move terminals between windows";

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

    /// This install's id from disk: the routines host id under the CodeSense home, the id
    /// `desktop_identity` names this install by (minted on first use).
    pub(crate) fn read_local() -> Self {
        let id = crate::commands::paths::codesense_home_dir()
            .ok_or_else(|| "no CodeSense home".to_string())
            .and_then(|home| {
                crate::routines::host::local_host_id(&home).map_err(|error| error.to_string())
            });
        match id {
            Ok(id) => Self::new(id),
            Err(error) => {
                log::warn!(target: "pty", "{INSTALL_ID_UNREADABLE}: {error}");
                Self::unreadable()
            }
        }
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

/// The install id held in app state; unreadable when none was read.
pub(crate) fn install_id<R: Runtime>(app: &AppHandle<R>) -> InstallId {
    app.try_state::<InstallId>()
        .map_or_else(InstallId::unreadable, |id| id.inner().clone())
}

/// The viewer of the window a command was called from.
pub(crate) fn window_viewer<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<ViewerId, String> {
    viewer_for(
        tauri::WebviewWindow::label(window),
        &install_id(window.app_handle()),
    )
}

/// The viewport the window a command was called from shows sessions through.
pub(crate) fn window_viewport<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<ViewportId, String> {
    window_viewer(window).map(|viewer| viewport_for(&viewer))
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

/// A terminal host as the windows' viewers meet it: whether it can forget a viewer, and the
/// requests that do.
pub(crate) trait ViewerHost: Send + Sync {
    /// Whether the host forgets viewers (`ViewerDetachV1`; the in-process host always does).
    fn forgets_viewers(&self) -> bool;

    /// Forget `viewer`: it never owns a session's size again.
    fn forget_viewer(&self, viewer: &ViewerId) -> Result<(), String>;

    /// Forget every viewer under `prefix` but those in `keep`.
    fn forget_viewers_but(&self, keep: &[ViewerId], prefix: &str) -> Result<(), String>;
}

impl ViewerHost for SessionServerClient {
    fn forgets_viewers(&self) -> bool {
        self.supports_viewer_detach()
    }

    fn forget_viewer(&self, viewer: &ViewerId) -> Result<(), String> {
        TerminalDomain::detach_viewer(self, viewer).map_err(|error| error.to_string())
    }

    fn forget_viewers_but(&self, keep: &[ViewerId], prefix: &str) -> Result<(), String> {
        TerminalDomain::retain_viewers(self, keep, prefix).map_err(|error| error.to_string())
    }
}

impl ViewerHost for TerminalHost {
    fn forgets_viewers(&self) -> bool {
        true
    }

    fn forget_viewer(&self, viewer: &ViewerId) -> Result<(), String> {
        TerminalDomain::detach_viewer(self, viewer).map_err(|error| error.to_string())
    }

    fn forget_viewers_but(&self, keep: &[ViewerId], prefix: &str) -> Result<(), String> {
        TerminalDomain::retain_viewers(self, keep, prefix).map_err(|error| error.to_string())
    }
}

/// Whether terminals can move between windows on `host`. A server without viewer detach
/// would keep a closed window's viewer (and could hand it the size), so it is refused with
/// [`UPDATE_TO_MOVE`]; the app never sends it a detach.
pub(crate) fn can_move_terminals(host: &dyn ViewerHost) -> Result<(), String> {
    if host.forgets_viewers() {
        Ok(())
    } else {
        Err(UPDATE_TO_MOVE.to_string())
    }
}

/// Forget the closed window `label`'s viewer: its boot slot now, and on each of `hosts`
/// that can forget it, one request per host on a thread of its own so the caller never
/// waits on a host. `main` keeps its viewer. A host offline now keeps the viewer until the
/// sweep on its next connect. Returns the requests started.
pub(crate) fn forget_window(
    boots: &Boots,
    hosts: Vec<Arc<dyn ViewerHost>>,
    label: &str,
    install: &InstallId,
) -> usize {
    if is_main(label) {
        return 0;
    }
    let Ok(viewer) = viewer_for(label, install) else {
        return 0;
    };
    boots.forget(&viewer);
    let mut started = 0;
    for host in hosts {
        if can_move_terminals(&*host).is_err() {
            continue;
        }
        let viewer = viewer.clone();
        let spawned = spawn_named("viewer-detach", move || {
            if let Err(error) = host.forget_viewer(&viewer) {
                log::warn!(target: "pty", "detach viewer {viewer}: {error}");
            }
        });
        match spawned {
            Ok(_) => started += 1,
            Err(error) => log::warn!(target: "pty", "detach viewer: {error}"),
        }
    }
    started
}

/// Run `work` on a thread named `name`. The builder is called by path so the source guards'
/// call graph resolves it.
fn spawn_named(name: &str, work: impl FnOnce() + Send + 'static) -> std::io::Result<()> {
    let builder = std::thread::Builder::name(std::thread::Builder::new(), name.to_string());
    builder.spawn(work).map(drop)
}

/// The `Destroyed` branch: forget the closed window's viewer on every connected host, off
/// the event loop.
pub(crate) fn window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if is_main(label) {
        return;
    }
    let (app, label) = (app.clone(), label.to_string());
    let spawned = spawn_named("viewer-detach", move || {
        let hosts = crate::commands::pty_backend::connected_viewer_hosts(&app);
        forget_window(boots(), hosts, &label, &install_id(&app));
    });
    if let Err(error) = spawned {
        log::warn!(target: "pty", "detach viewer of a closed window: {error}");
    }
}

/// The labels of the windows a later run restores, whose viewers a sweep keeps.
pub(crate) trait RestoredLabels: Send + Sync {
    fn labels(&self) -> Vec<String>;
}

/// No window is restored yet, so a sweep keeps only this run's open windows.
pub(crate) struct NoRestoredLabels;

impl RestoredLabels for NoRestoredLabels {
    fn labels(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Forget on `host` the viewers a crash or a disconnect left behind: every viewer of this
/// install's windows but `main`'s and those labelled in `keep`, in one request under the
/// prefix `app:<installId>:`, which never matches `app`, `dashboard` or another install's
/// viewers. `Ok(false)` when nothing was sent: the install id is unreadable, or the host
/// cannot forget viewers.
pub(crate) fn sweep_host(
    host: &dyn ViewerHost,
    install: &InstallId,
    keep: &[String],
) -> Result<bool, String> {
    let Some(prefix) = install.satellite_prefix() else {
        return Ok(false);
    };
    if can_move_terminals(host).is_err() {
        return Ok(false);
    }
    let keep: Vec<ViewerId> = keep
        .iter()
        .filter(|label| !is_main(label))
        .flat_map(|label| viewer_for(label, install))
        .collect();
    host.forget_viewers_but(&keep, &prefix)?;
    Ok(true)
}

/// The labels a sweep keeps now: the restored windows' and this run's open ones.
fn kept_labels<R: Runtime>(app: &AppHandle<R>, restored: &dyn RestoredLabels) -> Vec<String> {
    let mut labels = restored.labels();
    labels.extend(app.webview_windows().into_keys());
    labels
}

/// Sweep the host `connected` names, on a thread of its own.
fn sweep_in_background<R: Runtime>(
    app: &AppHandle<R>,
    connected: impl FnOnce(&AppHandle<R>) -> Option<Arc<dyn ViewerHost>> + Send + 'static,
) {
    let app = app.clone();
    let spawned = spawn_named("viewer-sweep", move || {
        let Some(host) = connected(&app) else {
            return;
        };
        let keep = kept_labels(&app, &NoRestoredLabels);
        if let Err(error) = sweep_host(&*host, &install_id(&app), &keep) {
            log::warn!(target: "pty", "sweep left-behind viewers: {error}");
        }
    });
    if let Err(error) = spawned {
        log::warn!(target: "pty", "sweep left-behind viewers: {error}");
    }
}

/// Sweep each host as it connects: this Mac's session server at boot and on each
/// reconnect, and each machine's server on each connect.
pub(crate) fn sweep_on_connect<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<SessionServerState>() {
        let observed = app.clone();
        state.on_connected(Arc::new(move |client: &Arc<SessionServerClient>| {
            let client = client.clone();
            sweep_in_background(&observed, move |_| Some(client as Arc<dyn ViewerHost>));
        }));
    }
    if let Some(manager) = app.try_state::<HostConnectionManager>() {
        let observed = app.clone();
        manager.subscribe(Arc::new(move |event: ManagerEvent| {
            if !matches!(event.state, HostConnectionState::Connected { .. }) {
                return;
            }
            let machine = event.machine_id.clone();
            sweep_in_background(&observed, move |app| {
                let manager = app.try_state::<HostConnectionManager>()?;
                let Ok(backend) = manager.connected_backend(&machine) else {
                    return None;
                };
                Some(ConnectedBackendSnapshot::client(&backend) as Arc<dyn ViewerHost>)
            });
        }));
    }
}

#[cfg(test)]
mod helper_tests;

#[cfg(test)]
mod boot_tests;

#[cfg(test)]
mod detach_tests;

#[cfg(test)]
mod caller_tests;

#[cfg(test)]
mod command_tests;

#[cfg(test)]
mod old_server_tests;
