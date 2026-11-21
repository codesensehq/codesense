// SPDX-License-Identifier: MIT
//! Production MCP servers in the relay: what a saved-agent launch captured in
//! memory, and the read-only view of the person's bindings the relay and
//! `agent_get` use. Nothing here can write a binding; the native command that
//! does implements [`ProductionBindings`] and installs it at startup.
use crate::agents::production::{covers, BindingSummary, Pending, ProductionServer};
use crate::commands::credential_store::Secret;
use std::collections::{BTreeMap, BTreeSet};
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
    match installed() {
        Some(bindings) => pending_with(&*bindings, agent, entry),
        None => Some(Pending::Unbound),
    }
}

/// [`pending`] against one bindings view.
pub(crate) fn pending_with(
    bindings: &dyn ProductionBindings,
    agent: &str,
    entry: &ProductionServer,
) -> Option<Pending> {
    let summary = bindings.summary(&entry.credential.reference).ok().flatten();
    covers(summary.as_ref(), agent, entry).err()
}
/// What one saved-agent launch captured, in memory only: the canonical agent id
/// and the declared production servers, with the bindings view the relay reads.
/// Never serialized, so it can never reach a scope-dir file.
#[derive(Clone)]
pub(crate) struct ProductionSet {
    pub(crate) agent_id: String,
    pub(crate) entries: BTreeMap<String, ProductionServer>,
    pub(crate) bindings: Arc<dyn ProductionBindings>,
}

impl ProductionSet {
    /// The entries a launch gets a shim for: those the binding covers at launch.
    /// A pending entry gets none, so a bind made later needs a relaunch.
    pub(crate) fn new(
        agent_id: String,
        declared: &[ProductionServer],
        bindings: Arc<dyn ProductionBindings>,
    ) -> Self {
        let entries = declared
            .iter()
            .filter(|entry| {
                let summary = bindings.summary(&entry.credential.reference).ok().flatten();
                covers(summary.as_ref(), &agent_id, entry).is_ok()
            })
            .map(|entry| (entry.name.clone(), entry.clone()))
            .collect();
        Self {
            agent_id,
            entries,
            bindings,
        }
    }

    pub(crate) fn names(&self) -> BTreeSet<String> {
        self.entries.keys().cloned().collect()
    }

    /// The connection one production server gets now: its binding read fresh,
    /// checked against what the launch captured, with the URL checks re-run.
    pub(crate) fn connect(&self, name: &str) -> Result<Connection, String> {
        let entry = self
            .entries
            .get(name)
            .ok_or("MCP server was not selected")?;
        let generation = self.bindings.generation(&entry.credential.reference);
        let binding = self
            .bindings
            .read(&entry.credential.reference)
            .map_err(|_| "production MCP credential store is unavailable")?
            .ok_or("production MCP server has no binding; a person must bind it")?;
        let write = covers(Some(&binding.summary), &self.agent_id, entry).map_err(|why| {
            format!(
                "production MCP server is pending ({}); a person must bind it and the agent must be relaunched",
                why.as_str()
            )
        })?;
        check_connect_url(&binding.summary.url)
            .map_err(|why| format!("production MCP binding url {why}"))?;
        if binding.headers.keys().cloned().collect::<BTreeSet<_>>() != binding.summary.headers {
            return Err("production MCP binding is incomplete".into());
        }
        Ok(Connection {
            server: name.to_string(),
            reference: entry.credential.reference.clone(),
            url: binding.summary.url,
            headers: binding.headers,
            write,
            generation,
        })
    }
}

/// The URL checks every connect re-runs. Tests reach the loopback fixture over
/// plain http through this seam; a build that ships has no such exception.
fn check_connect_url(url: &str) -> Result<(), String> {
    #[cfg(test)]
    if url.starts_with("http://127.0.0.1:") {
        return Ok(());
    }
    crate::agents::production::check_url(url)
}

/// One production connection's endpoint: the binding's URL and header values,
/// the effective `write`, and the generation it was read at.
pub(crate) struct Connection {
    pub(crate) server: String,
    pub(crate) reference: String,
    pub(crate) url: String,
    pub(crate) headers: BTreeMap<String, Secret>,
    pub(crate) write: BTreeSet<String>,
    pub(crate) generation: Generation,
}

