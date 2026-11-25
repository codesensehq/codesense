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
//! [`Guardrails::apply`] narrows one runtime's generated launch settings with native denies
//! and the CLI does the matching: CodeSense never matches a rule to enforce it.
//!
//! - **Claude**: each rule is appended to `permissions.deny`. Claude checks deny before allow
//!   across every settings source, so no allow the agent or a layer adds can re-open it.
//! - **OpenCode**: the last matching rule wins, so the org's rules go in a final tier, after
//!   the agent's and the native rules, behind [`OPENCODE_GUARDRAIL_TIER`]. An agent rule for a
//!   denied key also becomes `deny`: the one rewrite, and it narrows.
//! - **Hermes**: one fail-closed `pre_tool_call` block hook per matcher.
//! - **Codex** has no rule model, so nothing is injected and the launch gets a warning
//!   ([`Guardrails::not_enforced_warning`]).
//!
//! Strings are compared only to report ([`Guardrails::report`]): an agent allow or ask that is
//! the same string as an org deny, or an OpenCode non-deny decision for a denied key.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::keys::AgentKey;
use super::launch_check::{LaunchWarning, LaunchWarningCode};
use super::manifest::{json_hash, GeneratedEntry};
use super::model::Agent;
use codesense_pty_core::agent_cli::AgentCli;

/// Where a root team keeps its guardrails, relative to the team's folder.
pub const GUARDRAILS_FILE: &str = "config/guardrails.yml";

/// The action of the OpenCode rule that starts the guardrail tier. It names no tool, so as a
/// rule it denies nothing; every rule after it is an org deny and stays last when the launch's
/// rules are merged ([`split_opencode_tier`]).
pub const OPENCODE_GUARDRAIL_TIER: &str = "codesense-org-guardrails";

/// One root team's `config/guardrails.yml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuardrailsFile {
    #[serde(default)]
    pub permissions: PermissionDenies,
}

/// The permission rules a file denies, per CLI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionDenies {
    #[serde(default)]
    pub claude: DenyList,
    #[serde(default)]
    pub opencode: DenyList,
    #[serde(default)]
    pub hermes: DenyList,
}

/// One CLI's denied rules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DenyList {
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Parse a `config/guardrails.yml`. An empty file denies nothing; an unknown key, a value of
/// the wrong type or a blank rule is an error, so a typo can't lift the ceiling silently.
pub fn parse(bytes: &[u8]) -> Result<GuardrailsFile, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the file is not UTF-8".to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    let value: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| e.to_string())?;
    if value.is_null() {
        return Ok(GuardrailsFile::default());
    }
    let file: GuardrailsFile = serde_yaml::from_value(value).map_err(|e| e.to_string())?;
    for (cli, list) in [
        ("claude", &file.permissions.claude),
        ("opencode", &file.permissions.opencode),
        ("hermes", &file.permissions.hermes),
    ] {
        if list.deny.iter().any(|rule| rule.trim().is_empty()) {
            return Err(format!("permissions.{cli}.deny has a blank rule"));
        }
    }
    Ok(file)
}

/// The rules one CLI is denied, each with the files that deny it.
type Denied = BTreeMap<String, BTreeSet<String>>;

/// The org's guardrails: the union of every root team's file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Guardrails {
    claude: Denied,
    opencode: Denied,
    hermes: Denied,
}

impl Guardrails {
    /// The union of `files` (`(source, file)`, the source naming the file in reports), or
    /// `None` when together they deny nothing.
    pub fn union(files: impl IntoIterator<Item = (String, GuardrailsFile)>) -> Option<Self> {
        let mut out = Self::default();
        for (source, file) in files {
            for (denied, list) in [
                (&mut out.claude, file.permissions.claude),
                (&mut out.opencode, file.permissions.opencode),
                (&mut out.hermes, file.permissions.hermes),
            ] {
                for rule in list.deny {
                    denied.entry(rule).or_default().insert(source.clone());
                }
            }
        }
        (!out.is_empty()).then_some(out)
    }

    fn is_empty(&self) -> bool {
        self.claude.is_empty() && self.opencode.is_empty() && self.hermes.is_empty()
    }

    /// The rules `runtime` is denied, or `None` for a runtime with no rule model (Codex).
    fn rules(&self, runtime: AgentCli) -> Option<&Denied> {
        match runtime {
            AgentCli::Claude => Some(&self.claude),
            AgentCli::OpenCode => Some(&self.opencode),
            AgentCli::Hermes => Some(&self.hermes),
            AgentCli::Codex => None,
        }
    }

    /// Every file that denies something.
    fn sources(&self) -> BTreeSet<&str> {
        [&self.claude, &self.opencode, &self.hermes]
            .into_iter()
            .flat_map(|denied| denied.values().flatten())
            .map(String::as_str)
            .collect()
    }

