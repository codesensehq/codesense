// SPDX-License-Identifier: MIT
//! Seam tests for org guardrails: real team content in a real git clone of the org, agents
//! saved through the real store and resolved for real. Guardrails are read from the clone's
//! upstream commit, so these fixtures commit and "push" (move the remote-tracking ref).

use std::path::{Path, PathBuf};

use serde_json::json;

use super::tests::{alice, draft, save, team_content, write, ORG, TEAM};
use super::*;
use crate::agents::guardrails::{RefusalKind, GUARDRAILS_FILE};
use crate::agents::launch_check::LaunchWarningCode;
use crate::agents::manifest::{GeneratedTarget, ManifestErrorCode};
use crate::agents::manifest_resolve::ContextRoot;
use crate::agents::model::{ClaudePermissions, Permissions};
use crate::context_repo::path_to_org_root;
use crate::routines::PersonalOwner;
use codesense_pty_core::agent_cli::AgentCli;

const PARENT: &str = "platform";
const OPS: &str = "ops";
const RM: &str = "Bash(rm:*)";
const CLAUDE_RM: &str = "permissions:\n  claude:\n    deny: ['Bash(rm:*)']\n";

fn org_root(home: &Path) -> PathBuf {
    path_to_org_root(home, &alice(), ORG).unwrap()
}

fn guardrails_path(team: &str) -> String {
    format!("{team}/{GUARDRAILS_FILE}")
}

/// Turn `root` (a fixture org with an empty `.git`) into a real clone on `main` with an
/// `origin` remote, commit everything and push.
pub(crate) fn init_clone(root: &Path) {
    let dot_git = root.join(".git");
    if dot_git.is_dir() && std::fs::read_dir(&dot_git).unwrap().next().is_none() {
        std::fs::remove_dir(&dot_git).unwrap();
    }
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(root, &options).unwrap();
    repo.remote("origin", "https://example.invalid/acme/api.git")
        .unwrap();
    commit_all(root, "initial");
    push(root);
    repo.find_branch("main", git2::BranchType::Local)
        .unwrap()
        .set_upstream(Some("origin/main"))
        .unwrap();
}

/// Commit the whole working tree of `root` on its current branch, without pushing.
pub(crate) fn commit_all(root: &Path, message: &str) -> git2::Oid {
    let repo = git2::Repository::open(root).unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.update_all(["*"], None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .unwrap()
}

/// Move `origin/main` to `root`'s HEAD, as a push (or a pull of a reviewed change) would.
pub(crate) fn push(root: &Path) {
    let repo = git2::Repository::open(root).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    repo.reference("refs/remotes/origin/main", head, true, "push")
        .unwrap();
}

/// The fixture org with `files` (`(team, guardrails.yml body)`) committed and pushed.
pub(crate) fn guarded_org(home: &Path, files: &[(&str, &str)]) -> PathBuf {
    team_content(home, &alice());
    let root = org_root(home);
    for (team, body) in files {
        write(&root, &guardrails_path(team), body.as_bytes());
    }
    init_clone(&root);
    root
}

fn set_teams(root: &Path, teams: &str) {
    std::fs::write(root.join("teams.yml"), teams).unwrap();
}

/// A Claude agent that re-allows what the org denies.
fn escalating(id: &str) -> Agent {
    Agent {
        permissions: Some(Permissions {
            claude: Some(ClaudePermissions {
                allow: vec![RM.into(), "Bash(rm -rf:*)".into()],
                ..ClaudePermissions::default()
            }),
            ..Permissions::default()
        }),
        ..draft(id, AgentCli::Claude)
    }
}

fn launch_settings(resolved: &ResolvedAgent) -> &serde_json::Value {
    &resolved
        .manifest
        .generated
        .iter()
        .find(|entry| entry.target == GeneratedTarget::LaunchSettings)
        .unwrap()
        .content
}

fn denies(resolved: &ResolvedAgent) -> Vec<String> {
    launch_settings(resolved)["permissions"]["deny"]
        .as_array()
        .unwrap()
        .iter()
        .map(|rule| rule.as_str().unwrap().to_string())
        .collect()
}

fn resolve_team(home: &Path, key: &AgentKey) -> ResolvedAgent {
    resolve_agent(
        home,
        &alice(),
        key,
        ResolveOptions {
            target_team: Some((ORG.into(), TEAM.into())),
        },
    )
    .unwrap()
}

fn personal_owner() -> Placement {
    Placement::Personal(PersonalOwner {
        github_user_id: 1,
        username: "alice".into(),
        display_name: "Alice".into(),
        avatar_url: None,
        org: ORG.into(),
    })
}

#[test]
fn guardrails_absent_identical() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    team_content(home, &alice());
    let key = save(home, &alice(), escalating("same"));
    // Before: the fixture org is not a git clone at all.
    let before = resolve_team(home, &key);

    // A real clone with no guardrails file anywhere.
    init_clone(&org_root(home));
    let plain = resolve_team(home, &key);
    // A root file that denies only for another CLI changes nothing for a Claude agent.
    write(
        &org_root(home),
        &guardrails_path(PARENT),
        b"permissions:\n  opencode:\n    deny: [bash]\n",
    );
    commit_all(&org_root(home), "opencode only");
    push(&org_root(home));
    let other_cli = resolve_team(home, &key);

    for after in [&plain, &other_cli] {
        assert_eq!(after.manifest, before.manifest);
        assert_eq!(after.manifest.manifest_hash, before.manifest.manifest_hash);
        assert_eq!(after.manifest.guardrails, None);
        assert_eq!(after.warnings, before.warnings);
        assert_eq!(after.launch_admission, before.launch_admission);
        let wire = serde_json::to_value(&after.manifest).unwrap();
        assert!(wire.get("guardrails").is_none(), "absent, not null");
    }
}