/// The kernel-proven caller of one production connection: the session and the
/// peer pid. Used only for the binding check and the call log, never as a
/// CodeSense caller identity.
#[derive(Debug, Clone)]
pub(crate) struct ProductionCaller {
    pub(crate) session: String,
    pub(crate) pid: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::production::ProductionServer;
    use std::sync::Mutex;

    const AGENT_A: &str = "acme/api/backend/triage";
    const CANARY: &str = "canary-value-7f3a";

    /// An in-memory bindings view: what a person bound, and each ref's generation.
    #[derive(Default)]
    pub(crate) struct FakeBindings {
        pub(crate) bound: Mutex<BTreeMap<String, (BindingSummary, BTreeMap<String, String>)>>,
        pub(crate) generations: Mutex<BTreeMap<String, u128>>,
        pub(crate) unavailable: std::sync::atomic::AtomicBool,
    }

    impl FakeBindings {
        pub(crate) fn bind(&self, entry: &ProductionServer, agent: &str, url: &str) {
            let mut summary = entry.binding_for(agent);
            summary.url = url.to_string();
            let headers = summary
                .headers
                .iter()
                .map(|name| (name.clone(), CANARY.to_string()))
                .collect();
            self.bound
                .lock()
                .unwrap()
                .insert(entry.credential.reference.clone(), (summary, headers));
            *self
                .generations
                .lock()
                .unwrap()
                .entry(entry.credential.reference.clone())
                .or_default() += 1;
        }
    }