    /// Narrow `entry`, the launch settings generated for `runtime`, with the org's denies for
    /// that runtime, and rehash it. Denies for other runtimes leave it untouched.
    pub fn apply(&self, runtime: AgentCli, entry: &mut GeneratedEntry) {
        let Some(rules) = self.rules(runtime).filter(|rules| !rules.is_empty()) else {
            return;
        };
        match runtime {
            AgentCli::Claude => {
                let Some(deny) = array_at(&mut entry.content, &["permissions", "deny"]) else {
                    return;
                };
                for rule in rules.keys() {
                    let rule = json!(rule);
                    if !deny.contains(&rule) {
                        deny.push(rule);
                    }
                }
            }
            AgentCli::OpenCode => {
                let tier = opencode_rules(rules);
                let actions: BTreeSet<&str> = tier
                    .iter()
                    .filter_map(|rule| rule["action"].as_str())
                    .collect();
                let Some(own) = array_at(&mut entry.content, &["permissions"]) else {
                    return;
                };
                for rule in own.iter_mut().filter_map(Value::as_object_mut) {
                    let denied = rule
                        .get("action")
                        .and_then(Value::as_str)
                        .is_some_and(|action| actions.contains(action));
                    if denied {
                        rule.insert("effect".into(), json!("deny"));
                    }
                }
                own.push(opencode_tier_marker());
                own.extend(tier);
            }
            AgentCli::Hermes => {
                let Some(blocks) = array_at(&mut entry.content, &["hooks", "pre_tool_call"]) else {
                    return;
                };
                for pattern in rules.keys() {
                    let block = super::adapter::hermes::block_hook(pattern);
                    if !blocks.contains(&block) {
                        blocks.push(block);
                    }
                }
            }
            AgentCli::Codex => return,
        }
        entry.hash = json_hash(&entry.content);
    }

    /// What the org's guardrails do to `agent` (whose own layer is `tried_by`): the files
    /// that deny rules for its runtime and each of its rules they refuse. `None` when they
    /// deny nothing its runtime can enforce.
    pub fn report(&self, agent: &Agent, tried_by: &AgentKey) -> Option<GuardrailReport> {
        let rules = self
            .rules(agent.runtime)
            .filter(|rules| !rules.is_empty())?;
        let denied_by: BTreeSet<&String> = rules.values().flatten().collect();
        let own = agent.permissions.as_ref();
        let tried: Vec<(RefusalKind, &str)> = match agent.runtime {
            AgentCli::Claude => own
                .and_then(|p| p.claude.as_ref())
                .map(|claude| {
                    let allows = claude
                        .allow
                        .iter()
                        .map(|rule| (RefusalKind::PermissionAllow, rule.as_str()));
                    let asks = claude
                        .ask
                        .iter()
                        .map(|rule| (RefusalKind::PermissionAsk, rule.as_str()));
                    allows.chain(asks).collect()
                })
                .unwrap_or_default(),
            AgentCli::OpenCode => own
                .and_then(|p| p.opencode.as_ref())
                .map(|opencode| {
                    opencode
                        .permission
                        .iter()
                        .filter(|(_, decision)| decision.as_str() != "deny")
                        .map(|(key, decision)| {
                            let kind = if decision == "ask" {
                                RefusalKind::PermissionAsk
                            } else {
                                RefusalKind::PermissionAllow
                            };
                            (kind, key.as_str())
                        })
                        .collect()
                })
                .unwrap_or_default(),
            AgentCli::Hermes | AgentCli::Codex => Vec::new(),
        };
        let mut seen = BTreeSet::new();
        let refused = tried
            .into_iter()
            .filter_map(|(kind, item)| {
                let sources = rules.get(item)?;
                seen.insert((kind, item)).then(|| GuardrailRefusal {
                    kind,
                    item: item.to_string(),
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
    /// denies (Codex has no rule model), naming the files that deny them.
    pub fn not_enforced_warning(&self, runtime: AgentCli) -> Option<LaunchWarning> {
        if self.rules(runtime).is_some() || self.is_empty() {
            return None;
        }
        let files: Vec<&str> = self.sources().into_iter().collect();
        Some(LaunchWarning {
            code: LaunchWarningCode::GuardrailsNotEnforced,
            message: format!(
                "{runtime} can't enforce the org's permission denies ({}): this launch runs without them.",
                files.join(", ")
            ),
        })
    }
}

/// The OpenCode rules that deny each of `rules`, in OpenCode's native ordered form.
fn opencode_rules(rules: &Denied) -> Vec<Value> {
    let map: serde_json::Map<String, Value> = rules
        .keys()
        .map(|key| (key.clone(), json!("deny")))
        .collect();
    match super::adapter::native_permission_rules(&Value::Object(map)) {
        Value::Object(mut native) => match native.remove("permissions") {
            Some(Value::Array(rules)) => rules,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn opencode_tier_marker() -> Value {
    json!({"action": OPENCODE_GUARDRAIL_TIER, "resource": "*", "effect": "deny"})
}

/// Split OpenCode's native `rules` at the guardrail tier: the rules before it, and the org's
/// denies after it (the marker dropped). A launch's rules are merged by tier, and the org's
/// denies must stay after every other rule however often they are merged.
pub(crate) fn split_opencode_tier(rules: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
    match rules
        .iter()
        .position(|rule| rule["action"] == OPENCODE_GUARDRAIL_TIER)
    {
        Some(at) => {
            let mut head = rules;
            let tier = head.split_off(at).into_iter().skip(1).collect();
            (head, tier)
        }
        None => (rules, Vec::new()),
    }
}

/// `merged` with the guardrail `tier` after it, behind its marker; each action once.
pub(crate) fn append_opencode_tier(merged: &mut Vec<Value>, tier: Vec<Value>) {
    if tier.is_empty() {
        return;
    }
    merged.push(opencode_tier_marker());
    let mut seen = BTreeSet::new();
    for rule in tier {
        if seen.insert(rule["action"].to_string()) {
            merged.push(rule);
        }
    }
}

/// The array at `path` in `content`, made an empty one when absent.
fn array_at<'a>(content: &'a mut Value, path: &[&str]) -> Option<&'a mut Vec<Value>> {
    let mut at = content;
    for key in path {
        if !at.is_object() {
            *at = json!({});
        }
        at = at.as_object_mut()?.entry(*key).or_insert(Value::Null);
    }
    if !at.is_array() {
        *at = Value::Array(Vec::new());
    }
    at.as_array_mut()
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
