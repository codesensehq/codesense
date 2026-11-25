// SPDX-License-Identifier: MIT
//! Unit tests for org guardrails: the parser, the union, `apply` on each runtime's
//! generated launch settings, and the report of refused re-allows.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::*;
use crate::agents::keys::AgentKey;
use crate::agents::model::{
    Agent, ClaudePermissions, HermesPermissions, LaunchMode, McpAccess, OpenCodePermissions,
    Permissions,
};
use crate::agents::permissions;
use crate::domain::Principal;
use codesense_pty_core::agent_cli::AgentCli;

const ROOT_FILE: &str = "platform/config/guardrails.yml";
const OPS_FILE: &str = "ops/config/guardrails.yml";

fn agent(runtime: AgentCli, permissions: Option<Permissions>) -> Agent {
    Agent {
        role: None,
        id: "builder".into(),
        name: "Builder".into(),
        description: String::new(),
        created_by: String::new(),
        runtime,
        args: Vec::new(),
        launch: LaunchMode::Foreground,
        mcp: McpAccess::default(),
        startup: Vec::new(),
        context: None,
        permissions,
        default_prompt: String::new(),
        avatar: None,
        allow_wake: false,
        resume_after_restart: false,
        skill_allowlist: None,
        budget_usd: None,
        revision: 0,
        archived_at: None,
        extra: BTreeMap::new(),
        env: Default::default(),
    }
}

fn claude(allow: &[&str], ask: &[&str]) -> Agent {
    agent(
        AgentCli::Claude,
        Some(Permissions {
            claude: Some(ClaudePermissions {
                allow: allow.iter().map(|s| s.to_string()).collect(),
                ask: ask.iter().map(|s| s.to_string()).collect(),
                ..ClaudePermissions::default()
            }),
            ..Permissions::default()
        }),
    )
}

fn opencode(rules: &[(&str, &str)]) -> Agent {
    agent(
        AgentCli::OpenCode,
        Some(Permissions {
            opencode: Some(OpenCodePermissions {
                permission: rules
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                ..OpenCodePermissions::default()
            }),
            ..Permissions::default()
        }),
    )
}

fn parsed(yaml: &str) -> GuardrailsFile {
    parse(yaml.as_bytes()).unwrap()
}

fn org(files: &[(&str, &str)]) -> Guardrails {
    Guardrails::union(
        files
            .iter()
            .map(|(source, yaml)| (source.to_string(), parsed(yaml))),
    )
    .expect("the files deny something")
}

fn team_key() -> AgentKey {
    AgentKey::new("acme/api", "backend", "builder")
}

fn launch_settings(agent: &Agent, guardrails: Option<&Guardrails>) -> Value {
    permissions::generate(agent, agent.runtime, agent.launch, guardrails)
        .into_iter()
        .next()
        .unwrap()
        .content
}

const CLAUDE_RM: &str = "permissions:\n  claude:\n    deny: ['Bash(rm:*)']\n";

// --- parser ---

#[test]
fn guardrails_parse_reads_each_clis_deny_list() {
    let file = parsed(
        "permissions:\n  claude:\n    deny: ['Bash(rm:*)']\n  opencode:\n    deny: [bash]\n  hermes:\n    deny: ['^terminal$']\n",
    );
    assert_eq!(file.permissions.claude.deny, vec!["Bash(rm:*)"]);
    assert_eq!(file.permissions.opencode.deny, vec!["bash"]);
    assert_eq!(file.permissions.hermes.deny, vec!["^terminal$"]);
}

#[test]
fn guardrails_parse_empty_and_absent_sections_deny_nothing() {
    for yaml in [
        "",
        "# nothing yet\n",
        "permissions: {}\n",
        "permissions:\n  claude: {}\n",
    ] {
        let file = parsed(yaml);
        assert_eq!(file, GuardrailsFile::default(), "{yaml:?}");
        assert!(
            Guardrails::union([("f".to_string(), file)]).is_none(),
            "{yaml:?}"
        );
    }
}