    impl ProductionBindings for FakeBindings {
        fn read(&self, reference: &str) -> Result<Option<Binding>, String> {
            if self.unavailable.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("store unavailable".into());
            }
            Ok(self
                .bound
                .lock()
                .unwrap()
                .get(reference)
                .map(|(summary, headers)| Binding {
                    summary: summary.clone(),
                    headers: headers
                        .iter()
                        .map(|(k, v)| (k.clone(), Secret::new(v.clone())))
                        .collect(),
                }))
        }
        fn generation(&self, reference: &str) -> Generation {
            Generation(
                self.generations
                    .lock()
                    .unwrap()
                    .get(reference)
                    .copied()
                    .unwrap_or_default(),
            )
        }
    }

    pub(crate) fn entry() -> ProductionServer {
        serde_json::from_value(serde_json::json!({
            "name": "logs",
            "url": "https://mcp.example.com/mcp?toolsets=logs",
            "credential": {"ref": "logs-read", "headers": ["X-Api-Key"]},
            "write": ["create_note"],
        }))
        .unwrap()
    }

    #[test]
    fn missing_credential_fails_closed_with_no_cli_spawned_fallback() {
        let fake = Arc::new(FakeBindings::default());
        // Unbound at launch: no shim, nothing to connect.
        let set = ProductionSet::new(AGENT_A.into(), &[entry()], fake.clone());
        assert!(set.names().is_empty());
        assert!(set.connect("logs").is_err());
        // Bound at launch, then removed: the connect fails closed.
        fake.bind(&entry(), AGENT_A, &entry().url);
        let set = ProductionSet::new(AGENT_A.into(), &[entry()], fake.clone());
        assert_eq!(set.names(), BTreeSet::from(["logs".to_string()]));
        assert!(set.connect("logs").is_ok());
        fake.bound.lock().unwrap().clear();
        let refused = set.connect("logs").err().unwrap();
        assert!(refused.contains("no binding"), "{refused}");
        // The store cannot be read.
        fake.bind(&entry(), AGENT_A, &entry().url);
        fake.unavailable
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let refused = set.connect("logs").err().unwrap();
        assert!(refused.contains("unavailable"), "{refused}");
        assert!(!refused.contains(CANARY));
        fake.unavailable
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // A binding mismatch: re-bound to another agent.
        fake.bind(&entry(), "acme/api/backend/other", &entry().url);
        let refused = set.connect("logs").err().unwrap();
        assert!(refused.contains("pending"), "{refused}");
    }

    #[test]
    fn other_agent_with_bound_ref_is_refused() {
        let fake = Arc::new(FakeBindings::default());
        fake.bind(&entry(), AGENT_A, &entry().url);
        // B declares A's ref, endpoint and write; so does A's key in another org.
        for other in ["acme/api/backend/other", "other/org/backend/triage"] {
            let set = ProductionSet::new(other.into(), &[entry()], fake.clone());
            assert!(set.names().is_empty(), "{other}");
            assert!(set.connect("logs").is_err(), "{other}");
        }
    }

    #[test]
    fn mcp_edit_widening_production_stays_unavailable_until_rebound() {
        let fake = Arc::new(FakeBindings::default());
        fake.bind(&entry(), AGENT_A, &entry().url);
        let widenings: [fn(&mut ProductionServer); 3] = [
            |e| e.write.push("delete_monitor".into()),
            |e| e.url = "https://elsewhere.example.com/mcp".into(),
            |e| e.credential.headers.push("X-Other".into()),
        ];
        for widen in widenings {
            let mut edited = entry();
            widen(&mut edited);
            assert!(
                pending_with(&*fake, AGENT_A, &edited).is_some(),
                "an edit that widens is pending"
            );
            let set = ProductionSet::new(AGENT_A.into(), &[edited], fake.clone());
            assert!(set.names().is_empty(), "the next launch gets no shim");
        }
        // A running session keeps its launch-captured declaration: its effective
        // write is unchanged by an edit to the agent.
        let running = ProductionSet::new(AGENT_A.into(), &[entry()], fake.clone());
        assert_eq!(
            running.connect("logs").unwrap().write,
            BTreeSet::from(["create_note".to_string()])
        );
    }

    #[test]
    fn narrowed_write_still_matches() {
        let fake = Arc::new(FakeBindings::default());
        fake.bind(&entry(), AGENT_A, &entry().url);
        let mut narrowed = entry();
        narrowed.write.clear();
        let set = ProductionSet::new(AGENT_A.into(), &[narrowed], fake);
        assert!(set.connect("logs").unwrap().write.is_empty());
    }

    #[test]
    fn relay_connects_to_bound_url_not_declared() {
        let fake = Arc::new(FakeBindings::default());
        fake.bind(&entry(), AGENT_A, &entry().url);
        let set = ProductionSet::new(AGENT_A.into(), &[entry()], fake.clone());
        let connection = set.connect("logs").unwrap();
        assert_eq!(connection.url, entry().url);
        assert_eq!(connection.headers["x-api-key"].expose(), CANARY);
        // A binding whose URL fails the connect checks (edited past bind) is refused.
        let mut tampered = entry();
        tampered.url = "https://user:pw@mcp.example.com/mcp".into();
        fake.bind(&tampered, AGENT_A, &tampered.url);
        let set = ProductionSet::new(AGENT_A.into(), &[tampered], fake);
        assert!(set.connect("logs").err().unwrap().contains("user info"));
    }

    #[test]
    fn bind_after_launch_applies_only_when_captured_declaration_matches() {
        let fake = Arc::new(FakeBindings::default());
        // Pending at launch: no shim, so a later bind changes nothing until a relaunch.
        let launched = ProductionSet::new(AGENT_A.into(), &[entry()], fake.clone());
        fake.bind(&entry(), AGENT_A, &entry().url);
        assert!(launched.names().is_empty());
        assert!(launched.connect("logs").is_err());
        assert!(ProductionSet::new(AGENT_A.into(), &[entry()], fake)
            .connect("logs")
            .is_ok());
    }

    #[test]
    fn rebind_changes_the_generation_a_connection_was_read_at() {
        let fake = Arc::new(FakeBindings::default());
        fake.bind(&entry(), AGENT_A, &entry().url);
        let set = ProductionSet::new(AGENT_A.into(), &[entry()], fake.clone());
        let connection = set.connect("logs").unwrap();
        assert_eq!(fake.generation("logs-read"), connection.generation);
        fake.bind(&entry(), AGENT_A, &entry().url);
        assert_ne!(fake.generation("logs-read"), connection.generation);
    }
}
