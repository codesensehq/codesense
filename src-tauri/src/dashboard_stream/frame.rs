// SPDX-License-Identifier: MIT
//! Frame identities live for one host mount. Origins are public identifiers;
//! capabilities are delivered only to the registered embedded document.
use super::token::ScopedCapabilityStore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use url::{Host, Url};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameTeam {
    pub org: String,
    pub team: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameGrant {
    pub frame_id: String,
    pub principal: String,
    pub dashboard: String,
    pub slot: String,
    pub team: Option<FrameTeam>,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FramePolicy {
    pub own_folder_only: bool,
    pub block_service_workers: bool,
    pub no_outside_network: bool,
    #[serde(skip)]
    pub inbox_media: bool,
    pub allowed_hosts: Vec<String>,
    pub team_safe: bool,
}

/// Policy: a frame denies outside network unless its document declares exact hosts.
impl Default for FramePolicy {
    fn default() -> Self {
        Self {
            own_folder_only: false,
            block_service_workers: false,
            no_outside_network: true,
            inbox_media: false,
            allowed_hosts: Vec::new(),
            team_safe: false,
        }
    }
}

/// The dashboard folder manifest whose `allowed_hosts` opens a frame's outside network.
pub const DASHBOARD_MANIFEST: &str = "dashboard.yml";

/// Outside-network origins a document declares: exact `https://host[:port]` origins only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowedHosts(pub Vec<String>);

impl AllowedHosts {
    /// Normalized origins, or why one entry is not an exact HTTPS origin.
    pub fn parse(values: &[String]) -> Result<Self, String> {
        let mut origins: Vec<String> = Vec::new();
        for value in values {
            let origin = exact_https_origin(value).ok_or_else(|| {
                format!("{value:?} is not an exact https://host[:port] origin with a public host name (no wildcards, IP addresses, localhost or single-label names, http, paths or other schemes)")
            })?;
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        Ok(Self(origins))
    }

    /// `allowed_hosts` of the nearest `dashboard.yml` at or above `document`, inside `root`.
    /// No manifest declares nothing; an unreadable or invalid manifest, or a bad
    /// `allowed_hosts`, is an error naming the manifest.
    pub fn for_document(document: &Path, root: &Path) -> Result<Self, String> {
        // Real paths: `..` and symlinked folders cannot carry the walk outside the root.
        let Some(root) = Result::ok(std::fs::canonicalize(root)) else {
            return Ok(Self::default());
        };
        let Some(folder) = Iterator::find(&mut document.ancestors().skip(1), |dir| dir.is_dir())
            .and_then(|dir| Result::ok(std::fs::canonicalize(dir)))
            .filter(|folder| folder.starts_with(&root))
        else {
            return Ok(Self::default());
        };
        let mut manifests = folder
            .ancestors()
            .take_while(|dir| dir.starts_with(&root))
            .map(|dir| dir.join(DASHBOARD_MANIFEST));
        let Some(manifest) = Iterator::find(&mut manifests, |manifest| manifest.is_file()) else {
            return Ok(Self::default());
        };
        let diagnostic = |why: String| {
            format!(
                "{}: allowed_hosts: {why}",
                std::path::Path::display(&manifest)
            )
        };
        // A manifest that links outside the root is refused, never followed.
        if !Result::ok(std::fs::canonicalize(&manifest)).is_some_and(|real| real.starts_with(&root))
        {
            return Err(diagnostic(
                "the manifest resolves outside the content root".into(),
            ));
        }
        let text = std::fs::read_to_string(&manifest)
            .map_err(|_| diagnostic("the manifest cannot be read".into()))?;
        let yaml = serde_yaml::from_str::<serde_yaml::Value>(&text)
            .map_err(|_| diagnostic("the manifest is not valid YAML".into()))?;
        let Some(hosts) = yaml.get("allowed_hosts").cloned() else {
            return Ok(Self::default());
        };
        let hosts: Option<Vec<String>> = serde_yaml::from_value(hosts)
            .map_err(|_| diagnostic("must be a list of https://host[:port] origins".into()))?;
        Self::parse(&hosts.unwrap_or_default()).map_err(diagnostic)
    }
}

/// The origin `value` names when it is exactly `https://host[:port]` with a named host;
/// CSP-safe by construction.
fn exact_https_origin(value: &str) -> Option<String> {
    let url = Result::ok(Url::parse(value))?;
    let named = match Url::host(&url)? {
        Host::Domain(domain) => {
            !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains("..")
                && Iterator::all(&mut domain.chars(), |c| {
                    c.is_ascii_alphanumeric() || c == '-' || c == '.'
                })
                // Policy: local names (`localhost`, `*.localhost`, single-label intranet
                // names) are never declarable, so a page cannot reach services on this
                // Mac or its network by name.
                && (!is_local_name(domain) || fixture_loopback(domain))
        }
        // Policy: IP literals (loopback, private, link-local or public) are never declarable.
        Host::Ipv4(_) | Host::Ipv6(_) => false,
    };
    (named
        && url.scheme() == "https"
        && Url::port(&url) != Some(0)
        && str::is_empty(url.username())
        && url.password().is_none()
        && Url::path(&url) == "/"
        && Url::query(&url).is_none()
        && url.fragment().is_none())
    .then(|| url.origin().ascii_serialization())
}

fn is_local_name(domain: &str) -> bool {
    !domain.contains('.') || domain.ends_with(".localhost")
}

/// Shipped builds never declare a local name.
#[cfg(not(test))]
fn fixture_loopback(_: &str) -> bool {
    false
}

/// The browser frame-security fixture serves its declared host on `https://localhost`;
/// only that fixture sets this, and only test builds compile it.
#[cfg(test)]
pub(crate) static FIXTURE_LOOPBACK: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn fixture_loopback(domain: &str) -> bool {
    domain == "localhost" && FIXTURE_LOOPBACK.load(std::sync::atomic::Ordering::Relaxed)
}

impl FramePolicy {
    /// A service worker can replace navigation responses and strip their CSP.
    /// Network isolation therefore also requires service-worker isolation.
    pub fn blocks_service_workers(&self) -> bool {
        self.block_service_workers || self.no_outside_network
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMessage {
    pub org: String,
    pub team: String,
    pub message_id: i64,
}

/// Caller classification comes from validated mint facts, never capability scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameCallerKind {
    Message,
    Team,
    Private,
    Builtin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    #[serde(skip)]
    pub records_binding: Option<crate::records::binding::Binding>,
    pub parent_frame: Option<String>,
    pub effective_grant: Vec<String>,
    pub kind: FrameCallerKind,
    pub frame_id: String,
    pub origin: String,
    pub token: String,
    pub grant: FrameGrant,
    pub content_root: String,
    pub document_path: String,
    pub asset_folder: String,
    pub policy: FramePolicy,
    pub message: Option<FrameMessage>,
    /// What the page declared at mint, so a rebind recomputes the same grant for a new team.
    #[serde(skip)]
    pub declared: Vec<String>,
}

pub struct FrameStore {
    records: Mutex<HashMap<String, FrameRecord>>,
    tokens: ScopedCapabilityStore<FrameGrant>,
}
impl Default for FrameStore {
    fn default() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            // Teardown revokes these. A long-lived visible dashboard must not
            // suddenly lose its grant after the read-token store's default TTL.
            tokens: ScopedCapabilityStore::new(Duration::from_secs(100 * 365 * 24 * 3600)),
        }
    }
}
impl FrameStore {
    pub fn mint(
        &self,
        port: u16,
        grant: FrameGrant,
        content_root: String,
        document_path: String,
        asset_folder: String,
        policy: FramePolicy,
        message: Option<FrameMessage>,
    ) -> FrameRecord {
        let kind = if message.is_some()
            || grant.slot == "message"
            || document_path.starts_with("inbox-message://")
        {
            FrameCallerKind::Message
        } else if document_path.starts_with("builtin:") || document_path.starts_with("virtual:") {
            FrameCallerKind::Builtin
        } else if grant.team.is_some() {
            FrameCallerKind::Team
        } else {
            FrameCallerKind::Private
        };
        self.mint_with_grant(
            port,
            grant,
            content_root,
            document_path,
            asset_folder,
            policy,
            message,
            crate::verbs::capabilities::full(),
            kind,
        )
    }
    pub fn mint_with_grant(
        &self,
        port: u16,
        mut grant: FrameGrant,
        content_root: String,
        document_path: String,
        asset_folder: String,
        policy: FramePolicy,
        message: Option<FrameMessage>,
        effective_grant: Vec<String>,
        kind: FrameCallerKind,
    ) -> FrameRecord {
        let id = uuid::Uuid::new_v4().simple().to_string();
        grant.frame_id = id.clone();
        let token = self.tokens.mint(grant.clone());
        let record = FrameRecord {
            records_binding: None,
            parent_frame: None,
            effective_grant,
            kind,
            frame_id: id.clone(),
            origin: format!("http://f-{id}.localhost:{port}"),
            token,
            grant,
            content_root,
            document_path,
            asset_folder,
            policy,
            message,
            declared: Vec::new(),
        };
        self.records
            .lock()
            .expect("frame store poisoned")
            .insert(id, record.clone());
        record
    }
    pub fn bind_records(
        &self,
        id: &str,
        binding: crate::records::binding::Binding,
    ) -> Result<FrameRecord, String> {
        let mut records = self.records.lock().map_err(|_| "Frame store unavailable")?;
        let frame = records.get_mut(id).ok_or("denied: frame released")?;
        frame.records_binding = Some(binding);
        Ok(frame.clone())
    }
    pub fn declare(&self, id: &str, declared: &[String]) {
        if let Some(record) = self
            .records
            .lock()
            .ok()
            .as_mut()
            .and_then(|r| r.get_mut(id))
        {
            record.declared = declared.to_vec();
        }
    }
    /// Re-binds a live frame to a new team in place: same frame id and origin (so the page
    /// never reloads), a new token carrying the recomputed grant, and the old token revoked at
    /// once. Refused when `token` is no longer the frame's, so a stale rebind cannot win.
    pub fn rebind(
        &self,
        id: &str,
        token: &str,
        team: Option<FrameTeam>,
        scope: String,
        effective_grant: Vec<String>,
        policy: FramePolicy,
    ) -> Result<FrameRecord, String> {
        let mut records = self.records.lock().map_err(|_| "Frame store unavailable")?;
        let record = records.get_mut(id).ok_or("denied: frame identity")?;
        if record.token != token {
            return Err("denied: frame identity".into());
        }
        let grant = FrameGrant {
            team,
            scope,
            ..record.grant.clone()
        };
        let fresh = self.tokens.mint(grant.clone());
        self.tokens.revoke(&record.token);
        record.token = fresh;
        record.grant = grant;
        record.effective_grant = effective_grant;
        record.policy = policy;
        Ok(record.clone())
    }
    pub fn link_child(&self, id: &str, parent: &str) -> Result<FrameRecord, String> {
        let mut records = self.records.lock().map_err(|_| "Frame store unavailable")?;
        let pane = records.get(parent).ok_or("denied: parent frame")?;
        if !crate::verbs::capabilities::SLOTS.contains(&pane.grant.slot.as_str())
            || pane.message.is_some()
        {
            return Err("denied: parent frame".into());
        }
        let parent_network = (
            pane.policy.no_outside_network,
            pane.policy.allowed_hosts.clone(),
        );
        let child = records.get_mut(id).ok_or("denied: child frame")?;
        if child.message.is_none() {
            return Err("denied: child frame".into());
        }
        child.parent_frame = Some(parent.into());
        // Policy: a child inherits its parent's network denial and may only narrow its hosts.
        child.policy.no_outside_network |= parent_network.0;
        Vec::retain(&mut child.policy.allowed_hosts, |host| {
            parent_network.1.contains(host)
        });
        Ok(child.clone())
    }
    pub fn release(&self, id: &str) {
        let removed = self
            .records
            .lock()
            .ok()
            .map(|mut records| {
                let ids: Vec<_> = records
                    .values()
                    .filter(|r| r.frame_id == id || r.parent_frame.as_deref() == Some(id))
                    .map(|r| r.frame_id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| records.remove(&id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for record in removed {
            self.tokens.revoke(&record.token);
        }
    }
    pub fn by_id(&self, id: &str) -> Option<FrameRecord> {
        self.records.lock().ok()?.get(id).cloned()
    }
    pub fn by_host(&self, host: &str, port: u16) -> Option<FrameRecord> {
        let suffix = format!(".localhost:{port}");
        let id = host.strip_prefix("f-")?.strip_suffix(&suffix)?;
        self.records.lock().ok()?.get(id).cloned()
    }
    pub fn by_origin(&self, origin: &str) -> Option<FrameRecord> {
        self.records
            .lock()
            .ok()?
            .values()
            .find(|r| r.origin == origin)
            .cloned()
    }
    pub fn resolve(&self, origin: &str, token: &str) -> Option<FrameGrant> {
        let record = self.by_origin(origin)?;
        let grant = self.tokens.validate(token)?;
        if let Some(parent) = &record.parent_frame {
            let parent = self.by_id(parent)?;
            if !crate::verbs::capabilities::SLOTS.contains(&parent.grant.slot.as_str())
                || parent.message.is_some()
            {
                return None;
            }
        }
        (record.grant == grant).then_some(grant)
    }
}
impl FrameRecord {
    pub fn allows_path(&self, file: &Path) -> bool {
        if !self.policy.own_folder_only && !(self.policy.team_safe && self.message.is_some()) {
            return true;
        }
        if file.components().any(|c| matches!(c, Component::ParentDir)) {
            return false;
        }
        let Ok(real) = file.canonicalize() else {
            return false;
        };
        let document = PathBuf::from(&self.document_path).canonicalize().ok();
        let folder = PathBuf::from(&self.asset_folder).canonicalize().ok();
        (!self.policy.own_folder_only
            || document.as_ref() == Some(&real)
            || folder.is_some_and(|dir| real.starts_with(dir)))
            && (!self.policy.team_safe
                || PathBuf::from(&self.content_root)
                    .canonicalize()
                    .ok()
                    .is_some_and(|dir| real.starts_with(dir))
                || self.message.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    fn mint(store: &FrameStore) -> FrameRecord {
        store.mint(
            9321,
            FrameGrant {
                frame_id: String::new(),
                principal: "human".into(),
                dashboard: "board".into(),
                slot: "centre".into(),
                team: None,
                scope: "open".into(),
            },
            "/ctx".into(),
            "/ctx/board.html".into(),
            "/ctx".into(),
            FramePolicy::default(),
            None,
        )
    }
    #[test]
    fn origin_token_and_teardown_are_bound() {
        let store = FrameStore::default();
        let a = mint(&store);
        let b = mint(&store);
        assert_ne!(a.origin, b.origin);
        assert!(store.resolve(&a.origin, &a.token).is_some());
        assert!(store.resolve(&a.origin, &b.token).is_none());
        assert!(store.by_host("f-unknown.localhost:9321", 9321).is_none());
        assert!(store
            .by_host(a.origin.trim_start_matches("http://"), 9321)
            .is_some());
        store.release(&a.frame_id);
        assert!(store.resolve(&a.origin, &a.token).is_none());
        assert!(store.by_origin(&a.origin).is_none());
        assert_ne!(mint(&store).origin, a.origin);
    }
    #[test]
    fn restricted_files_and_symlinks_stay_in_the_asset_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let own = tmp.path().join("own");
        let other = tmp.path().join("other");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(own.join("board.html"), "board").unwrap();
        std::fs::write(own.join("asset.js"), "asset").unwrap();
        std::fs::write(other.join("private.txt"), "private").unwrap();
        let mut record = mint(&FrameStore::default());
        record.document_path = own.join("board.html").to_string_lossy().into_owned();
        record.asset_folder = own.to_string_lossy().into_owned();
        record.policy.own_folder_only = true;
        assert!(record.allows_path(&own.join("board.html")));
        assert!(record.allows_path(&own.join("asset.js")));
        assert!(!record.allows_path(&other.join("private.txt")));
        assert!(!record.allows_path(&own.join("../other/private.txt")));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(other.join("private.txt"), own.join("link.txt")).unwrap();
            assert!(!record.allows_path(&own.join("link.txt")));
        }
        record.policy.own_folder_only = false;
        assert!(record.allows_path(&other.join("private.txt")));
    }
    #[test]
    fn team_safe_message_files_stay_in_the_stored_team_but_open_does_not_narrow_them() {
        let tmp = tempfile::tempdir().unwrap();
        let team = tmp.path().join("a");
        let private = tmp.path().join("private");
        std::fs::create_dir_all(&team).unwrap();
        std::fs::create_dir_all(&private).unwrap();
        std::fs::write(team.join("own.txt"), "a").unwrap();
        std::fs::write(private.join("mail.txt"), "private").unwrap();
        let mut record = mint(&FrameStore::default());
        record.content_root = team.to_string_lossy().into_owned();
        record.asset_folder = record.content_root.clone();
        record.document_path = "inbox-message://acme/a/7".into();
        record.message = Some(FrameMessage {
            org: "acme".into(),
            team: "a".into(),
            message_id: 7,
        });
        assert!(record.allows_path(&private.join("mail.txt")));
        record.policy.team_safe = true;
        assert!(record.allows_path(&team.join("own.txt")));
        assert!(!record.allows_path(&private.join("mail.txt")));
    }
    #[test]
    fn default_policy_denies_outside_network_and_keeps_paths_open() {
        let record = mint(&FrameStore::default());
        assert!(
            !record.policy.own_folder_only
                && !record.policy.block_service_workers
                && record.policy.no_outside_network
                && record.policy.allowed_hosts.is_empty()
        );
        assert!(record.policy.blocks_service_workers());
        assert!(record.allows_path(Path::new("/another-team/content/file")));
        // A renderer that sends `{}` gets the same closed default.
        let supplied: FramePolicy = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(supplied.no_outside_network);
    }
    #[test]
    fn allowed_hosts_accept_only_exact_https_origins() {
        let hosts = |values: &[&str]| {
            AllowedHosts::parse(&values.iter().map(|v| v.to_string()).collect::<Vec<_>>())
        };
        assert_eq!(
            hosts(&[
                "https://api.example.com",
                "https://API.example.com/",
                "https://cdn.example.com:8443",
                "https://api.example.com:443",
            ])
            .unwrap()
            .0,
            ["https://api.example.com", "https://cdn.example.com:8443"]
        );
        // Private ranges are built from their octets.
        let private = [Ipv4Addr::new(10, 0, 0, 1), Ipv4Addr::new(192, 168, 1, 10)]
            .map(|ip| format!("https://{ip}"));
        for bad in [
            "http://api.example.com",
            "https://*.example.com",
            "*",
            "https://api.example.com/path",
            "https://api.example.com/?q=1",
            "https://api.example.com/#x",
            "https://user@api.example.com",
            "https://a.example.com;script-src",
            "wss://api.example.com",
            "file:///etc/passwd",
            "data:text/plain,x",
            "api.example.com",
            "https://example.com.",
            "https://.example.com",
            "https://a..example.com",
            "https://api.example.com:0",
            "https://127.0.0.1",
            "https://169.254.0.1",
            "https://203.0.113.10",
            "https://[::1]",
            "https://[fe80::1]",
            "https://localhost",
            "https://LOCALHOST:8443",
            "https://app.localhost",
            "https://intranet",
            "https://printer:443",
        ]
        .into_iter()
        .chain(private.iter().map(String::as_str))
        {
            let error = hosts(&[bad]).unwrap_err();
            assert!(
                error.contains("exact https://host[:port] origin"),
                "{bad}: {error}"
            );
        }
    }
    #[test]
    fn the_local_name_hatch_is_test_only_and_set_only_by_the_browser_fixture() {
        let source = include_str!("frame.rs");
        assert!(source
            .contains("#[cfg(not(test))]\nfn fixture_loopback(_: &str) -> bool {\n    false\n}"));
        assert!(source.contains("#[cfg(test)]\npub(crate) static FIXTURE_LOOPBACK:"));
        assert!(source.contains("#[cfg(test)]\nfn fixture_loopback(domain: &str) -> bool {"));
        let viewer = include_str!("../http/routes/viewer.rs");
        assert_eq!(viewer.matches("FIXTURE_LOOPBACK").count(), 1);
        let fixture = &viewer[viewer.find("async fn hostile_fixture_server()").unwrap()..];
        assert!(
            fixture.find("FIXTURE_LOOPBACK").unwrap()
                > fixture.find("CODESENSE_FRAME_FIXTURE").unwrap()
        );
        // With the hatch off, as in every other test and every shipped build.
        assert!(!FIXTURE_LOOPBACK.load(std::sync::atomic::Ordering::Relaxed));
        assert!(AllowedHosts::parse(&["https://localhost".into()]).is_err());
    }
    #[test]
    fn document_hosts_come_from_the_nearest_dashboard_manifest_inside_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("team/content");
        let board = root.join("board");
        let page = board.join("pages/index.html");
        std::fs::create_dir_all(page.parent().unwrap()).unwrap();
        let hosts = || AllowedHosts::for_document(&page, &root);
        assert!(hosts().unwrap().0.is_empty());
        // Above the content root is outside the document's dashboard.
        std::fs::write(
            tmp.path().join("team/dashboard.yml"),
            "allowed_hosts: [https://outer.example.com]\n",
        )
        .unwrap();
        assert!(hosts().unwrap().0.is_empty());
        std::fs::write(
            root.join(DASHBOARD_MANIFEST),
            "allowed_hosts: [https://root.example.com]\n",
        )
        .unwrap();
        assert_eq!(hosts().unwrap().0, ["https://root.example.com"]);
        std::fs::write(
            board.join(DASHBOARD_MANIFEST),
            "slug: board\ntitle: Board\nallowed_hosts: [https://api.example.com]\n",
        )
        .unwrap();
        assert_eq!(hosts().unwrap().0, ["https://api.example.com"]);
        std::fs::write(board.join(DASHBOARD_MANIFEST), "slug: board\n").unwrap();
        assert!(hosts().unwrap().0.is_empty());
        // `..` and symlinked folders that lead outside the root declare nothing.
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(
            outside.join(DASHBOARD_MANIFEST),
            "allowed_hosts: [https://outside.example.com]\n",
        )
        .unwrap();
        let dotted = root.join("../../outside/page.html");
        assert!(AllowedHosts::for_document(&dotted, &root)
            .unwrap()
            .0
            .is_empty());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            let linked = root.join("linked/page.html");
            assert!(AllowedHosts::for_document(&linked, &root)
                .unwrap()
                .0
                .is_empty());
            // A manifest inside the root that links outside it is refused.
            std::fs::remove_file(board.join(DASHBOARD_MANIFEST)).unwrap();
            std::os::unix::fs::symlink(
                outside.join(DASHBOARD_MANIFEST),
                board.join(DASHBOARD_MANIFEST),
            )
            .unwrap();
            let error = hosts().unwrap_err();
            assert!(
                error.contains("resolves outside the content root"),
                "{error}"
            );
            std::fs::remove_file(board.join(DASHBOARD_MANIFEST)).unwrap();
        }
        for bad in [
            "allowed_hosts: [http://api.example.com]\n",
            "allowed_hosts: [https://*.example.com]\n",
            "allowed_hosts: [https://api.example.com/v1]\n",
            "allowed_hosts: https://api.example.com\n",
            "allowed_hosts: [https://api.example.com\n",
        ] {
            std::fs::write(board.join(DASHBOARD_MANIFEST), bad).unwrap();
            let error = hosts().unwrap_err();
            assert!(
                error.contains("dashboard.yml: allowed_hosts:"),
                "{bad}: {error}"
            );
        }
    }
    #[test]
    fn child_frames_inherit_network_denial_and_only_narrow_hosts() {
        let frames = FrameStore::default();
        let make = |slot: &str, policy: FramePolicy, message: Option<i64>| {
            let mut grant = mint(&frames).grant;
            grant.slot = slot.into();
            frames.mint(
                9321,
                grant,
                "/ctx".into(),
                "/ctx/panes/pane.html".into(),
                "/ctx".into(),
                policy,
                message.map(|message_id| FrameMessage {
                    org: "acme".into(),
                    team: "mail".into(),
                    message_id,
                }),
            )
        };
        let hosts = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
        let pane = make(
            "right-pane",
            FramePolicy {
                allowed_hosts: hosts(&["https://one.example", "https://two.example"]),
                ..Default::default()
            },
            None,
        );
        let wider = make(
            "message",
            FramePolicy {
                no_outside_network: false,
                allowed_hosts: hosts(&["https://two.example", "https://three.example"]),
                ..Default::default()
            },
            Some(1),
        );
        let linked = frames.link_child(&wider.frame_id, &pane.frame_id).unwrap();
        assert!(linked.policy.no_outside_network);
        assert_eq!(linked.policy.allowed_hosts, ["https://two.example"]);
        // A child with no hosts of its own gains none from the parent.
        let closed = make("message", FramePolicy::default(), Some(2));
        let linked = frames.link_child(&closed.frame_id, &pane.frame_id).unwrap();
        assert!(linked.policy.no_outside_network && linked.policy.allowed_hosts.is_empty());
        assert_eq!(
            frames.by_id(&closed.frame_id).unwrap().policy.allowed_hosts,
            Vec::<String>::new()
        );
    }
    #[test]
    fn caller_kind_comes_from_mint_facts_even_when_capabilities_are_open() {
        for (slot, document, has_team, expected) in [
            (
                "centre",
                "/ctx/private/board.html",
                false,
                FrameCallerKind::Private,
            ),
            (
                "right-pane",
                "/ctx/team/panes/board.html",
                true,
                FrameCallerKind::Team,
            ),
            (
                "message",
                "/ctx/team/message.html",
                true,
                FrameCallerKind::Message,
            ),
            (
                "centre",
                "inbox-message://acme/team/7",
                true,
                FrameCallerKind::Message,
            ),
            ("centre", "builtin:agents", false, FrameCallerKind::Builtin),
        ] {
            let store = FrameStore::default();
            let record = store.mint(
                9321,
                FrameGrant {
                    frame_id: String::new(),
                    principal: "human".into(),
                    dashboard: document.into(),
                    slot: slot.into(),
                    team: has_team.then(|| FrameTeam {
                        org: "acme".into(),
                        team: "team".into(),
                    }),
                    scope: "open".into(),
                },
                "/ctx".into(),
                document.into(),
                "/ctx".into(),
                FramePolicy::default(),
                None,
            );
            assert_eq!(record.kind, expected);
            assert_eq!(
                store.resolve(&record.origin, &record.token).unwrap().scope,
                "open"
            );
        }
    }
    #[test]
    fn child_message_identity_requires_a_live_pane_parent_and_revokes_with_it() {
        let frames = FrameStore::default();
        let make = |slot: &str, message| {
            let mut grant = mint(&frames).grant;
            grant.slot = slot.into();
            frames.mint(
                9321,
                grant,
                "/ctx".into(),
                "/ctx/message.html".into(),
                "/ctx".into(),
                FramePolicy::default(),
                message,
            )
        };
        let pane = make("right-pane", None);
        let foreign = make("centre", None);
        let child = make(
            "message",
            Some(FrameMessage {
                org: "acme".into(),
                team: "mail".into(),
                message_id: 7,
            }),
        );
        assert!(frames
            .link_child(&child.frame_id, &foreign.frame_id)
            .is_err());
        assert!(frames
            .link_child(&foreign.frame_id, &pane.frame_id)
            .is_err());
        assert!(frames.link_child(&child.frame_id, "missing").is_err());
        let child = frames.link_child(&child.frame_id, &pane.frame_id).unwrap();
        assert_eq!(child.parent_frame.as_deref(), Some(pane.frame_id.as_str()));
        assert!(frames.resolve(&child.origin, &child.token).is_some());
        assert!(frames.resolve(&child.origin, &pane.token).is_none());
        assert!(frames.resolve(&pane.origin, &child.token).is_none());
        frames.release(&pane.frame_id);
        assert!(frames.by_origin(&child.origin).is_none());
        assert!(frames.resolve(&child.origin, &child.token).is_none());
    }
}