#[test]
fn guardrails_parse_refuses_unknown_keys_and_bad_types() {
    for yaml in [
        // MCP server and model denies are not part of this file yet: unknown, so refused.
        "mcp_servers:\n  deny: [slack]\n",
        "models:\n  deny: [opus]\n",
        "permissions:\n  codex:\n    deny: [x]\n",
        "permissions:\n  claude:\n    allow: ['Bash(ls:*)']\n",
        "permissions:\n  claude:\n    deny: 'Bash(rm:*)'\n",
        "permissions: [claude]\n",
        "permissions:\n  claude:\n    deny: ['']\n",
        "permissions:\n  claude:\n    deny: ['   ']\n",
        "permissions:\n  claude:\n    deny: [\n",
    ] {
        assert!(parse(yaml.as_bytes()).is_err(), "{yaml:?} must be refused");
    }
}

// --- union ---

#[test]
fn guardrails_union_keeps_every_files_denies_and_sources() {
    let union = org(&[
        (ROOT_FILE, CLAUDE_RM),
        (
            OPS_FILE,
            "permissions:\n  claude:\n    deny: ['Bash(rm:*)', 'WebFetch']\n",
        ),
    ]);
    let content = launch_settings(&claude(&[], &[]), Some(&union));
    let deny = content["permissions"]["deny"].as_array().unwrap();
    assert!(deny.contains(&json!("Bash(rm:*)")));
    assert!(deny.contains(&json!("WebFetch")));
    assert_eq!(
        deny.iter().filter(|r| *r == "Bash(rm:*)").count(),
        1,
        "a rule two roots deny is added once"
    );
    let report = union
        .report(&claude(&["Bash(rm:*)"], &[]), &team_key())
        .unwrap();
    assert_eq!(report.denied_by, vec![OPS_FILE, ROOT_FILE]);
    assert_eq!(report.refused[0].denied_by, vec![OPS_FILE, ROOT_FILE]);
}

#[test]
fn guardrails_monotone() {
    let files = [
        (ROOT_FILE, CLAUDE_RM),
        (
            OPS_FILE,
            "permissions:\n  claude:\n    deny: ['WebFetch']\n  opencode:\n    deny: [bash]\n",
        ),
        (
            "infra/config/guardrails.yml",
            "permissions:\n  claude:\n    deny: ['Bash(curl:*)']\n",
        ),
    ];
    let forward = org(&files);
    let mut reversed = files;
    reversed.reverse();
    assert_eq!(forward, org(&reversed), "layer order cannot matter");

    // Adding a file only ever adds denies.
    let fewer = org(&files[..1]);
    let agent = claude(&["Bash(rm:*)", "Bash(ls:*)"], &["WebFetch"]);
    let narrow = launch_settings(&agent, Some(&fewer));
    let narrower = launch_settings(&agent, Some(&forward));
    let plain = launch_settings(&agent, None);
    for content in [&narrow, &narrower] {
        // Never an allow added or removed, never an ask touched.
        assert_eq!(
            content["permissions"]["allow"],
            plain["permissions"]["allow"]
        );
        assert_eq!(content["permissions"]["ask"], plain["permissions"]["ask"]);
    }
    let deny = |c: &Value| -> Vec<Value> { c["permissions"]["deny"].as_array().unwrap().clone() };
    assert!(deny(&narrow).iter().all(|r| deny(&narrower).contains(r)));
    assert!(deny(&plain).iter().all(|r| deny(&narrow).contains(r)));
}

// --- apply: Claude ---

