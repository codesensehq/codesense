// SPDX-License-Identifier: MIT
//! Production MCP servers in the relay: what a saved-agent launch captured in
//! memory, and the read-only view of the person's bindings the relay and
//! `agent_get` use. Nothing here can write a binding; the native command that
//! does implements [`ProductionBindings`] and installs it at startup.
use crate::agents::production::{covers, BindingSummary, Pending, ProductionServer};
use crate::commands::credential_store::Secret;
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock, RwLock};

/// One binding as the relay connects from it: what the person approved, and the
/// header values. Deliberately no `Debug` or `Serialize`.
pub(crate) struct Binding {
    pub(crate) summary: BindingSummary,
    pub(crate) headers: BTreeMap<String, Secret>,
}

/// A ref's binding generation: a fresh random value on every bind and remove,
/// so a live connection notices either before its next request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Generation(pub(crate) u128);

/// The read-only view of the person's bindings.
pub(crate) trait ProductionBindings: Send + Sync {
    /// The binding with its header values, read fresh from the store.
    fn read(&self, reference: &str) -> Result<Option<Binding>, String>;
    /// The ref's current generation; never touches the store.
    fn generation(&self, reference: &str) -> Generation;
    /// The binding without its values.
    fn summary(&self, reference: &str) -> Result<Option<BindingSummary>, String> {
        Ok(self.read(reference)?.map(|binding| binding.summary))
    }
}

fn installed_slot() -> &'static RwLock<Option<Arc<dyn ProductionBindings>>> {
    static SLOT: OnceLock<RwLock<Option<Arc<dyn ProductionBindings>>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

/// Installs the app's bindings view, once at startup (tests install a fake).
pub(crate) fn install(bindings: Arc<dyn ProductionBindings>) {
    *installed_slot().write().unwrap_or_else(|e| e.into_inner()) = Some(bindings);
}

/// The installed bindings view; `None` before startup installs one.
pub(crate) fn installed() -> Option<Arc<dyn ProductionBindings>> {
    installed_slot()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Why `entry`, declared on `agent`, is not available now; `None` when the
/// person's binding covers it.
pub(crate) fn pending(agent: &str, entry: &ProductionServer) -> Option<Pending> {
    let summary = installed()
        .and_then(|bindings| bindings.summary(&entry.credential.reference).ok())
        .flatten();
    covers(summary.as_ref(), agent, entry).err()
}
