// SPDX-License-Identifier: MIT
//! Org guardrails: the permission rules an org denies to every agent launched in it, which
//! no team, private space or agent definition can allow again.
//!
//! Each root team of the org may ship a `config/guardrails.yml` that denies rules, written
//! in each CLI's own syntax:
//!
//! ```yaml
//! permissions:
//!   claude:   { deny: ["Bash(rm:*)"] }   # Claude permission rules
//!   opencode: { deny: ["bash"] }         # OpenCode permission keys, as an agent writes them
//!   hermes:   { deny: ["^terminal$"] }   # Hermes pre_tool_call matchers
//! ```
//!
//! The org's guardrails are the union of every root team's file ([`Guardrails::union`]).
//! Denies only add up, so the order of the files can't matter, and a launch from any team,
//! child team or private space in the org gets all of them. The loader
//! ([`crate::context_repo::inheritance::org_guardrails`]) reads them from the org clone's
//! committed upstream tree; this module is pure and does no I/O.
//!
//! [`Guardrails::apply`] narrows one runtime's generated launch settings with native denies,
//! through its adapter's [`GuardrailPort`], and the CLI does the matching: CodeSense never
//! matches a rule to enforce it. A CLI with no rule model has no port: nothing is injected
//! and the launch gets a warning ([`Guardrails::not_enforced_warning`]). OpenCode's port puts
//! the org's rules in a final tier, behind [`GUARDRAIL_TIER_ACTION`]'s marker, that stays last
//! however often the launch's rules are merged ([`split_final_tier`]).
//!
//! Strings are compared only to report ([`Guardrails::report`]): an agent rule that allows or
//! asks and is the same string as an org deny.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::adapter::{desktop, GuardrailPort};
use super::keys::AgentKey;
use super::launch_check::{LaunchWarning, LaunchWarningCode};
use super::manifest::{json_hash, GeneratedEntry};
use super::model::Agent;
use codesense_pty_core::agent_cli::AgentCli;

/// Where a root team keeps its guardrails, relative to the team's folder.
pub const GUARDRAILS_FILE: &str = "config/guardrails.yml";

/// The action of the native rule that starts the guardrail tier of a CLI whose last matching
/// rule wins. It names no tool, so as a rule it denies nothing; every rule after it is an org
/// deny and stays last when the launch's rules are merged ([`split_final_tier`]).
pub const GUARDRAIL_TIER_ACTION: &str = "codesense-org-guardrails";

/// One root team's `config/guardrails.yml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuardrailsFile {
    /// The permission rules the file denies, per CLI, in the CLI's own syntax.
    #[serde(default)]
    pub permissions: BTreeMap<AgentCli, DenyList>,
}

/// One CLI's denied rules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DenyList {
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Parse a `config/guardrails.yml`. An empty file denies nothing; an unknown key, a value of
/// the wrong type, a CLI that can't enforce a deny or a blank rule is an error, so a typo
/// can't lift the ceiling silently.
pub fn parse(bytes: &[u8]) -> Result<GuardrailsFile, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the file is not UTF-8".to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    let value: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| e.to_string())?;
    if value.is_null() {
        return Ok(GuardrailsFile::default());
    }
    let mut file: GuardrailsFile = serde_yaml::from_value(value).map_err(|e| e.to_string())?;
    for (cli, list) in &file.permissions {
        if desktop(*cli).guardrails.is_none() {
            return Err(format!(
                "permissions.{cli}: {cli} has no permission rules to deny"
            ));
        }
        if list.deny.iter().any(|rule| rule.trim().is_empty()) {
            return Err(format!("permissions.{cli}.deny has a blank rule"));
        }
        if list.deny.iter().any(|rule| rule == GUARDRAIL_TIER_ACTION) {
            return Err(format!(
                "permissions.{cli}.deny lists {GUARDRAIL_TIER_ACTION}, which CodeSense reserves"
            ));
        }
    }
    file.permissions.retain(|_, list| !list.deny.is_empty());
    Ok(file)
}

/// The rules one CLI is denied, each with the files that deny it.
type Denied = BTreeMap<String, BTreeSet<String>>;

/// The org's guardrails: the union of every root team's file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Guardrails {
    denied: BTreeMap<AgentCli, Denied>,
}

impl Guardrails {
    /// The union of `files` (`(source, file)`, the source naming the file in reports), or
    /// `None` when together they deny nothing.
    pub fn union(files: impl IntoIterator<Item = (String, GuardrailsFile)>) -> Option<Self> {
        let mut out = Self::default();
        for (source, file) in files {
            for (cli, list) in file.permissions {
                for rule in list.deny {
                    out.denied
                        .entry(cli)
                        .or_default()
                        .entry(rule)
                        .or_default()
                        .insert(source.clone());
                }
            }
        }
        (!out.denied.is_empty()).then_some(out)
    }

    /// The rules `runtime` is denied and the port that enforces them; `None` when it is
    /// denied nothing or can't enforce a deny.
    fn enforced(&self, runtime: AgentCli) -> Option<(&Denied, GuardrailPort)> {
        let rules = self.denied.get(&runtime).filter(|rules| !rules.is_empty())?;
        Some((rules, desktop(runtime).guardrails?))
    }

