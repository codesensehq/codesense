// SPDX-License-Identifier: MIT
//! A person binds a production MCP server's credential to one agent.
//!
//! Native-only: these commands check the CodeSense window like
//! `spend_cap_accept`, and no MCP tool or embedded-page bridge verb reaches
//! them. A binding is one keychain item (service [`SERVICE`], account = the
//! credential ref) holding the header values and what the person approved: the
//! canonical agent id, the URL, the header names and `write`. Nothing here
//! ever returns a value. The relay and `agent_get` see bindings only through
//! the read-only [`ProductionBindings`] view this module installs.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::await_blocking;
use super::credential_store::{CredentialError, CredentialStore, KeychainStore, Secret};
use super::routines::caller;
use crate::agents::model::Agent;
use crate::agents::production::{self, BindingSummary};
use crate::agents::{service, AgentKey};
use crate::mcp::local_mcp_relay::production::{Binding, Generation, ProductionBindings};

/// The keychain service every binding lives under.
pub const SERVICE: &str = "codesense-mcp";

/// The account that lists every bound ref, so `status` can show bindings whose
/// agent no longer exists. Never a valid ref (refs have no '.').
const INDEX_ACCOUNT: &str = ".refs";

/// One keychain item: the header values and the approval, as JSON.
#[derive(Serialize, Deserialize)]
struct Stored {
    headers: BTreeMap<String, String>,
    agent: String,
    url: String,
    write: BTreeSet<String>,
}

/// One binding as `status` lists it: never a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingStatus {
    #[serde(rename = "ref")]
    pub reference: String,
    pub agent: String,
    pub url: String,
    pub headers: Vec<String>,
    pub write: Vec<String>,
}

/// The bindings over one credential store, with each ref's in-process
/// generation. The app holds one over the keychain; tests use a fake store.
pub(crate) struct Bindings {
    store: Arc<dyn CredentialStore>,
    generations: Mutex<HashMap<String, u128>>,
}

fn store_error(error: CredentialError) -> String {
    match error {
        CredentialError::Unavailable => "no keychain is available on this machine".into(),
        CredentialError::Failed(why) => why,
    }
}

impl Bindings {
    pub(crate) fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            generations: Mutex::new(HashMap::new()),
        }
    }

    /// A fresh generation for `reference`: every bind and remove retires the
    /// connections read at the old one, even remove-then-bind inside one tick.
    fn bump(&self, reference: &str) {
        self.generations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(reference.to_string(), rand::random());
    }

    fn stored(&self, reference: &str) -> Result<Option<Stored>, String> {
        let Some(secret) = self.store.get(reference).map_err(store_error)? else {
            return Ok(None);
        };
        serde_json::from_str(secret.expose())
            .map(Some)
            .map_err(|_| "a production MCP binding cannot be read".to_string())
    }

    fn index(&self) -> Result<BTreeSet<String>, String> {
        match self.store.get(INDEX_ACCOUNT).map_err(store_error)? {
            None => Ok(BTreeSet::new()),
            Some(secret) => serde_json::from_str(secret.expose())
                .map_err(|_| "the production MCP binding list cannot be read".to_string()),
        }
    }

    fn save_index(&self, refs: &BTreeSet<String>) -> Result<(), String> {
        let text = serde_json::to_string(refs).map_err(|e| e.to_string())?;
        self.store
            .set(INDEX_ACCOUNT, &Secret::new(text))
            .map_err(store_error)
    }

    /// Binds `entry` of `agent` (canonical id `agent_id`) with `headers`, when
    /// its current declaration has the fingerprint the person was shown.
    pub(crate) fn bind(
        &self,
        agent_id: &str,
        agent: &Agent,
        entry: &str,
        headers: BTreeMap<String, String>,
        expected: &str,
    ) -> Result<(), String> {
        let declared = agent
            .mcp
            .production
            .iter()
            .find(|candidate| candidate.name == entry)
            .ok_or("the agent declares no production MCP server by that name")?;
        if declared.fingerprint(agent_id) != expected {
            return Err(
                "the declaration changed since it was shown; review it again before binding".into(),
            );
        }
        declared.check()?;
        let headers: BTreeMap<String, String> = headers
            .into_iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value))
            .collect();
        if headers.keys().cloned().collect::<BTreeSet<_>>() != declared.header_names() {
            return Err("give a value for exactly the declared header names".into());
        }
        if headers.values().any(|value| {
            value.is_empty() || reqwest_mcp::header::HeaderValue::from_str(value).is_err()
        }) {
            return Err("a header value is empty or not a valid header value".into());
        }
        let reference = &declared.credential.reference;
        if let Some(existing) = self.stored(reference)? {
            if existing.agent != agent_id {
                return Err(format!(
                    "credential ref {reference:?} is bound to another agent; remove that binding first"
                ));
            }
        }
        let summary = declared.binding_for(agent_id);
        let stored = Stored {
            headers,
            agent: summary.agent,
            url: summary.url,
            write: summary.write,
        };
        let text = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
        let mut refs = self.index()?;
        self.store
            .set(reference, &Secret::new(text))
            .map_err(store_error)?;
        self.bump(reference);
        if refs.insert(reference.clone()) {
            self.save_index(&refs)?;
        }
        Ok(())
    }

    /// Deletes the binding of `reference`, whatever agent it names, and retires
    /// its live connections.
    pub(crate) fn remove(&self, reference: &str) -> Result<(), String> {
        if !production::is_valid_name(reference) {
            return Err("not a credential ref".into());
        }
        self.store.delete(reference).map_err(store_error)?;
        self.bump(reference);
        let mut refs = self.index()?;
        if refs.remove(reference) {
            self.save_index(&refs)?;
        }
        Ok(())
    }

    /// Every binding, including those whose agent no longer exists. No values.
    pub(crate) fn status(&self) -> Result<Vec<BindingStatus>, String> {
        let mut out = Vec::new();
        for reference in self.index()? {
            if let Some(stored) = self.stored(&reference)? {
                out.push(BindingStatus {
                    reference,
                    agent: stored.agent,
                    url: stored.url,
                    headers: stored.headers.into_keys().collect(),
                    write: stored.write.into_iter().collect(),
                });
            }
        }
        Ok(out)
    }
}