#[test]
fn guardrails_claude_deny() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    guarded_org(home, &[(PARENT, CLAUDE_RM)]);
    let key = save(home, &alice(), escalating("rm-er"));
    let resolved = resolve_team(home, &key);

    assert!(denies(&resolved).contains(&RM.to_string()));
    let allow = &launch_settings(&resolved)["permissions"]["allow"];
    assert!(allow.as_array().unwrap().contains(&json!(RM)));
    assert!(allow.as_array().unwrap().contains(&json!("Bash(rm -rf:*)")));
    assert!(resolved.launch_admission.allowed);
    assert!(resolved.manifest.errors.is_empty());
}

#[test]
fn guardrails_report_names_the_layer_that_tried() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    guarded_org(home, &[(PARENT, CLAUDE_RM)]);
    let key = save(home, &alice(), escalating("rm-er"));
    let resolved = resolve_team(home, &key);

    let report = resolved.manifest.guardrails.clone().unwrap();
    assert_eq!(report.denied_by, vec![guardrails_path(PARENT)]);
    assert_eq!(report.refused.len(), 1, "an overlapping rule is not listed");
    let refusal = &report.refused[0];
    assert_eq!(refusal.kind, RefusalKind::PermissionAllow);
    assert_eq!(refusal.item, RM);
    assert_eq!(refusal.tried_by, key);
    assert_eq!(refusal.denied_by, vec![guardrails_path(PARENT)]);
    // The report is covered by the manifest hash.
    assert_eq!(
        resolved.manifest.manifest_hash,
        resolved.manifest.compute_hash()
    );

    // A personal agent's refusal names its personal key.
    let preview = preview_agent(
        home,
        &alice(),
        &escalating("mine"),
        &personal_owner(),
        ResolveOptions::default(),
    )
    .unwrap();
    let report = preview.manifest.guardrails.unwrap();
    assert_eq!(report.refused[0].tried_by, preview.agent.key);
    assert!(preview.agent.key.to_string().starts_with("_personal/"));
}

#[test]
fn agent_preview_guardrails() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    guarded_org(home, &[(PARENT, CLAUDE_RM)]);
    // What `agent_preview` returns for a draft placed in the team.
    let preview = preview_agent(
        home,
        &alice(),
        &escalating("draft"),
        &Placement::Team {
            org: ORG.into(),
            team: TEAM.into(),
        },
        ResolveOptions::default(),
    )
    .unwrap();
    let item = serde_json::to_value(crate::mcp::agent_tools::ResolvedItem::from(preview)).unwrap();
    let report = &item["manifest"]["guardrails"];
    assert_eq!(report["denied_by"], json!([guardrails_path(PARENT)]));
    assert_eq!(report["refused"][0]["item"], RM);
    assert_eq!(report["refused"][0]["kind"], "permission_allow");
    assert_eq!(report["refused"][0]["tried_by"], "acme/api/backend/draft");
}

