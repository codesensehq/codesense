// SPDX-License-Identifier: MIT
#![cfg(test)]
//! The setup guide's three agents (`codesense-docs/packs/codesense-guide`), resolved through
//! the preview path a launch takes: the literal phase 1 tools, the tools CodeSense allows
//! every agent on top, and each runtime's denies as its launch passes them.
use std::collections::{BTreeMap, BTreeSet};

use super::*;

/// Phase 1: DESIGN §3.3's 24 tools plus the product step's two epic-repo verbs, `set_active_team`,
/// the Foreman hand-back's `send_role_message` (with `list_sessions` to find its team) and the
/// git-access and clone steps' three (a tab, its output, the clone verb). The same list as
/// `scripts/guide-pack.node-test.mjs`; a later phase edits both.
const PHASE_1: [&str; 31] = [
    "who_am_i",
    "list_sessions",
    "read_messages",
    "codesense_overview",
    "describe_setup",
    "query_context",
    "read_content_file",
    "list_source_repos",
    "records_list",
    "probe_environment",
    "reply",
    "send_message",
    "send_role_message",
    "signal_progress",
    "signal_done",
    "create_local_organization",
    "attach_context_repository",
    "create_team",
    "add_source_repo",
    "attach_source_repo_path",
    "run_in_terminal_tab",
    "open_terminal_tab",
    "read_terminal_tab",
    "clone_repo",
    "records_create",
    "records_set_fields",
    "create_content_file",
    "validate_story",
    "set_epic_repos",
    "read_epic_repos",
    "set_active_team",
];

/// What CodeSense allows every Claude launch before the agent's own list. Accepted for the
/// guide (Decisions); its command sends every question as a card, never through `ask_user`.
const CLAUDE_ALWAYS_ON: [&str; 9] = [
    "post_agent_message",
    "ask_user",
    "signal_done",
    "read_messages",
    "reply",
    "react",
    "routine_context",
    "routine_publish_result",
    "routine_done",
];

/// What CodeSense allows every OpenCode launch, as permission patterns' tool names.
const OPENCODE_ALWAYS_ON: [&str; 11] = [
    "who_am_i",
    "list_sessions",
    "signal_progress",
    "signal_done",
    "ask_user",
    "post_agent_message",
    "read_messages",
    "reply",
    "routine_context",
    "routine_publish_result",
    "routine_done",
];

fn guide(runtime: &str) -> Agent {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../codesense-docs/packs/codesense-guide/agents")
        .join(format!("guide-{runtime}"))
        .join("agent.yaml");
    let raw = std::fs::read_to_string(&path).unwrap();
    let agent: Agent = serde_yaml::from_str(&raw).unwrap();
    agent.validate().unwrap();
    agent
}

fn preview(agent: &Agent) -> ResolvedAgent {
    let home = tempfile::tempdir().unwrap();
    team_content(home.path(), &alice());
    preview_agent(
        home.path(),
        &alice(),
        agent,
        &team_placement(),
        ResolveOptions::default(),
    )
    .unwrap()
}

/// The one generated launch-settings entry's content.
fn launch_settings(resolved: &ResolvedAgent) -> serde_json::Value {
    let entries: Vec<_> = resolved
        .manifest
        .generated
        .iter()
        .filter(|entry| entry.target == GeneratedTarget::LaunchSettings)
        .collect();
    assert_eq!(entries.len(), 1);
    entries[0].content.clone()
}

fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == flag && pair[1] == value)
}

/// The phase 1 tools, each of which this build must register.
fn phase_1_served() -> BTreeSet<String> {
    let served: BTreeSet<String> = crate::mcp::handler::CodesenseHandler::served_tool_router()
        .list_all()
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    let missing: Vec<&str> = PHASE_1
        .into_iter()
        .filter(|name| !served.contains(*name))
        .collect();
    assert!(
        missing.is_empty(),
        "phase 1 names unregistered tools: {missing:?}"
    );
    PHASE_1.into_iter().map(str::to_string).collect()
}

fn phase_1_declared(resolved: &ResolvedAgent) -> BTreeSet<String> {
    resolved
        .launch
        .bridge_tools
        .clone()
        .expect("a declared bridge allowlist")
        .into_iter()
        .collect()
}