    /// Narrow `entry`, the launch settings generated for `runtime`, with the org's denies for
    /// that runtime, and rehash it. Denies for other runtimes leave it untouched.
    pub fn apply(&self, runtime: AgentCli, entry: &mut GeneratedEntry) {
        let Some((rules, port)) = self.enforced(runtime) else {
            return;
        };
        let rules: Vec<&str> = rules.keys().map(String::as_str).collect();
        (port.deny)(&mut entry.content, &rules);
        entry.hash = json_hash(&entry.content);
    }

    /// What the org's guardrails do to `agent` (whose own layer is `tried_by`): the files
    /// that deny rules for its runtime and each of its rules they refuse. `None` when they
    /// deny nothing its runtime can enforce.
    pub fn report(&self, agent: &Agent, tried_by: &AgentKey) -> Option<GuardrailReport> {
        let (rules, port) = self.enforced(agent.runtime)?;
        let denied_by: BTreeSet<&String> = rules.values().flatten().collect();
        let mut seen = BTreeSet::new();
        let refused = (port.tried)(agent)
            .into_iter()
            .filter_map(|(kind, item)| {
                let sources = rules.get(&item)?;
                seen.insert((kind, item.clone())).then(|| GuardrailRefusal {
                    kind,
                    item,
                    tried_by: tried_by.clone(),
                    denied_by: sources.iter().cloned().collect(),
                })
            })
            .collect();
        Some(GuardrailReport {
            denied_by: denied_by.into_iter().cloned().collect(),
            refused,
        })
    }

    /// The warning for a launch on `runtime` when it can't enforce the org's permission
    /// denies (its CLI has no rule model), naming the files that deny them.
    pub fn not_enforced_warning(&self, runtime: AgentCli) -> Option<LaunchWarning> {
        if desktop(runtime).guardrails.is_some() {
            return None;
        }
        let files: BTreeSet<&str> = self
            .denied
            .values()
            .flat_map(|rules| rules.values().flatten())
            .map(String::as_str)
            .collect();
        if files.is_empty() {
            return None;
        }
        Some(LaunchWarning {
            code: LaunchWarningCode::GuardrailsNotEnforced,
            message: format!(
                "{runtime} can't enforce the org's permission denies ({}): this launch runs without them.",
                files.into_iter().collect::<Vec<_>>().join(", ")
            ),
        })
    }
}

fn tier_marker() -> Value {
    json!({"action": GUARDRAIL_TIER_ACTION, "resource": "*", "effect": "deny"})
}

/// Split native ordered `rules` at the guardrail tier: the rules before it, and the org's
/// denies after it. A launch's rules are merged by tier, and the org's denies must stay after
/// every other rule however often they are merged.
///
/// The split is at the last marker, so a marker earlier in the rules (one an agent's own
/// permission map names, which validation refuses) can't pull the org's denies back among
/// the agent's rules. Every marker is dropped, and only denies go to the tier: a rule after
/// the marker that isn't a deny stays with the rules before it, so the tier only narrows.
pub(crate) fn split_final_tier(rules: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
    let is_marker = |rule: &Value| rule["action"] == GUARDRAIL_TIER_ACTION;
    let Some(at) = rules.iter().rposition(is_marker) else {
        return (rules, Vec::new());
    };
    let mut head = rules;
    let after = head.split_off(at);
    Vec::retain(&mut head, |rule| !is_marker(rule));
    let (tier, rest): (Vec<Value>, Vec<Value>) = after
        .into_iter()
        .skip(1)
        .partition(|rule| rule["effect"] == "deny");
    head.extend(rest);
    (head, tier)
}

/// `merged` with the guardrail `tier` after it, behind its marker. A rule listed twice is
/// kept once; no other rule of the tier is dropped.
pub(crate) fn append_final_tier(merged: &mut Vec<Value>, tier: Vec<Value>) {
    if tier.is_empty() {
        return;
    }
    merged.push(tier_marker());
    let mut kept: Vec<Value> = Vec::new();
    for rule in tier {
        if !<[Value]>::contains(&kept, &rule) {
            Vec::push(&mut kept, rule);
        }
    }
    merged.extend(kept);
}

/// What the org's guardrails did to one launch, on its [`super::manifest::StartupManifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GuardrailReport {
    /// The root team files (`<team>/config/guardrails.yml`) whose denies apply to this launch.
    pub denied_by: Vec<String>,
    /// The agent's own rules the guardrails refuse.
    #[serde(default)]
    pub refused: Vec<GuardrailRefusal>,
}

/// One rule a layer tried to allow and the org denies. It is enforced as denied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GuardrailRefusal {
    pub kind: RefusalKind,
    /// The rule, exactly as the agent wrote it.
    pub item: String,
    /// The layer that tried: the agent's key, a team's or a personal one.
    pub tried_by: AgentKey,
    /// The root team files that deny it.
    pub denied_by: Vec<String>,
}

/// What a refused rule tried to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalKind {
    /// An allow (Claude) or `allow` decision (OpenCode).
    PermissionAllow,
    /// An ask (Claude) or `ask` decision (OpenCode).
    PermissionAsk,
}

#[cfg(test)]
#[path = "guardrails_tests.rs"]
mod tests;