#[test]
fn guardrails_claude_deny_is_appended_and_allows_are_kept() {
    let union = org(&[(ROOT_FILE, CLAUDE_RM)]);
    let agent = Agent {
        permissions: Some(Permissions {
            claude: Some(ClaudePermissions {
                allow: vec!["Bash(rm:*)".into(), "Bash(rm -rf:*)".into()],
                deny: vec!["Bash(git push --force:*)".into()],
                ..ClaudePermissions::default()
            }),
            ..Permissions::default()
        }),
        ..claude(&[], &[])
    };
    let content = launch_settings(&agent, Some(&union));
    assert_eq!(
        content["permissions"]["deny"],
        json!(["Bash(git push --force:*)", "Bash(rm:*)"])
    );
    let allow = content["permissions"]["allow"].as_array().unwrap();
    assert!(
        allow.contains(&json!("Bash(rm:*)")),
        "CodeSense never removes an allow"
    );
    assert!(allow.contains(&json!("Bash(rm -rf:*)")));

    // The entry's hash covers the added deny.
    let entry = permissions::generate(
        &agent,
        AgentCli::Claude,
        LaunchMode::Foreground,
        Some(&union),
    )
    .remove(0);
    assert_eq!(
        entry.hash,
        crate::agents::manifest::json_hash(&entry.content)
    );
}

#[test]
fn guardrails_claude_deny_holds_for_every_mode_and_an_escalating_agent() {
    let union = org(&[(ROOT_FILE, CLAUDE_RM)]);
    let mut agent = claude(&["Bash(rm:*)"], &[]);
    agent
        .permissions
        .as_mut()
        .unwrap()
        .claude
        .as_mut()
        .unwrap()
        .default_mode = Some("bypassPermissions".into());
    for mode in [LaunchMode::Foreground, LaunchMode::Headless] {
        let entry = permissions::generate(&agent, AgentCli::Claude, mode, Some(&union)).remove(0);
        assert!(entry.content["permissions"]["deny"]
            .as_array()
            .unwrap()
            .contains(&json!("Bash(rm:*)")));
    }
}

// --- apply: OpenCode ---

/// The effect OpenCode applies to `action`: the last rule whose action matches it wins.
fn opencode_effect(rules: &[Value], action: &str) -> Option<String> {
    rules
        .iter()
        .filter(|rule| {
            let pattern = rule["action"].as_str().unwrap();
            pattern == "*"
                || pattern == action
                || pattern
                    .strip_suffix('*')
                    .is_some_and(|prefix| action.starts_with(prefix))
        })
        .last()
        .map(|rule| rule["effect"].as_str().unwrap().to_string())
}

#[test]
fn guardrails_opencode_overwrite() {
    let union = org(&[(
        ROOT_FILE,
        "permissions:\n  opencode:\n    deny: [bash, webfetch]\n",
    )]);
    let agent = opencode(&[("bash", "allow"), ("webfetch", "ask"), ("edit", "allow")]);
    let content = launch_settings(&agent, Some(&union));
    let rules = content["permissions"].as_array().unwrap();
    // `bash` is OpenCode's `shell` action on the wire.
    assert_eq!(opencode_effect(rules, "shell").as_deref(), Some("deny"));
    assert_eq!(opencode_effect(rules, "webfetch").as_deref(), Some("deny"));
    assert_eq!(opencode_effect(rules, "edit").as_deref(), Some("allow"));
    // The agent's own decision for a denied key becomes deny: the one rewrite, and it narrows.
    let own: Vec<_> = rules
        .iter()
        .take_while(|rule| rule["action"] != OPENCODE_GUARDRAIL_TIER)
        .filter(|rule| rule["action"] == "shell")
        .collect();
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["effect"], "deny");
}

#[test]
fn guardrails_opencode_wildcard_deny_beats_an_exact_allow() {
    let union = org(&[(
        ROOT_FILE,
        "permissions:\n  opencode:\n    deny: ['github_*']\n",
    )]);
    let agent = opencode(&[("github_create_issue", "allow")]);
    for mode in [LaunchMode::Foreground, LaunchMode::Headless] {
        let entry = permissions::generate(&agent, AgentCli::OpenCode, mode, Some(&union)).remove(0);
        let rules = entry.content["permissions"].as_array().unwrap();
        assert_eq!(
            opencode_effect(rules, "github_create_issue").as_deref(),
            Some("deny"),
            "{mode:?}: the org's wildcard is a final tier, after the agent's exact allow"
        );
    }
}