#[test]
fn guardrails_union_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    team_content(home, &alice());
    let root = org_root(home);
    set_teams(
        &root,
        &format!("teams:\n  - name: {TEAM}\n    parent_team: {PARENT}\n  - name: {PARENT}\n  - name: {OPS}\n"),
    );
    write(&root, &guardrails_path(PARENT), CLAUDE_RM.as_bytes());
    write(
        &root,
        &guardrails_path(OPS),
        b"permissions:\n  claude:\n    deny: ['WebFetch']\n",
    );
    // A root that shares nothing with its children still binds them.
    write(
        &root,
        &format!("{PARENT}/config/sharing.yml"),
        b"share: []\n",
    );
    init_clone(&root);
    let key = save(home, &alice(), escalating("union"));

    let both = |resolved: &ResolvedAgent| {
        let deny = denies(resolved);
        assert!(deny.contains(&RM.to_string()), "{deny:?}");
        assert!(deny.contains(&"WebFetch".to_string()), "{deny:?}");
    };
    // A child of one root gets every root's denies.
    let resolved = resolve_team(home, &key);
    both(&resolved);
    assert_eq!(
        resolved.manifest.guardrails.as_ref().unwrap().denied_by,
        vec![guardrails_path(OPS), guardrails_path(PARENT)]
    );

    // A private-space launch in the org gets the union too.
    let preview = preview_agent(
        home,
        &alice(),
        &escalating("mine"),
        &personal_owner(),
        ResolveOptions::default(),
    )
    .unwrap();
    both(&preview);

    // Re-parenting the team to a root doesn't take it out from under its old root.
    set_teams(
        &root,
        &format!("teams:\n  - name: {TEAM}\n  - name: {PARENT}\n  - name: {OPS}\n"),
    );
    commit_all(&root, "re-parent");
    push(&root);
    both(&resolve_team(home, &key));
}

#[test]
fn guardrails_non_root_file_is_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    guarded_org(
        home,
        &[
            (PARENT, CLAUDE_RM),
            (TEAM, "permissions:\n  claude:\n    deny: ['WebFetch']\n"),
        ],
    );
    let key = save(home, &alice(), escalating("child"));
    let resolved = resolve_team(home, &key);
    let deny = denies(&resolved);
    assert!(deny.contains(&RM.to_string()));
    assert!(!deny.contains(&"WebFetch".to_string()));
    assert_eq!(
        resolved.manifest.guardrails.unwrap().denied_by,
        vec![guardrails_path(PARENT)]
    );
}

#[test]
fn guardrails_are_read_from_the_upstream_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    let root = guarded_org(home, &[(PARENT, CLAUDE_RM)]);
    let key = save(home, &alice(), escalating("upstream"));

    // A dirty working-tree edit is ignored: deleting the file or emptying it lifts nothing.
    std::fs::write(root.join(guardrails_path(PARENT)), "permissions: {}\n").unwrap();
    assert!(denies(&resolve_team(home, &key)).contains(&RM.to_string()));
    std::fs::remove_file(root.join(guardrails_path(PARENT))).unwrap();
    assert!(denies(&resolve_team(home, &key)).contains(&RM.to_string()));

    // So is a local commit that has not been pushed.
    commit_all(&root, "drop the guardrails locally");
    assert!(denies(&resolve_team(home, &key)).contains(&RM.to_string()));

    // A new upstream commit takes effect on the next resolve.
    write(
        &root,
        &guardrails_path(PARENT),
        b"permissions:\n  claude:\n    deny: ['WebFetch']\n",
    );
    commit_all(&root, "deny WebFetch instead");
    push(&root);
    let deny = denies(&resolve_team(home, &key));
    assert!(deny.contains(&"WebFetch".to_string()));
    assert!(!deny.contains(&RM.to_string()));
}

#[test]
fn guardrails_ignore_a_chosen_context_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    guarded_org(home, &[(PARENT, CLAUDE_RM)]);
    // A sparse seat worktree that has no guardrails file at all, or an edited one.
    let sparse = tmp.path().join("seat-worktree");
    std::fs::create_dir_all(sparse.join(PARENT).join("config")).unwrap();
    std::fs::write(
        sparse.join("teams.yml"),
        format!("teams:\n  - name: {TEAM}\n"),
    )
    .unwrap();
    let mut target = ManifestTarget::team(ORG, TEAM);
    target.context_root = Some(ContextRoot {
        id: "seat".into(),
        root: sparse.clone(),
    });
    let guardrails = roots::org_guardrails(home, &alice(), &target)
        .unwrap()
        .expect("the clone's committed guardrails, not the chosen worktree's");
    let entry = permissions::generate(
        &escalating("seat"),
        AgentCli::Claude,
        model::LaunchMode::Foreground,
        Some(guardrails.as_ref()),
    )
    .remove(0);
    assert!(entry.content["permissions"]["deny"]
        .as_array()
        .unwrap()
        .contains(&json!(RM)));
}