impl ProductionBindings for Bindings {
    fn read(&self, reference: &str) -> Result<Option<Binding>, String> {
        Ok(self.stored(reference)?.map(|stored| Binding {
            summary: BindingSummary {
                agent: stored.agent,
                url: stored.url,
                headers: stored.headers.keys().cloned().collect(),
                write: stored.write,
            },
            headers: stored
                .headers
                .into_iter()
                .map(|(name, value)| (name, Secret::new(value)))
                .collect(),
        }))
    }

    fn generation(&self, reference: &str) -> Generation {
        let mut generations = self.generations.lock().unwrap_or_else(|e| e.into_inner());
        Generation(
            *generations
                .entry(reference.to_string())
                .or_insert_with(rand::random),
        )
    }
}

/// The app's bindings over the keychain, created and installed once at startup.
fn app_bindings() -> Arc<Bindings> {
    static APP: OnceLock<Arc<Bindings>> = OnceLock::new();
    APP.get_or_init(|| Arc::new(Bindings::new(Arc::new(KeychainStore::new(SERVICE)))))
        .clone()
}

/// Installs the app's bindings view for the relay and `agent_get`.
pub(crate) fn install() {
    crate::mcp::local_mcp_relay::production::install(app_bindings());
}

/// Bindings are made only from the CodeSense window.
fn require_native_window(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err("Production MCP credentials are bound from the CodeSense window".into());
    }
    Ok(())
}

fn require_platform() -> Result<(), String> {
    if production::platform_supported() {
        Ok(())
    } else {
        Err(production::UNSUPPORTED_PLATFORM.into())
    }
}

/// Every binding, never a value. Native-only.
#[tauri::command]
pub async fn mcp_production_status(webview: tauri::Webview) -> Result<Vec<BindingStatus>, String> {
    require_native_window(webview.label())?;
    require_platform()?;
    await_blocking("mcp_production_status", move || app_bindings().status()).await
}

/// A person's native bind of `entry` on `agent` (its `agent_list` id) with the
/// header values. `expected` is the fingerprint of the declaration the person
/// was shown. Native-only. Embedded pages have no bridge verb for this command.
#[tauri::command]
pub async fn mcp_production_bind(
    app: AppHandle,
    webview: tauri::Webview,
    agent: String,
    entry: String,
    headers: BTreeMap<String, String>,
    expected: String,
) -> Result<(), String> {
    require_native_window(webview.label())?;
    require_platform()?;
    let caller = caller(&app).await?;
    await_blocking("mcp_production_bind", move || {
        let key = AgentKey::parse(&agent).ok_or("invalid agent id")?;
        let detail =
            service::get(&caller.home, &caller.principal, &key).map_err(|e| e.to_string())?;
        app_bindings().bind(
            &detail.key.to_string(),
            &detail.agent,
            &entry,
            headers,
            &expected,
        )
    })
    .await
}

