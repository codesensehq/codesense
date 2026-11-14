// SPDX-License-Identifier: MIT
//! Risk facts, derived from a pack's files and parts and never from what its publisher
//! says: executable files and scripts, CLI hooks, agents that skip permission checks, MCP
//! servers, routines, setup steps (an upstream command the person's agent runs) and every
//! network fetch an external part implies. A `risk:` key in `pack.yml` is not read.

use std::collections::{BTreeMap, BTreeSet};
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

// Every string in `value`, mapping keys included (`{bypassPermissions: true}`).
fn collect_strings(value: &serde_yaml::Value, out: &mut Vec<String>) {
    match value {
        serde_yaml::Value::String(s) => out.push(s.clone()),
        serde_yaml::Value::Sequence(items) => items.iter().for_each(|v| collect_strings(v, out)),
        serde_yaml::Value::Mapping(map) => {
            for (key, v) in map {
                collect_strings(key, out);
                collect_strings(v, out);
            }
        }
        _ => {}
    }
}

// A bypass flag or marker, alone or as the value of `--flag=value`.
fn skips_permissions(arg: &str) -> bool {
    let value = arg.split_once('=').map(|(_, v)| v);
    [Some(arg), value]
        .into_iter()
        .flatten()
        .any(|a| crate::agents::adapter::is_escalating_flag(a) || SKIP_MARKERS.contains(&a))
}

// `false` when the file doesn't parse as an `Agent`: its permission keys can't be read.
fn agent_facts(rel: &str, bytes: &[u8], facts: &mut RiskFacts) -> bool {
    let Ok(agent) = serde_yaml::from_slice::<serde_yaml::Value>(bytes) else {
        return false;
    };
    let mut strings: Vec<String> = Default::default();
    for key in ["args", "permissions"] {
        if let Some(value) = agent.get(key) {
            collect_strings(value, &mut strings);
        }
    }
    let before = facts.skip_permission_agents.len();
    for marker in strings.into_iter().filter(|s| skips_permissions(s)) {
        facts.skip_permission_agents.push(SkipPermissionFact {
            agent: rel.to_string(),
            marker,
        });
    }
    // The app's own reading of the agent: a runtime's flag pairs and permission keys
    // (Codex `-s danger-full-access -a never`) that no single string shows.
    let typed = serde_yaml::from_slice::<crate::agents::model::Agent>(bytes);
    let escalating = typed
        .as_ref()
        .is_ok_and(crate::agents::model::Agent::is_escalating);
    if escalating && facts.skip_permission_agents.len() == before {
        facts.skip_permission_agents.push(SkipPermissionFact {
            agent: rel.to_string(),
            marker: "skips permission checks (its runtime's flags or permissions)".to_string(),
        });
    }
    if let Some(servers) = agent.get("mcp").and_then(|m| m.get("servers")) {
        let mut names: Vec<String> = Default::default();
        collect_strings(servers, &mut names);
        for server in names {
            facts.mcp_servers.push(McpFact {
                path: rel.to_string(),
                server,
            });
        }
    }
    typed.is_ok()
}

// Keys whose value is a command the CLI runs on its own.
const SETTINGS_COMMANDS: &[&str] = &["hooks", "statusLine", "apiKeyHelper"];
const CODEX_COMMANDS: &[&str] = &["hooks", "notify"];

fn hook(facts: &mut RiskFacts, rel: &str, detail: String) {
    facts.cli_hooks.push(HookFact {
        path: rel.to_string(),
        detail,
    });
}

fn config_facts(rel: &str, name: &str, bytes: &[u8], facts: &mut RiskFacts) {
    let text = String::from_utf8_lossy(bytes);
    let json: Option<serde_json::Value> = serde_json::from_str(&text).ok();
    let toml: Option<toml::Table> = (name == "config.toml")
        .then(|| text.parse::<toml::Table>().ok())
        .flatten();
    match name {
        "settings.json" | "settings.local.json" | "hooks.json" | "opencode.json" => {
            for key in SETTINGS_COMMANDS {
                if json.as_ref().is_some_and(|j| j.get(key).is_some()) {
                    hook(facts, rel, format!("`{key}` in {name}"));
                }
            }
        }
        "config.toml" => {
            for key in CODEX_COMMANDS {
                if toml.as_ref().is_some_and(|t| t.contains_key(*key)) {
                    hook(facts, rel, format!("`{key}` in config.toml"));
                }
            }
        }
        _ => {}
    }
    if let Some(servers) = toml
        .as_ref()
        .and_then(|t| t.get("mcp_servers"))
        .and_then(|s| s.as_table())
    {
        for server in servers.keys() {
            facts.mcp_servers.push(McpFact {
                path: rel.to_string(),
                server: server.clone(),
            });
        }
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
            // An upstream command fetches what it runs (`npx tool@1.2.3`).
            Part::Setup { command, .. } => {
                facts.network_fetches.push(FetchFact {
                    part: id.clone(),
                    source: command.clone(),
                    version: Default::default(),
                });
                facts.setup_steps.push(SetupFact {
                    part: id,
                    command: command.clone(),
                });
            }
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
                    (None, None) => Default::default(),
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

/// The facts for the pack at `root`, and the agent parts' files that don't parse as an
/// `Agent`. `files` are its regular files, relative with `/`; `contents` holds the bytes the
/// validator already read (none for a file it skipped), so nothing is read here.
pub fn derive(
    root: &Path,
    manifest: &PackManifest,
    files: &[String],
    mut contents: BTreeMap<String, Vec<u8>>,
) -> (RiskFacts, Vec<String>) {
    let mut invalid_agents: Vec<String> = Default::default();
    let mut facts: RiskFacts = Default::default();
    let steps: Vec<_> = manifest
        .setup_steps
        .iter()
        .filter_map(|g| Glob::new(g).ok())
        .map(|g| g.compile_matcher())
        .collect();
    // Every agent part's file is an agent, whatever its name.
    let agents: BTreeSet<&str> = manifest
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Agent { file, .. } => Some(file.as_str()),
            _ => None,
        })
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
        let bytes = contents.remove(rel);
        let read = bytes.is_some();
        let bytes = bytes.unwrap_or_default();
        if is_executable(&meta) {
            facts.executables.push(rel.clone());
        }
        if is_script(name, &bytes) {
            facts.scripts.push(rel.clone());
        }
        for hooks in [
            "/.claude/hooks/",
            "/.codex/hooks/",
            "/.opencode/plugin/",
            "/.opencode/plugins/",
        ] {
            if slashed.contains(hooks) {
                hook(
                    &mut facts,
                    rel,
                    format!("a file under {}", hooks.trim_matches('/')),
                );
            }
        }
        if (name == "agent.yaml" || agents.contains(rel.as_str()))
            && !agent_facts(rel, &bytes, &mut facts)
            && read
            && agents.contains(rel.as_str())
        {
            invalid_agents.push(rel.clone());
        }
        config_facts(rel, name, &bytes, &mut facts);
        if slashed.contains("/routines/") && (name == "routine.yml" || name == "routine.yaml") {
            facts.routines.push(rel.clone());
        }
        if steps.iter().any(|m| m.is_match(rel)) {
            facts.setup_step_files.push(rel.clone());
        }
    }
    // A file the pack lists as executable is one: the installer applies that bit.
    for entry in manifest.files.iter().filter(|f| f.exec) {
        if files.contains(&entry.path) {
            facts.executables.push(entry.path.clone());
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
    (facts, invalid_agents)
}
