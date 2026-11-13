// SPDX-License-Identifier: MIT
//! `packs.lock.yml` (`lock_format: 1`), written into the target team by the installer
//! (a later story). This story only defines and exports the shape. Plain `//` comments
//! only on the schema types: a doc comment becomes a `description` in the JSON Schema.

use serde::{Deserialize, Serialize};

use super::manifest::ExternalMethod;

pub const LOCK_FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct PacksLock {
    pub lock_format: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packs: Vec<LockedPack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockedPack {
    pub id: String,
    pub version: String,
    pub source: LockSource,
    pub archive_sha256: String,
    pub trust: LockTrust,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_sequence: Option<u32>,
    pub installed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_team: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_parent: Option<String>,
    pub parts: LockParts,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<LockAgent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routines: Vec<LockRoutine>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seeds: Vec<LockSeed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub external: Vec<LockExternal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LockTrust {
    Verified,
    Bundled,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LockSourceKind {
    Catalog,
    Url,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockSource {
    pub kind: LockSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockParts {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub installed: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockAgent {
    pub id: String,
    pub revision: u32,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockRoutine {
    pub id: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub enabled_at_install: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockSeed {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockLicense {
    pub spdx: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockSetupState {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct LockExternal {
    pub id: String,
    pub method: ExternalMethod,
    pub source: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<LockLicense>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<LockSetupState>,
}