#[test]
fn guardrails_opencode_final_tier_survives_the_scope_merge() {
    let union = org(&[(
        ROOT_FILE,
        "permissions:\n  opencode:\n    deny: ['github_*', 'codesense_reply']\n",
    )]);
    let mut agent = opencode(&[("github_create_issue", "allow")]);
    agent.mcp.bridge_tools = Some(vec!["reply".into()]);
    let settings = launch_settings(&agent, Some(&union));
    // The MCP scope's own rules: the bridge wildcard denied, its listed tools allowed exactly.
    let scope = json!({"mcp": {}, "permissions": [
        {"action": "codesense_*", "resource": "*", "effect": "deny"},
        {"action": "codesense_reply", "resource": "*", "effect": "allow"},
    ]});
    let var = "OPENCODE_CONFIG_CONTENT".to_string();
    let mut env = vec![(var.clone(), scope.to_string())];
    crate::commands::mcp_scope::extend_launch_env(
        AgentCli::OpenCode,
        &mut env,
        [(var.clone(), settings.to_string())],
    );
    let merged: Value = serde_json::from_str(&env[0].1).unwrap();
    let rules = merged["permissions"].as_array().unwrap();
    assert_eq!(
        opencode_effect(rules, "github_create_issue").as_deref(),
        Some("deny")
    );
    assert_eq!(
        opencode_effect(rules, "codesense_reply").as_deref(),
        Some("deny")
    );

    // Merging the merged settings again (a relaunch replays them) keeps the tier last.
    let mut again = vec![(var.clone(), scope.to_string())];
    crate::commands::mcp_scope::extend_launch_env(
        AgentCli::OpenCode,
        &mut again,
        [(var, merged.to_string())],
    );
    let replayed: Value = serde_json::from_str(&again[0].1).unwrap();
    let rules = replayed["permissions"].as_array().unwrap();
    assert_eq!(
        opencode_effect(rules, "github_create_issue").as_deref(),
        Some("deny")
    );
    assert_eq!(
        opencode_effect(rules, "codesense_reply").as_deref(),
        Some("deny")
    );
}

// --- apply: Hermes and Codex ---

#[test]
fn guardrails_hermes_block_hook() {
    let union = org(&[(
        ROOT_FILE,
        "permissions:\n  hermes:\n    deny: ['^terminal$', '^patch$']\n",
    )]);
    let agent = agent(
        AgentCli::Hermes,
        Some(Permissions {
            hermes: Some(HermesPermissions {
                deny: vec!["^terminal$".into()],
                approval: Some("yolo".into()),
                ..HermesPermissions::default()
            }),
            ..Permissions::default()
        }),
    );
    for mode in [LaunchMode::Foreground, LaunchMode::Headless] {
        let entry = permissions::generate(&agent, AgentCli::Hermes, mode, Some(&union)).remove(0);
        let hooks = entry.content["hooks"]["pre_tool_call"].as_array().unwrap();
        for pattern in ["^terminal$", "^patch$"] {
            let block = crate::agents::adapter::hermes::block_hook(pattern);
            assert_eq!(
                hooks.iter().filter(|hook| **hook == block).count(),
                1,
                "{mode:?}: one block hook for {pattern}"
            );
        }
    }
}