#[test]
fn the_claude_guide_allows_phase_1_and_the_always_on_tools_and_refuses_the_rest() {
    let _home = crate::routines::test_support::TempHome::new();
    let resolved = preview(&guide("claude"));
    let settings = launch_settings(&resolved);
    let permissions = &settings["permissions"];
    let allow: BTreeSet<String> = permissions["allow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule.as_str().unwrap().to_string())
        .collect();
    let mut expected: BTreeSet<String> = CLAUDE_ALWAYS_ON
        .into_iter()
        .chain(PHASE_1)
        .map(|name| format!("mcp__codesense__{name}"))
        .collect();
    expected.insert("Skill(codesense-setup)".to_string());
    assert_eq!(allow, expected);
    // Whatever the allow list misses is refused, not asked.
    assert_eq!(permissions["defaultMode"], "dontAsk");
    assert!(has_pair(
        &resolved.launch.args,
        "--disallowedTools",
        "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"
    ));
    // Claude enforces the bridge allowlist (#147): the agent's list plus the always-on tools
    // are what it can call, and every other served tool is denied by name.
    let wanted: BTreeSet<String> = PHASE_1.into_iter().map(str::to_string).collect();
    assert_eq!(phase_1_declared(&resolved), wanted);
    let always_on = crate::agents::permissions::always_on_bridge_tools(AgentCli::Claude);
    let mut kept = phase_1_served();
    kept.extend(always_on.iter().cloned());
    let served: BTreeSet<String> = crate::mcp::handler::CodesenseHandler::served_tool_router()
        .list_all()
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    let effective: BTreeSet<String> = resolved
        .launch
        .effective_bridge_tools
        .iter()
        .cloned()
        .collect();
    assert_eq!(
        effective,
        kept.intersection(&served).cloned().collect::<BTreeSet<_>>()
    );
    let deny: BTreeSet<String> = permissions["deny"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule.as_str().unwrap().to_string())
        .collect();
    let rule = |name: &str| format!("mcp__codesense__{name}");
    // A served tool outside phase 1 and the always-on set is denied: `open_workspace`, which the
    // page does for the guide.
    let outside = "open_workspace";
    assert!(served.contains(outside), "{outside} is served");
    assert!(!kept.contains(outside), "{outside} is outside phase 1");
    assert!(deny.contains(&rule(outside)), "{outside} is denied");
    // No phase 1 or always-on tool is.
    for name in &kept {
        assert!(!deny.contains(&rule(name)), "{name} is not denied");
    }
}

#[test]
fn the_codex_guide_runs_read_only_without_web_search_on_exactly_phase_1() {
    let _home = crate::routines::test_support::TempHome::new();
    let resolved = preview(&guide("codex"));
    let wanted: BTreeSet<String> = PHASE_1.into_iter().map(str::to_string).collect();
    assert_eq!(phase_1_declared(&resolved), wanted);
    let effective: BTreeSet<String> = resolved
        .launch
        .effective_bridge_tools
        .iter()
        .cloned()
        .collect();
    assert_eq!(effective, phase_1_served());
    let settings = launch_settings(&resolved);
    let overrides = codesense_pty_core::agent_cli::descriptor(AgentCli::Codex)
        .launch_settings
        .overrides(&settings);
    assert_eq!(
        overrides,
        Some(vec![
            "-c".to_string(),
            "approval_policy=\"never\"".to_string(),
            "-c".to_string(),
            "sandbox_mode=\"read-only\"".to_string(),
        ])
    );
    assert!(has_pair(
        &resolved.launch.args,
        "-c",
        "web_search=\"disabled\""
    ));
}

#[test]
fn the_opencode_guide_denies_shell_edit_web_and_subagents_on_exactly_phase_1() {
    let _home = crate::routines::test_support::TempHome::new();
    let resolved = preview(&guide("opencode"));
    let wanted: BTreeSet<String> = PHASE_1.into_iter().map(str::to_string).collect();
    assert_eq!(phase_1_declared(&resolved), wanted);
    let effective: BTreeSet<String> = resolved
        .launch
        .effective_bridge_tools
        .iter()
        .cloned()
        .collect();
    assert_eq!(effective, phase_1_served());
    let settings = launch_settings(&resolved);
    let rules: BTreeMap<String, String> = settings["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| {
            assert_eq!(rule["resource"], "*");
            (
                rule["action"].as_str().unwrap().to_string(),
                rule["effect"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let mut expected: BTreeMap<String, String> = [
        ("shell", "deny"),
        ("edit", "deny"),
        ("webfetch", "deny"),
        ("websearch", "deny"),
        ("codesearch", "deny"),
        ("task", "deny"),
        ("external_directory", "deny"),
        ("*", "ask"),
        ("codesense_*", "deny"),
    ]
    .into_iter()
    .map(|(action, effect)| (action.to_string(), effect.to_string()))
    .collect();
    for name in OPENCODE_ALWAYS_ON {
        expected.insert(format!("codesense_{name}"), "allow".to_string());
    }
    assert_eq!(rules, expected);
}