#[test]
fn guardrails_fail_closed() {
    let with_ops = format!(
        "teams:\n  - name: {TEAM}\n    parent_team: {PARENT}\n  - name: {PARENT}\n  - name: {OPS}\n"
    );
    let cases: [(&str, &[(&str, &str)], Option<&str>); 4] = [
        (
            "invalid yaml",
            &[(PARENT, "permissions:\n  claude:\n    deny: [\n")],
            None,
        ),
        (
            "an unknown key",
            &[(PARENT, "mcp_servers:\n  deny: [slack]\n")],
            None,
        ),
        (
            "a bad type",
            &[(PARENT, "permissions:\n  claude:\n    deny: 'Bash(rm:*)'\n")],
            None,
        ),
        (
            "a missing root folder",
            &[(PARENT, CLAUDE_RM)],
            Some(with_ops.as_str()),
        ),
    ];
    for (why, files, teams) in cases {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        team_content(home, &alice());
        let root = org_root(home);
        if let Some(teams) = teams {
            set_teams(&root, teams);
        }
        for (team, body) in files {
            write(&root, &guardrails_path(team), body.as_bytes());
        }
        init_clone(&root);
        let key = save(home, &alice(), escalating("refused"));
        let resolved = resolve_team(home, &key);

        let errors: Vec<_> = resolved
            .manifest
            .errors
            .iter()
            .filter(|e| e.code == ManifestErrorCode::Guardrails)
            .collect();
        assert_eq!(errors.len(), 1, "{why}: {:?}", resolved.manifest.errors);
        let expected_path = if teams.is_some() {
            OPS.to_string()
        } else {
            guardrails_path(PARENT)
        };
        assert!(
            errors[0].message.contains(&expected_path),
            "{why}: {}",
            errors[0].message
        );
        // The preview says the launch is refused, with the same reason a launch gives.
        assert!(!resolved.launch_admission.allowed, "{why}");
        let reason = resolved.launch_admission.reason.clone().unwrap();
        assert!(reason.contains(&expected_path), "{why}: {reason}");
        let launch = crate::agents::launch::prepare(
            home,
            &alice(),
            &key,
            crate::agents::launch::PrepareOptions {
                account: None,
                target_team: Some((ORG.into(), TEAM.into())),
                mode_override: None,
                prompt: None,
            },
        );
        assert_eq!(launch.err(), Some(reason), "{why}");
    }
}

/// The reason a launch of `key` into the team is refused, checked to be the loader's.
fn refusal(home: &Path, key: &AgentKey) -> String {
    let resolved = resolve_team(home, key);
    let errors = resolved
        .manifest
        .errors
        .iter()
        .filter(|e| e.code == ManifestErrorCode::Guardrails)
        .count();
    assert_eq!(errors, 1, "{:?}", resolved.manifest.errors);
    assert!(!resolved.launch_admission.allowed);
    resolved.launch_admission.reason.clone().unwrap()
}

/// Commit and push `root` with `teams` as its `teams.yml` (`None`: without one), then put the
/// working tree's file back as it was.
fn push_teams_yml(root: &Path, teams: Option<&str>) {
    let path = root.join("teams.yml");
    let before = std::fs::read(&path).unwrap();
    match teams {
        Some(teams) => std::fs::write(&path, teams).unwrap(),
        None => std::fs::remove_file(&path).unwrap(),
    }
    commit_all(root, "teams.yml");
    push(root);
    std::fs::write(&path, before).unwrap();
}

