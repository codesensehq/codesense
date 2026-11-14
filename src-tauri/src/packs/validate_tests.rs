// SPDX-License-Identifier: MIT
//! One fixture per rule: the good packs validate, each bad one is refused with a named
//! error and its path. The fixtures are `scripts/fixtures/packs/`, built by the pack build.

use std::path::{Path, PathBuf};

use super::validate::{path_rule, validate_dir, validate_dir_with, Limits, PackReport};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("scripts/fixtures/packs")
}

fn report(name: &str) -> PackReport {
    validate_dir(&fixtures().join(name))
}

fn refused(report: &PackReport, code: &str, path: &str) -> bool {
    report
        .errors
        .iter()
        .any(|e| e.code == code && e.path.as_deref() == Some(path))
}

fn codes(report: &PackReport) -> Vec<String> {
    report
        .errors
        .iter()
        .map(|e| format!("{} {}", e.code, e.path.as_deref().unwrap_or("-")))
        .collect()
}

/// A scratch copy of a fixture pack to break in a test.
fn scratch(name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("pack");
    copy_tree(&fixtures().join(name), &copy);
    (dir, copy)
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

#[test]
fn the_good_packs_validate_with_their_parts() {
    for name in [
        "good",
        "good-external",
        "good-setup",
        "risky",
        "two-pack/a",
        "two-pack/b",
    ] {
        let report = report(name);
        assert!(report.ok, "{name}: {:?}", codes(&report));
        assert!(
            report.errors.is_empty() && report.warnings.is_empty(),
            "{name}"
        );
    }
    let good = report("good");
    let parts: Vec<_> = good.parts.iter().map(|p| (p.id.as_str(), p.kind)).collect();
    assert_eq!(
        parts,
        [
            ("all", "preset"),
            ("helper", "agent"),
            ("handbook", "content"),
            ("page", "dashboards"),
            ("hello", "skill")
        ]
    );
    assert_eq!(good.parts[1].needs, ["handbook"]);
    let pack = good.pack.unwrap();
    assert_eq!(
        (pack.id.as_str(), pack.license.as_str()),
        ("good-pack", "MIT")
    );
}

#[test]
fn each_rule_violation_is_a_named_error_with_its_path() {
    let rows = [
        ("bad-hash", "hash_mismatch", "LICENSE"),
        (
            "bad-drift",
            "hash_mismatch",
            ".agents/skills/hello/SKILL.md",
        ),
        ("bad-unlisted", "file_unlisted", "content/handbook/extra.md"),
        (
            "bad-missing-file",
            "file_missing",
            "content/handbook/gone.md",
        ),
        ("bad-unknown-part", "unknown_part", "parts/all/includes"),
        ("bad-needs", "unknown_part", "parts/helper/needs"),
        ("bad-abs-path", "path_absolute", "/etc/passwd"),
        ("bad-dotdot", "path_traversal", "../outside/agent.yaml"),
        ("bad-git-path", "path_git", ".git/config"),
        ("bad-git-path", "file_missing", ".git/config"),
        (
            "bad-content-config",
            "path_config",
            "content/config/teams.yml",
        ),
        (
            "bad-third-party-license",
            "third_party_bundled",
            "content/handbook/vendor/LICENSE",
        ),
        (
            "bad-third-party-path",
            "third_party_bundled",
            "content/third_party/lib.md",
        ),
        (
            "bad-skill-license",
            "third_party_bundled",
            "content/handbook/skills/vendored/SKILL.md",
        ),
        ("bad-source-missing", "part_file_missing", "nope.md"),
        (
            "bad-source-missing",
            "skill_copy_missing",
            ".claude/skills/s/SKILL.md",
        ),
        ("bad-schema", "manifest_invalid", "pack.yml"),
        ("bad-target", "manifest_invalid", "pack.yml"),
    ];
    for (name, code, path) in rows {
        let report = report(name);
        assert!(!report.ok, "{name}");
        assert!(
            refused(&report, code, path),
            "{name}: wanted {code} {path}, got {:?}",
            codes(&report)
        );
        assert!(
            report.errors.iter().all(|e| !e.message.is_empty()),
            "{name}"
        );
    }
}

#[test]
fn the_path_rules_table() {
    let rows: [(&str, Option<&str>); 15] = [
        ("content/a.md", None),
        ("agents/x/agent.yaml", None),
        (".claude/skills/s/SKILL.md", None),
        ("content/dest/", None),
        ("/etc/passwd", Some("path_absolute")),
        ("C:/x", Some("path_absolute")),
        ("../x", Some("path_traversal")),
        ("content/../../x", Some("path_traversal")),
        ("./content/a", Some("path_traversal")),
        (".git/config", Some("path_git")),
        ("content/.git/x", Some("path_git")),
        ("content/config/x.yml", Some("path_config")),
        ("content//a", Some("path_invalid")),
        ("content\\a", Some("path_invalid")),
        ("", Some("path_invalid")),
    ];
    for (path, expected) in rows {
        assert_eq!(path_rule(path).map(|(code, _)| code), expected, "{path:?}");
    }
}

#[test]
fn a_file_outside_the_declared_roots_is_refused() {
    let (_guard, pack) = scratch("good");
    std::fs::create_dir_all(pack.join("scripts")).unwrap();
    std::fs::write(pack.join("scripts/run.sh"), "echo hi\n").unwrap();
    std::fs::write(pack.join("README.md"), "x\n").unwrap();
    let report = validate_dir(&pack);
    assert!(refused(&report, "path_outside_roots", "scripts/run.sh"));
    assert!(refused(&report, "path_outside_roots", "README.md"));
}

#[cfg(unix)]
#[test]
fn a_symlink_is_refused_and_not_followed() {
    let (_guard, pack) = scratch("good");
    std::os::unix::fs::symlink("/etc/hosts", pack.join("content/hosts")).unwrap();
    std::os::unix::fs::symlink("/etc", pack.join("content/etc")).unwrap();
    let report = validate_dir(&pack);
    assert!(refused(&report, "symlink", "content/hosts"));
    assert!(refused(&report, "symlink", "content/etc"));
    assert!(
        report.errors.iter().all(|e| !e
            .path
            .as_deref()
            .is_some_and(|p| p.starts_with("content/etc/"))),
        "{:?}",
        codes(&report)
    );
}

#[test]
fn the_size_caps_refuse_a_big_file_and_a_big_pack() {
    let (_guard, pack) = scratch("good");
    let tight = Limits {
        max_file: 64,
        max_pack: 1 << 30,
    };
    let report = validate_dir_with(&pack, tight);
    assert!(refused(
        &report,
        "file_too_large",
        "content/page/index.html"
    ));
    assert!(!refused(
        &report,
        "file_too_large",
        "content/handbook/README.md"
    ));
    let small_pack = Limits {
        max_file: 1 << 20,
        max_pack: 100,
    };
    let report = validate_dir_with(&pack, small_pack);
    assert!(report
        .errors
        .iter()
        .any(|e| e.code == "pack_too_large" && e.path.is_none()));
    // The real caps are 5 MB a file and 200 MB a pack.
    assert_eq!(Limits::default().max_file, 5 * 1024 * 1024);
    assert_eq!(Limits::default().max_pack, 200 * 1024 * 1024);
    assert!(validate_dir(&pack).ok);
}

fn write_manifest(pack: &Path, edit: impl Fn(String) -> String) {
    let path = pack.join("pack.yml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(path, edit(text)).unwrap();
}

#[test]
fn identity_rules_are_named() {
    let rows = [
        ("pack_format: 1", "pack_format: 2", "unsupported_format"),
        ("id: good-pack", "id: Good_Pack", "invalid_id"),
        ("version: 0.1.0", "version: one", "invalid_version"),
    ];
    for (from, to, code) in rows {
        let (_guard, pack) = scratch("good");
        write_manifest(&pack, |t| t.replacen(from, to, 1));
        let report = validate_dir(&pack);
        assert!(
            refused(&report, code, "pack.yml"),
            "{code}: {:?}",
            codes(&report)
        );
    }
}

#[test]
fn the_parts_graph_refuses_duplicates_and_cycles() {
    let (_guard, pack) = scratch("good");
    write_manifest(&pack, |t| {
        t.replacen(
            "- { id: helper, kind: agent, file: agents/helper/agent.yaml, needs: [handbook] }",
            "- { id: helper, kind: agent, file: agents/helper/agent.yaml, needs: [handbook] }\n  - { id: helper, kind: content, paths: [\"content/x/**\"] }",
            1,
        )
    });
    let report = validate_dir(&pack);
    assert!(
        refused(&report, "duplicate_part", "parts/helper"),
        "{:?}",
        codes(&report)
    );

    let (_guard, pack) = scratch("good");
    write_manifest(&pack, |t| {
        t.replacen("needs: [handbook]", "needs: [all]", 1)
    });
    let report = validate_dir(&pack);
    assert!(
        report.errors.iter().any(|e| e.code == "part_cycle"),
        "{:?}",
        codes(&report)
    );
}

#[test]
fn external_parts_are_declared_pinned_and_never_fetched() {
    let ok = report("good-external");
    assert!(ok.ok, "{:?}", codes(&ok));
    assert_eq!(ok.risk.network_fetches.len(), 2);

    let rows = [
        // A short commit is not a pin.
        (
            "commit: 0123456789abcdef0123456789abcdef01234567",
            "commit: 0123456",
            "external_unpinned",
        ),
        // An npm source needs the registry integrity.
        (
            "integrity: sha512-AAAA",
            "integrity: md5-AAAA",
            "external_unpinned",
        ),
        // method setup needs its upstream command.
        (
            "run: \"npx example-cli@6.11.0 init --yes\"",
            "run: \"\"",
            "external_setup_missing",
        ),
        // A destination may not escape the pack's team folder.
        (".agents/skills/tool/", "../outside/", "path_traversal"),
        // Exactly one source.
        (
            "source: { npm: example-cli }",
            "source: { npm: example-cli, git: \"https://example.com/x\" }",
            "external_source_invalid",
        ),
    ];
    for (from, to, code) in rows {
        let (_guard, pack) = scratch("good-external");
        write_manifest(&pack, |t| {
            assert!(t.contains(from), "{from}");
            t.replacen(from, to, 1)
        });
        let report = validate_dir(&pack);
        assert!(
            report.errors.iter().any(|e| e.code == code),
            "{code}: {:?}",
            codes(&report)
        );
    }
}

#[test]
fn a_setup_step_part_names_its_exact_command() {
    let ok = report("good-setup");
    assert!(ok.ok);
    assert_eq!(ok.risk.setup_steps.len(), 1);
    assert_eq!(ok.risk.setup_steps[0].part, "init");
    let (_guard, pack) = scratch("good-setup");
    write_manifest(&pack, |t| {
        t.replacen("npx example-cli@6.11.0 init --yes", "  ", 1)
    });
    assert!(validate_dir(&pack)
        .errors
        .iter()
        .any(|e| e.code == "setup_command_empty"));
}

#[test]
fn risk_facts_come_from_the_files() {
    let risky = report("risky");
    assert!(risky.ok, "{:?}", codes(&risky));
    let facts = &risky.risk;
    let hook = "content/.claude/hooks/pre-tool.sh";
    assert_eq!(facts.executables, [hook, "content/bin/run.sh"]);
    assert_eq!(facts.scripts, [hook, "content/bin/run.sh"]);
    assert!(facts.cli_hooks.iter().any(|h| h.path == hook));
    assert!(facts
        .cli_hooks
        .iter()
        .any(|h| h.path == "content/.claude/settings.json" && h.detail.contains("hooks")));
    assert_eq!(facts.skip_permission_agents.len(), 1);
    assert_eq!(
        facts.skip_permission_agents[0].agent,
        "agents/yolo/agent.yaml"
    );
    assert_eq!(
        facts.skip_permission_agents[0].marker,
        "--dangerously-skip-permissions"
    );
    let servers: Vec<_> = facts
        .mcp_servers
        .iter()
        .map(|m| (m.path.as_str(), m.server.as_str()))
        .collect();
    assert!(servers.contains(&("content/.mcp.json", "fixture-server")));
    assert!(servers.contains(&("agents/yolo/agent.yaml", "fixture-server")));
    assert_eq!(facts.routines, ["routines/nightly/routine.yml"]);

    // A pack with none of those reports none.
    let good = report("good").risk;
    assert!(good.executables.is_empty() && good.cli_hooks.is_empty());
    assert!(good.skip_permission_agents.is_empty() && good.mcp_servers.is_empty());
    assert_eq!(good.setup_step_files, ["setup/steps/greet.yml"]);
}

#[test]
fn a_pack_declaring_its_own_risk_is_ignored() {
    let (_guard, pack) = scratch("risky");
    write_manifest(&pack, |t| {
        format!("{t}\nrisk:\n  level: none\n  executables: []\n")
    });
    let report = validate_dir(&pack);
    assert!(report.ok, "{:?}", codes(&report));
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(report.warnings[0].code, "risk_claim_ignored");
    assert_eq!(
        report.risk,
        super::validate::validate_dir(&fixtures().join("risky")).risk
    );
    assert!(!report.risk.executables.is_empty());
}

#[test]
fn the_report_serialises_the_way_the_tool_returns_it() {
    let value = serde_json::to_value(report("bad-hash")).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["errors"][0]["code"], "hash_mismatch");
    assert_eq!(value["errors"][0]["path"], "LICENSE");
    assert!(value["risk"]["cliHooks"].is_array());
    assert!(value["risk"]["skipPermissionAgents"].is_array());
    assert_eq!(value["pack"]["id"], "good-pack");
    let missing = validate_dir(Path::new("/definitely/not/a/pack"));
    assert!(!missing.ok);
    assert_eq!(missing.errors[0].code, "manifest_missing");
}

#[test]
fn pack_validate_is_served_read_only_with_its_docs_pointer() {
    let router = crate::mcp::handler::CodesenseHandler::served_tool_router();
    let tool = router
        .get("pack_validate")
        .expect("pack_validate is served");
    let description = tool.description.as_deref().unwrap();
    assert!(description.contains("read-only"));
    assert!(description.contains("Returns"));
    assert!(
        description.ends_with("Docs: arc-e-agents/packs.html"),
        "{description}"
    );
    let schema = serde_json::Value::Object((*tool.input_schema).clone());
    assert_eq!(schema["required"], serde_json::json!(["path"]));
}
