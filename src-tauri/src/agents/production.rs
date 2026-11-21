// SPDX-License-Identifier: MIT
//! Production MCP servers an agent declares in `agent.yaml` `mcp.production`:
//! remote HTTPS servers whose credential a person binds to that one agent
//! through a native-only command. The declaration holds header names only,
//! never a value, and it can only select or narrow what the person bound.
//!
//! Everything here is pure: the declaration's shape, the URL and header checks
//! that a save, a bind and every relay connect re-run, the fingerprint a bind
//! compares, and the rule deciding whether a binding covers a declaration.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The most header names one credential carries.
pub const MAX_PRODUCTION_HEADERS: usize = 4;

/// Header names the HTTP transport owns; a credential can never set one.
pub const RESERVED_TRANSPORT_HEADERS: [&str; 7] = [
    "host",
    "content-length",
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
];

/// Substrings that mark a URL query key as a likely secret (matched without
/// case): `token`, `secret`, `password`, `passwd`, `api_key`/`apikey` (both
/// contain `key`), `auth`, `bearer`, `credential`, `signature` (contains `sig`).
const SECRET_QUERY_KEY_PARTS: [&str; 9] = [
    "token",
    "secret",
    "password",
    "passwd",
    "key",
    "auth",
    "bearer",
    "credential",
    "sig",
];

/// One production server, exactly as declared. `command` and `args` are not
/// fields, so a stdio declaration is refused by `deny_unknown_fields`, as is a
/// literal `env` or `headers` map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProductionServer {
    /// The MCP server name the session sees: `mcp__<name>__<tool>`.
    pub name: String,
    /// An `https` URL with no user info, no fragment and no secret-named query
    /// key. Stored in git and shown to anyone who can read the agent.
    pub url: String,
    pub credential: ProductionCredential,
    /// Tools callable even though the server does not mark them read-only.
    /// Effective only for tools the person's binding also allows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write: Vec<String>,
}

/// Which credential the server uses: the keychain ref and the header names it
/// fills. Never a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProductionCredential {
    #[serde(rename = "ref")]
    pub reference: String,
    pub headers: Vec<String>,
}

/// What a person approved for one credential ref, without the header values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingSummary {
    /// The canonical agent id (`<org>/<team>/<key>`) the server is granted to.
    pub agent: String,
    pub url: String,
    /// Lowercased header names.
    pub headers: BTreeSet<String>,
    pub write: BTreeSet<String>,
}

/// Production servers run only where the credential store has a per-app ACL.
pub fn platform_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Why production servers are refused on this platform.
pub const UNSUPPORTED_PLATFORM: &str =
    "mcp.production is supported only on macOS, where the keychain guards the credential";

/// 1-64 lowercase letters, digits or '-', starting with a letter or digit:
/// a production server name or a credential ref.
pub fn is_valid_name(name: &str) -> bool {
    super::model::is_valid_id(name)
}

/// The URL checks a save, a bind and every connect run.
pub fn check_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "is not a valid URL".to_string())?;
    if url.scheme() != "https" {
        return Err("must use https".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("needs a host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not carry user info".into());
    }
    if url.fragment().is_some() {
        return Err("must not carry a fragment".into());
    }
    if let Some((key, _)) = url.query_pairs().find(|(key, _)| is_secret_query_key(key)) {
        return Err(format!(
            "query key {key:?} looks like a secret; the URL is public, so put secrets in a credential header"
        ));
    }
    Ok(())
}

fn is_secret_query_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    SECRET_QUERY_KEY_PARTS.iter().any(|part| key.contains(part))
}

/// The header-name checks a save and a bind run. Returns the lowercased set.
pub fn check_headers(names: &[String]) -> Result<BTreeSet<String>, String> {
    if names.is_empty() {
        return Err("needs at least one header name".into());
    }
    if names.len() > MAX_PRODUCTION_HEADERS {
        return Err(format!(
            "has {} header names; a credential carries at most {MAX_PRODUCTION_HEADERS}",
            names.len()
        ));
    }
    let mut seen = BTreeSet::new();
    for name in names {
        let lower = name.to_ascii_lowercase();
        if reqwest_mcp::header::HeaderName::from_bytes(lower.as_bytes()).is_err() {
            return Err(format!("header name {name:?} is not valid"));
        }
        if RESERVED_TRANSPORT_HEADERS.contains(&lower.as_str()) {
            return Err(format!("header {name:?} belongs to the MCP transport"));
        }
        if !seen.insert(lower) {
            return Err(format!("header {name:?} is listed twice"));
        }
    }
    Ok(seen)
}