#[test]
fn guardrails_fail_closed_when_the_org_clone_cant_be_read() {
    let file = guardrails_path(PARENT);
    // An org folder that is no repository, but whose team folder has a guardrails file.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    team_content(home, &alice());
    write(&org_root(home), &file, CLAUDE_RM.as_bytes());
    let key = save(home, &alice(), escalating("no-repo"));
    let reason = refusal(home, &key);
    assert!(reason.contains(&file), "{reason}");
    assert!(reason.contains("not a git repository"), "{reason}");

    // A `.git` that can't be opened, with no guardrails file anywhere in the working tree:
    // a link to a missing git folder, and a git folder that lost its HEAD.
    for broken in ["gitlink", "no HEAD"] {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        team_content(home, &alice());
        let key = save(home, &alice(), escalating("broken"));
        let root = org_root(home);
        if broken == "gitlink" {
            std::fs::remove_dir(root.join(".git")).unwrap();
            std::fs::write(root.join(".git"), "gitdir: /nowhere/at/all\n").unwrap();
        } else {
            init_clone(&root);
            std::fs::remove_file(root.join(".git/HEAD")).unwrap();
        }
        let reason = refusal(home, &key);
        assert!(reason.contains("org guardrails"), "{broken}: {reason}");
    }

    // A branch with no commit yet, whose working tree has a guardrails file.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    team_content(home, &alice());
    let key = save(home, &alice(), escalating("unborn"));
    let root = org_root(home);
    std::fs::remove_dir(root.join(".git")).unwrap();
    git2::Repository::init(&root).unwrap();
    // A new org, with nothing committed and no file, has no guardrails yet.
    let resolved = resolve_team(home, &key);
    assert!(resolved.launch_admission.allowed);
    assert_eq!(resolved.guardrails, None);
    write(&root, &file, CLAUDE_RM.as_bytes());
    let reason = refusal(home, &key);
    assert!(reason.contains(&file), "{reason}");
    assert!(reason.contains("no commit yet"), "{reason}");
}

#[test]
fn guardrails_fail_closed_on_a_commit_without_root_teams() {
    let no_roots = format!(
        "teams:\n  - name: {TEAM}\n    parent_team: {PARENT}\n  - name: {PARENT}\n    parent_team: {TEAM}\n"
    );
    for (why, teams) in [
        ("no teams.yml in the commit", None),
        ("every team has a parent", Some(no_roots.as_str())),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let root = guarded_org(home, &[(PARENT, CLAUDE_RM)]);
        let key = save(home, &alice(), escalating("rootless"));
        push_teams_yml(&root, teams);
        let reason = refusal(home, &key);
        assert!(reason.contains("teams.yml"), "{why}: {reason}");
    }
}

#[test]
fn guardrails_codex_warns() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    guarded_org(home, &[(PARENT, CLAUDE_RM)]);
    let codex = draft("codex-seat", AgentCli::Codex);
    let key = save(home, &alice(), codex.clone());
    let resolved = resolve_team(home, &key);
    let warnings: Vec<_> = resolved
        .warnings
        .iter()
        .filter(|w| w.code == LaunchWarningCode::GuardrailsNotEnforced)
        .collect();
    assert_eq!(warnings.len(), 1);
    assert!(resolved.launch_admission.allowed);
    assert_eq!(resolved.manifest.guardrails, None);
    assert_eq!(
        resolved
            .manifest
            .generated
            .iter()
            .find(|e| e.target == GeneratedTarget::LaunchSettings)
            .unwrap()
            .content,
        permissions::generate(&codex, AgentCli::Codex, codex.launch, None)[0].content,
        "nothing is injected into a Codex launch"
    );
}

#[test]
fn guardrails_survive_a_merge_marked_settings_file() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    team_content(home, &alice());
    let root = org_root(home);
    // The team ships a merge-marked `.claude/settings.json` that allows what the org denies.
    write(
        &super::tests::content(home, &alice(), TEAM),
        ".claude/settings.json",
        br#"{"permissions": {"allow": ["Bash(rm:*)"]}}"#,
    );
    write(
        &root,
        &format!("{TEAM}/config/merge-marked.yaml"),
        b"marks:\n  .claude/settings.json: {}\n",
    );
    write(&root, &guardrails_path(PARENT), CLAUDE_RM.as_bytes());
    init_clone(&root);
    let mut agent = escalating("merged");
    agent.startup.push(".claude/settings.json".into());
    let key = save(home, &alice(), agent);
    let resolved = resolve_team(home, &key);

    let workspace = resolved
        .manifest
        .generated
        .iter()
        .find(|e| e.target == GeneratedTarget::WorkspaceFile)
        .expect("the merged settings file");
    assert_eq!(workspace.content["permissions"]["allow"], json!([RM]));
    // The per-launch `--settings` deny still carries the org's rule; Claude checks deny before
    // allow across every settings source.
    assert!(denies(&resolved).contains(&RM.to_string()));
}