/// A person's native removal of the binding of `reference`, whatever agent it
/// names. Live connections on it stop before their next request. Native-only.
#[tauri::command]
pub async fn mcp_production_remove(
    webview: tauri::Webview,
    reference: String,
) -> Result<(), String> {
    require_native_window(webview.label())?;
    require_platform()?;
    await_blocking("mcp_production_remove", move || {
        app_bindings().remove(&reference)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::credential_store::{FakeStore, UnavailableStore};

    const AGENT_A: &str = "acme/api/backend/triage";
    const AGENT_B: &str = "acme/api/backend/other";
    const CANARY: &str = "canary-value-7f3a";

    fn agent_with(entry: serde_json::Value) -> Agent {
        serde_json::from_value(serde_json::json!({
            "id": "triage", "name": "Triage", "runtime": "claude", "revision": 1,
            "mcp": {"production": [entry]},
        }))
        .unwrap()
    }

    fn logs() -> Agent {
        agent_with(serde_json::json!({
            "name": "logs",
            "url": "https://mcp.example.com/mcp?toolsets=logs",
            "credential": {"ref": "logs-read", "headers": ["X-Api-Key", "X-App-Key"]},
            "write": ["create_note"],
        }))
    }

    fn values() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("X-Api-Key".to_string(), CANARY.to_string()),
            ("X-App-Key".to_string(), format!("{CANARY}-2")),
        ])
    }

    fn print(agent: &Agent, id: &str) -> String {
        agent.mcp.production[0].fingerprint(id)
    }

    fn bindings() -> Bindings {
        Bindings::new(Arc::new(FakeStore::default()))
    }

    #[test]
    fn credential_command_never_returns_value() {
        let bindings = bindings();
        let agent = logs();
        bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .unwrap();
        let status = bindings.status().unwrap();
        assert_eq!(
            status,
            vec![BindingStatus {
                reference: "logs-read".into(),
                agent: AGENT_A.into(),
                url: "https://mcp.example.com/mcp?toolsets=logs".into(),
                headers: vec!["x-api-key".into(), "x-app-key".into()],
                write: vec!["create_note".into()],
            }]
        );
        let wire = serde_json::to_string(&status).unwrap();
        assert!(!wire.contains(CANARY), "{wire}");
        // The read-only view carries the values for the relay, and its summary none.
        let binding = bindings.read("logs-read").unwrap().unwrap();
        assert_eq!(binding.headers["x-api-key"].expose(), CANARY);
        let summary = bindings.summary("logs-read").unwrap().unwrap();
        assert!(!format!("{summary:?}").contains(CANARY));
    }

    #[test]
    fn bind_command_refuses_non_native_webview() {
        require_native_window("main").unwrap();
        for label in ["dashboard-1", "viewer", "inbox-frame", ""] {
            assert!(require_native_window(label).is_err(), "{label}");
        }
    }

    #[test]
    fn production_refused_off_macos() {
        assert_eq!(require_platform().is_ok(), cfg!(target_os = "macos"));
    }

    #[test]
    fn bind_refuses_changed_declaration() {
        let bindings = bindings();
        let shown = logs();
        let expected = print(&shown, AGENT_A);
        for edit in [
            serde_json::json!({"name": "logs", "url": "https://elsewhere.example.com/mcp",
                "credential": {"ref": "logs-read", "headers": ["X-Api-Key", "X-App-Key"]},
                "write": ["create_note"]}),
            serde_json::json!({"name": "logs", "url": "https://mcp.example.com/mcp?toolsets=logs",
                "credential": {"ref": "logs-read", "headers": ["X-Api-Key", "X-App-Key"]},
                "write": ["create_note", "delete_monitor"]}),
        ] {
            let now = agent_with(edit);
            let refused = bindings
                .bind(AGENT_A, &now, "logs", values(), &expected)
                .unwrap_err();
            assert!(refused.contains("changed since it was shown"), "{refused}");
        }
        // The fingerprint names the agent too: A's fingerprint never binds B.
        assert!(bindings
            .bind(AGENT_B, &shown, "logs", values(), &expected)
            .is_err());
        assert!(bindings.status().unwrap().is_empty());
        assert!(bindings.read("logs-read").unwrap().is_none());
    }

    #[test]
    fn bind_refuses_changed_ref() {
        let bindings = bindings();
        let shown = logs();
        let expected = print(&shown, AGENT_A);
        let now = agent_with(serde_json::json!({
            "name": "logs",
            "url": "https://mcp.example.com/mcp?toolsets=logs",
            "credential": {"ref": "other-ref", "headers": ["X-Api-Key", "X-App-Key"]},
            "write": ["create_note"],
        }));
        assert!(bindings
            .bind(AGENT_A, &now, "logs", values(), &expected)
            .unwrap_err()
            .contains("changed since it was shown"));
        assert!(bindings.read("other-ref").unwrap().is_none());
        assert!(bindings.read("logs-read").unwrap().is_none());
    }

    #[test]
    fn bind_refuses_ref_bound_to_another_agent() {
        let bindings = bindings();
        let agent = logs();
        bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .unwrap();
        let refused = bindings
            .bind(AGENT_B, &agent, "logs", values(), &print(&agent, AGENT_B))
            .unwrap_err();
        assert!(refused.contains("another agent"), "{refused}");
        assert_eq!(
            bindings.summary("logs-read").unwrap().unwrap().agent,
            AGENT_A
        );
        // A same-agent re-bind is allowed; after a remove, B may bind.
        bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .unwrap();
        bindings.remove("logs-read").unwrap();
        bindings
            .bind(AGENT_B, &agent, "logs", values(), &print(&agent, AGENT_B))
            .unwrap();
        assert_eq!(
            bindings.summary("logs-read").unwrap().unwrap().agent,
            AGENT_B
        );
    }

    #[test]
    fn bind_checks_the_header_values_and_the_url_again() {
        let bindings = bindings();
        let agent = logs();
        let expected = print(&agent, AGENT_A);
        let mut missing = values();
        missing.remove("X-App-Key");
        assert!(bindings
            .bind(AGENT_A, &agent, "logs", missing, &expected)
            .is_err());
        let mut extra = values();
        extra.insert("X-Other".into(), "x".into());
        assert!(bindings
            .bind(AGENT_A, &agent, "logs", extra, &expected)
            .is_err());
        let mut empty = values();
        empty.insert("X-App-Key".into(), String::new());
        assert!(bindings
            .bind(AGENT_A, &agent, "logs", empty, &expected)
            .is_err());
        let mut newline = values();
        newline.insert("X-App-Key".into(), "a\nb".into());
        assert!(bindings
            .bind(AGENT_A, &agent, "logs", newline, &expected)
            .is_err());
        // A declaration edited in git past validation is checked at bind.
        let mut edited = logs();
        edited.mcp.production[0].url = "http://mcp.example.com/mcp".into();
        let refused = bindings
            .bind(AGENT_A, &edited, "logs", values(), &print(&edited, AGENT_A))
            .unwrap_err();
        assert!(refused.contains("https"), "{refused}");
        assert!(bindings.status().unwrap().is_empty());
    }

    #[test]
    fn status_lists_orphan_bindings() {
        let bindings = bindings();
        let agent = logs();
        bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .unwrap();
        // The agent is gone (no lookup happens): status still lists the
        // binding, and remove deletes it.
        assert_eq!(bindings.status().unwrap().len(), 1);
        bindings.remove("logs-read").unwrap();
        assert!(bindings.status().unwrap().is_empty());
        assert!(bindings.read("logs-read").unwrap().is_none());
        assert!(bindings.remove("../x").is_err());
    }

    #[test]
    fn bind_and_remove_change_the_generation() {
        let bindings = bindings();
        let agent = logs();
        let first = bindings.generation("logs-read");
        assert_eq!(bindings.generation("logs-read"), first);
        bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .unwrap();
        let bound = bindings.generation("logs-read");
        assert_ne!(bound, first);
        // Remove then bind again inside one tick still differs from `bound`.
        bindings.remove("logs-read").unwrap();
        bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .unwrap();
        assert_ne!(bindings.generation("logs-read"), bound);
    }

    #[test]
    fn an_unavailable_store_fails_closed() {
        let bindings = Bindings::new(Arc::new(UnavailableStore));
        let agent = logs();
        assert!(bindings
            .bind(AGENT_A, &agent, "logs", values(), &print(&agent, AGENT_A))
            .is_err());
        assert!(bindings.read("logs-read").is_err());
        assert!(bindings.status().is_err());
    }
}
