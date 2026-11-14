// SPDX-License-Identifier: MIT
//! Risk facts, derived from a pack's files and parts and never from what its publisher
//! says: executable files and scripts, CLI hooks, agents that skip permission checks, MCP
//! servers, routines, setup steps (an upstream command the person's agent runs) and every
//! network fetch an external part implies. A `risk:` key in `pack.yml` is not read.

use std::path::Path;

use globset::Glob;
use serde::Serialize;

use super::manifest::{ExternalMethod, PackManifest, Part};

// Markers a pack agent can carry that make its CLI skip permission checks, beyond each
// CLI's own bypass flag (which the agent adapter knows).
const SKIP_MARKERS: &[&str] = &["bypassPermissions", "--yolo"];

const SCRIPT_EXTENSIONS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "py", "rb", "pl", "ps1", "bat", "cmd",
];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookFact {
    pub path: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipPermissionFact {
    pub agent: String,
    pub marker: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFact {
    pub path: String,
    pub server: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFact {
    pub part: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchFact {
    pub part: String,
    pub source: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskFacts {
    pub executables: Vec<String>,
    pub scripts: Vec<String>,
    pub cli_hooks: Vec<HookFact>,
    pub skip_permission_agents: Vec<SkipPermissionFact>,
    pub mcp_servers: Vec<McpFact>,
    pub routines: Vec<String>,
    // The pack's own setup-step files: the guide reads and runs these after install.
    pub setup_step_files: Vec<String>,
    // Exact upstream commands the person's agent runs.
    pub setup_steps: Vec<SetupFact>,
    pub network_fetches: Vec<FetchFact>,
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

fn is_script(name: &str, bytes: &[u8]) -> bool {
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    bytes.starts_with(b"#!") || extension.is_some_and(|e| SCRIPT_EXTENSIONS.contains(&e.as_str()))
}

fn collect_strings(value: &serde_yaml::Value, out: &mut Vec<String>) {
    match value {
        serde_yaml::Value::String(s) => out.push(s.clone()),
        serde_yaml::Value::Sequence(items) => items.iter().for_each(|v| collect_strings(v, out)),
        serde_yaml::Value::Mapping(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

fn skips_permissions(arg: &str) -> bool {
    crate::agents::adapter::is_escalating_flag(arg) || SKIP_MARKERS.contains(&arg)
}

fn agent_facts(rel: &str, bytes: &[u8], facts: &mut RiskFacts) {
    let Ok(agent) = serde_yaml::from_slice::<serde_yaml::Value>(bytes) else {
        return;
    };
    let mut strings = Vec::new();
    for key in ["args", "permissions"] {
        if let Some(value) = agent.get(key) {
            collect_strings(value, &mut strings);
        }
    }
    for marker in strings.into_iter().filter(|s| skips_permissions(s)) {
        facts.skip_permission_agents.push(SkipPermissionFact {
            agent: rel.to_string(),
            marker,
        });
    }
    if let Some(servers) = agent.get("mcp").and_then(|m| m.get("servers")) {
        let mut names = Vec::new();
        collect_strings(servers, &mut names);
        for server in names {
            facts.mcp_servers.push(McpFact {
                path: rel.to_string(),
                server,
            });
        }
    }
}

fn config_facts(rel: &str, name: &str, bytes: &[u8], facts: &mut RiskFacts) {
    let text = String::from_utf8_lossy(bytes);
    let json: Option<serde_json::Value> = serde_json::from_str(&text).ok();
    match name {
        "settings.json" | "settings.local.json" | "hooks.json" | "opencode.json" => {
            if json.as_ref().is_some_and(|j| j.get("hooks").is_some()) {
                facts.cli_hooks.push(HookFact {
                    path: rel.to_string(),
                    detail: format!("`hooks` in {name}"),
                });
            }
        }
        "config.toml" => {
            if text
                .parse::<toml::Table>()
                .is_ok_and(|t| t.contains_key("hooks"))
            {
                facts.cli_hooks.push(HookFact {
                    path: rel.to_string(),
                    detail: "`hooks` in config.toml".to_string(),
                });
            }
        }
        _ => {}
    }
    let servers = match name {
        ".mcp.json" => json.as_ref().and_then(|j| j.get("mcpServers")),
        "opencode.json" => json.as_ref().and_then(|j| j.get("mcp")),
        _ => None,
    };
    if let Some(servers) = servers.and_then(|s| s.as_object()) {
        for server in servers.keys() {
            facts.mcp_servers.push(McpFact {
                path: rel.to_string(),
                server: server.clone(),
            });
        }
    }
}

fn part_facts(manifest: &PackManifest, facts: &mut RiskFacts) {
    for part in &manifest.parts {
        let id = part.id().to_string();
        match part {
            Part::Routine { file, .. } => facts.routines.push(file.clone()),
            Part::Setup { command, .. } => facts.setup_steps.push(SetupFact {
                part: id,
                command: command.clone(),
            }),
            Part::External {
                method,
                source,
                version,
                setup,
                ..
            } => {
                let origin = match (&source.npm, &source.git) {
                    (Some(npm), _) => format!("npm:{npm}"),
                    (None, Some(git)) => git.clone(),
                    (None, None) => String::new(),
                };
                facts.network_fetches.push(FetchFact {
                    part: id.clone(),
                    source: origin,
                    version: version.clone(),
                });
                if let (ExternalMethod::Setup, Some(setup)) = (method, setup) {
                    facts.setup_steps.push(SetupFact {
                        part: id,
                        command: setup.run.clone(),
                    });
                }
            }
            _ => {}
        }
    }
}

/// The facts for the pack at `root`. `files` are its regular files, relative with `/`;
/// a file over `max_file` bytes is not read.
pub fn derive(root: &Path, manifest: &PackManifest, files: &[String], max_file: u64) -> RiskFacts {
    let mut facts = RiskFacts::default();
    let steps: Vec<_> = manifest
        .setup_steps
        .iter()
        .filter_map(|g| Glob::new(g).ok())
        .map(|g| g.compile_matcher())
        .collect();
    for rel in files {
        let path = root.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let slashed = format!("/{rel}");
        let bytes = if meta.len() <= max_file {
            std::fs::read(&path).unwrap_or_default()
        } else {
            Vec::new()
        };
        if is_executable(&meta) {
            facts.executables.push(rel.clone());
        }
        if is_script(name, &bytes) {
            facts.scripts.push(rel.clone());
        }
        for hooks in ["/.claude/hooks/", "/.codex/hooks/"] {
            if slashed.contains(hooks) {
                facts.cli_hooks.push(HookFact {
                    path: rel.clone(),
                    detail: format!("a file under {}", hooks.trim_matches('/')),
                });
            }
        }
        if name == "agent.yaml" {
            agent_facts(rel, &bytes, &mut facts);
        }
        config_facts(rel, name, &bytes, &mut facts);
        if slashed.contains("/routines/") && (name == "routine.yml" || name == "routine.yaml") {
            facts.routines.push(rel.clone());
        }
        if steps.iter().any(|m| m.is_match(rel)) {
            facts.setup_step_files.push(rel.clone());
        }
    }
    part_facts(manifest, &mut facts);
    facts.executables.sort();
    facts.scripts.sort();
    facts.cli_hooks.sort();
    facts.skip_permission_agents.sort();
    facts.mcp_servers.sort();
    facts.routines.sort();
    facts.setup_step_files.sort();
    facts.setup_steps.sort();
    facts.network_fetches.sort();
    for list in [
        &mut facts.executables,
        &mut facts.scripts,
        &mut facts.routines,
        &mut facts.setup_step_files,
    ] {
        list.dedup();
    }
    facts.cli_hooks.dedup();
    facts.skip_permission_agents.dedup();
    facts.mcp_servers.dedup();
    facts
}
