// SPDX-License-Identifier: MIT
//! `pack.yml` (`pack_format: 1`). Plain `//` comments only on the schema types: a doc
//! comment becomes a `description` in the exported JSON Schema.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PACK_FORMAT: u32 = 1;

// A pack is a recipe: our own parts, plus references to anyone else's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct PackManifest {
    pub pack_format: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub summary: String,
    #[serde(default, rename = "for", skip_serializing_if = "Option::is_none")]
    pub audience: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Requires>,
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<Setting>,
    // Globs of step files the setup guide reads once the pack is installed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup_steps: Vec<String>,
    // Written by the pack build: every bundled file with its hash.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<FileEntry>,
    // Per-part spec hashes, null for a part without one. The pack build doesn't write
    // these; a later change fills them in.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub spec_hash: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct Requires {
    // The CodeSense versions this pack needs (`>=0.2.0 <1.0.0`). An older app refuses the
    // pack, so this is how a pack uses fields or values newer than its `pack_format`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codesense: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clis: Vec<CliRequirement>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpRequirement>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routines: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub integrations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit: Option<KitRequirement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct CliRequirement {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    #[serde(default, rename = "for", skip_serializing_if = "Vec::is_empty")]
    pub for_parts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct McpRequirement {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

// The dashboard kit modules a pack's pages need, by module name and major version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct KitRequirement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<u32>,
}

// Where a `kind: skill` part is built for each runtime.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    rmcp::schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum SkillTarget {
    Claude,
    Codex,
    Opencode,
    Hermes,
}

impl SkillTarget {
    pub const ALL: [SkillTarget; 4] = [
        SkillTarget::Claude,
        SkillTarget::Codex,
        SkillTarget::Opencode,
        SkillTarget::Hermes,
    ];

    // Where the built copy of skill `name` lives, relative to the pack root.
    pub fn built_path(self, name: &str) -> String {
        match self {
            SkillTarget::Claude => format!(".claude/skills/{name}/SKILL.md"),
            SkillTarget::Codex => format!(".agents/skills/{name}/SKILL.md"),
            SkillTarget::Opencode => format!(".opencode/command/{name}.md"),
            SkillTarget::Hermes => format!(".hermes/skills/{name}/SKILL.md"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExternalMethod {
    // A fetched archive with mapped paths; nothing runs.
    Files,
    // The upstream's own installer, run by the user's agent after install.
    Setup,
}

// Which upstream version an external part tracks: the tested pin, or the newest within
// `compatible` (opt-in per part).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Follow {
    Pinned,
    LatestCompatible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct ExternalSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct SetupVerify {
    pub read: String,
    pub field: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct ExternalSetup {
    pub run: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<SetupVerify>,
}

// What the store lists and lets a person tick. Every kind carries `id` and `needs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
    Preset {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        includes: Vec<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        default: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    Agent {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        file: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    Content {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        paths: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    // One source file built into each target runtime's own skill or command location.
    Skill {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        source: String,
        targets: Vec<SkillTarget>,
        // The built skill's name; the part id when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    Routine {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        file: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    Dashboards {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        paths: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    Seed {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        starter_page: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    // Someone else's code, by reference: declared and previewed, never bundled or fetched here.
    External {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        method: ExternalMethod,
        source: ExternalSource,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        integrity: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tree_sha256: Option<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        paths: BTreeMap<String, Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compatible: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        follow: Option<Follow>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        setup: Option<ExternalSetup>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect_license: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trademark: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
    // One exact upstream command the person's agent runs after install.
    Setup {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        needs: Vec<String>,
    },
}

impl Part {
    pub fn id(&self) -> &str {
        match self {
            Part::Preset { id, .. }
            | Part::Agent { id, .. }
            | Part::Content { id, .. }
            | Part::Skill { id, .. }
            | Part::Routine { id, .. }
            | Part::Dashboards { id, .. }
            | Part::Seed { id, .. }
            | Part::External { id, .. }
            | Part::Setup { id, .. } => id,
        }
    }

    pub fn needs(&self) -> &[String] {
        match self {
            Part::Preset { needs, .. }
            | Part::Agent { needs, .. }
            | Part::Content { needs, .. }
            | Part::Skill { needs, .. }
            | Part::Routine { needs, .. }
            | Part::Dashboards { needs, .. }
            | Part::Seed { needs, .. }
            | Part::External { needs, .. }
            | Part::Setup { needs, .. } => needs,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Preset { .. } => "preset",
            Part::Agent { .. } => "agent",
            Part::Content { .. } => "content",
            Part::Skill { .. } => "skill",
            Part::Routine { .. } => "routine",
            Part::Dashboards { .. } => "dashboards",
            Part::Seed { .. } => "seed",
            Part::External { .. } => "external",
            Part::Setup { .. } => "setup",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, rmcp::schemars::JsonSchema)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exec: bool,
}