/// A tool name as an MCP server reports it.
fn is_valid_tool(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-./".contains(&b))
}

impl ProductionServer {
    /// Lowercased header names.
    pub fn header_names(&self) -> BTreeSet<String> {
        self.credential
            .headers
            .iter()
            .map(|name| name.to_ascii_lowercase())
            .collect()
    }

    pub fn write_set(&self) -> BTreeSet<String> {
        self.write.iter().cloned().collect()
    }

    /// The entry's own checks: name, URL, credential and `write`.
    pub fn check(&self) -> Result<(), String> {
        if !is_valid_name(&self.credential.reference) {
            return Err(format!(
                "credential ref {:?} is unknown: a ref is 1-64 lowercase letters, digits or '-'",
                self.credential.reference
            ));
        }
        check_url(&self.url).map_err(|why| format!("url {why}"))?;
        check_headers(&self.credential.headers)?;
        let mut seen = BTreeSet::new();
        for tool in &self.write {
            if !is_valid_tool(tool) {
                return Err(format!("write tool {tool:?} is not a valid tool name"));
            }
            if !seen.insert(tool) {
                return Err(format!("write tool {tool:?} is listed twice"));
            }
        }
        Ok(())
    }

    /// SHA-256 (hex) of the canonical declaration a bind compares, so an edit
    /// between what a person was shown and their click binds nothing.
    pub fn fingerprint(&self, agent: &str) -> String {
        // Fields in a fixed (alphabetical) order; the sets are sorted.
        #[derive(Serialize)]
        struct Canonical<'a> {
            agent: &'a str,
            entry: &'a str,
            headers: BTreeSet<String>,
            #[serde(rename = "ref")]
            reference: &'a str,
            url: &'a str,
            write: BTreeSet<String>,
        }
        let canonical = Canonical {
            agent,
            entry: &self.name,
            headers: self.header_names(),
            reference: &self.credential.reference,
            url: &self.url,
            write: self.write_set(),
        };
        let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
        format!("{:x}", Sha256::digest(&bytes))
    }

    /// The binding this declaration would store for `agent`.
    pub fn binding_for(&self, agent: &str) -> BindingSummary {
        BindingSummary {
            agent: agent.to_string(),
            url: self.url.clone(),
            headers: self.header_names(),
            write: self.write_set(),
        }
    }
}

/// Why a binding does not cover a declaration (the server is then
/// `productionPending`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    /// No binding for the ref, or the store could not be read.
    Unbound,
    /// The ref is bound to another agent id.
    OtherAgent,
    /// The declared URL differs from the bound one.
    Url,
    /// The declared header names differ from the bound ones.
    Headers,
    /// The declaration adds a `write` tool the binding does not allow.
    Write,
}

impl Pending {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unbound => "unbound",
            Self::OtherAgent => "bound to another agent",
            Self::Url => "url changed since it was bound",
            Self::Headers => "header names changed since they were bound",
            Self::Write => "write widened since it was bound",
        }
    }
}

/// Whether `binding` covers `entry` declared on `agent`: same agent id, URL and
/// header names, and a declared `write` within the bound one. On a match,
/// returns the effective `write` (bound ∩ declared, which is the declared set).
pub fn covers(
    binding: Option<&BindingSummary>,
    agent: &str,
    entry: &ProductionServer,
) -> Result<BTreeSet<String>, Pending> {
    let binding = binding.ok_or(Pending::Unbound)?;
    if binding.agent != agent {
        return Err(Pending::OtherAgent);
    }
    if binding.url != entry.url {
        return Err(Pending::Url);
    }
    if binding.headers != entry.header_names() {
        return Err(Pending::Headers);
    }
    let declared = entry.write_set();
    if !declared.is_subset(&binding.write) {
        return Err(Pending::Write);
    }
    Ok(declared.intersection(&binding.write).cloned().collect())
}