#[test]
fn guardrails_codex_is_warned_not_rewritten() {
    let union = org(&[(ROOT_FILE, CLAUDE_RM)]);
    let codex = agent(AgentCli::Codex, None);
    assert_eq!(
        launch_settings(&codex, Some(&union)),
        launch_settings(&codex, None),
        "Codex has no rule model: nothing is injected"
    );
    let warning = union.not_enforced_warning(AgentCli::Codex).unwrap();
    assert_eq!(
        warning.code,
        crate::agents::launch_check::LaunchWarningCode::GuardrailsNotEnforced
    );
    assert!(warning.message.contains(ROOT_FILE));
    for runtime in [AgentCli::Claude, AgentCli::OpenCode, AgentCli::Hermes] {
        assert!(union.not_enforced_warning(runtime).is_none(), "{runtime}");
    }
}

#[test]
fn guardrails_for_another_cli_leave_the_launch_unchanged() {
    let union = org(&[(ROOT_FILE, "permissions:\n  opencode:\n    deny: [bash]\n")]);
    let agent = claude(&["Bash(rm:*)"], &[]);
    let with = permissions::generate(&agent, AgentCli::Claude, LaunchMode::Headless, Some(&union));
    let without = permissions::generate(&agent, AgentCli::Claude, LaunchMode::Headless, None);
    assert_eq!(with, without);
    assert!(union.report(&agent, &team_key()).is_none());
}

// --- report ---

#[test]
fn guardrails_report() {
    let union = org(&[(
        ROOT_FILE,
        "permissions:\n  claude:\n    deny: ['Bash(rm:*)', 'WebFetch']\n",
    )]);
    // Same-string allow and ask are refused and listed; an overlapping rule is enforced by the
    // CLI but not listed (no matcher of ours).
    let agent = claude(
        &["Bash(rm:*)", "Bash(rm -rf:*)", "Bash(ls:*)"],
        &["WebFetch"],
    );
    let report = union.report(&agent, &team_key()).unwrap();
    assert_eq!(report.denied_by, vec![ROOT_FILE]);
    assert_eq!(
        report.refused,
        vec![
            GuardrailRefusal {
                kind: RefusalKind::PermissionAllow,
                item: "Bash(rm:*)".into(),
                tried_by: team_key(),
                denied_by: vec![ROOT_FILE.into()],
            },
            GuardrailRefusal {
                kind: RefusalKind::PermissionAsk,
                item: "WebFetch".into(),
                tried_by: team_key(),
                denied_by: vec![ROOT_FILE.into()],
            },
        ]
    );
    let wire = serde_json::to_value(&report).unwrap();
    assert_eq!(wire["refused"][0]["kind"], "permission_allow");
    assert_eq!(wire["refused"][0]["tried_by"], "acme/api/backend/builder");
    assert_eq!(wire["refused"][1]["kind"], "permission_ask");

    // A personal agent is named by its personal key.
    let mine = AgentKey::personal(&Principal::from(1u64), "acme/api", "builder");
    let report = union.report(&agent, &mine).unwrap();
    assert!(report.refused.iter().all(|r| r.tried_by == mine));

    // An agent that re-allows nothing still gets the report: the org's denies applied.
    let report = union
        .report(&claude(&["Bash(ls:*)"], &[]), &team_key())
        .unwrap();
    assert_eq!(report.denied_by, vec![ROOT_FILE]);
    assert!(report.refused.is_empty());
}

#[test]
fn guardrails_report_opencode_non_deny_decisions() {
    let union = org(&[(
        ROOT_FILE,
        "permissions:\n  opencode:\n    deny: [bash, webfetch, edit]\n",
    )]);
    let agent = opencode(&[("bash", "allow"), ("webfetch", "ask"), ("edit", "deny")]);
    let report = union.report(&agent, &team_key()).unwrap();
    let refused: Vec<_> = report
        .refused
        .iter()
        .map(|r| (r.kind, r.item.as_str()))
        .collect();
    assert_eq!(
        refused,
        vec![
            (RefusalKind::PermissionAllow, "bash"),
            (RefusalKind::PermissionAsk, "webfetch"),
        ]
    );
}
