// SPDX-License-Identifier: MIT
//! One fixture per rule: the good packs validate, each bad one is refused with a named
//! error and its path. The fixtures are `scripts/fixtures/packs/`, built by the pack build.

use std::path::{Path, PathBuf};

use super::validate::{
    path_rule, validate_dir, validate_dir_with, Limits, PackReport, MAX_MANIFEST_BYTES,
};

const INTEGRITY: &str = "integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

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
        "risky-more",
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
    let rows: [(&str, Option<&str>); 22] = [
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
        // Case-insensitive file systems fold these into `.git` and `config`.
        (".GIT/config", Some("path_git")),
        ("content/.Git/x", Some("path_git")),
        ("content/git~1/x", Some("path_git")),
        ("Content/Config/x.yml", Some("path_config")),
        ("content/a./b", Some("path_invalid")),
        ("content/a /b", Some("path_invalid")),
        ("content/.git./x", Some("path_invalid")),
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
        ..Default::default()
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
        ..Default::default()
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
        (INTEGRITY, "integrity: md5-AAAA", "external_unpinned"),
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

fn has(report: &PackReport, code: &str) -> bool {
    report.errors.iter().any(|e| e.code == code)
}

/// `edit` applied to a scratch copy of `name`, then validated.
fn edited(name: &str, from: &str, to: &str) -> PackReport {
    let (_guard, pack) = scratch(name);
    write_manifest(&pack, |t| {
        assert!(t.contains(from), "{name}: {from}");
        t.replacen(from, to, 1)
    });
    validate_dir(&pack)
}

#[cfg(unix)]
#[test]
fn a_symlinked_pack_yml_is_refused_and_never_read() {
    let (guard, pack) = scratch("good");
    let outside = guard.path().join("outside.txt");
    std::fs::write(&outside, "outside-sentinel-text\n").unwrap();
    std::fs::remove_file(pack.join("pack.yml")).unwrap();
    std::os::unix::fs::symlink(&outside, pack.join("pack.yml")).unwrap();
    let report = validate_dir(&pack);
    assert!(
        refused(&report, "symlink", "pack.yml"),
        "{:?}",
        codes(&report)
    );
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains("outside-sentinel-text"), "{text}");
}

#[cfg(unix)]
#[test]
fn a_pack_yml_that_is_not_a_small_regular_file_is_refused() {
    let (_guard, pack) = scratch("good");
    std::fs::write(
        pack.join("pack.yml"),
        "#".repeat(MAX_MANIFEST_BYTES as usize + 1),
    )
    .unwrap();
    assert!(refused(
        &validate_dir(&pack),
        "manifest_too_large",
        "pack.yml"
    ));

    let (_guard, pack) = scratch("good");
    std::fs::remove_file(pack.join("pack.yml")).unwrap();
    let made = std::process::Command::new("mkfifo")
        .arg(pack.join("pack.yml"))
        .status()
        .unwrap();
    assert!(made.success());
    // Returns at once: a FIFO is never opened for a blocking read.
    assert!(refused(
        &validate_dir(&pack),
        "manifest_invalid",
        "pack.yml"
    ));
}

#[test]
fn a_manifest_error_quotes_at_most_a_short_clip_of_the_file() {
    let (_guard, pack) = scratch("good");
    let body = format!("just-text-{}\n", "x".repeat(2_000));
    std::fs::write(pack.join("pack.yml"), body).unwrap();
    let report = validate_dir(&pack);
    assert!(refused(&report, "manifest_invalid", "pack.yml"));
    assert!(
        report.errors.iter().all(|e| e.message.len() <= 240),
        "{:?}",
        report.errors
    );
}

#[test]
fn a_listed_path_outside_the_pack_is_never_opened() {
    let (guard, pack) = scratch("good");
    let outside = guard.path().join("elsewhere/SKILL.md");
    std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
    std::fs::write(&outside, "---\nlicense: GPL-3.0\n---\n").unwrap();
    let listed = outside.display().to_string();
    write_manifest(&pack, |t| {
        format!(
            "{t}  - path: {listed}\n    sha256: {}\n    exec: false\n",
            "0".repeat(64)
        )
    });
    let report = validate_dir(&pack);
    assert!(
        refused(&report, "path_absolute", &listed),
        "{:?}",
        codes(&report)
    );
    assert!(
        !refused(&report, "third_party_bundled", &listed),
        "the outside file's license was read: {:?}",
        codes(&report)
    );
}

#[test]
fn unknown_keys_are_refused_and_a_risk_claim_only_warned() {
    let report = edited("good", "setup_steps:", "neds: [x]\nsetup_steps:");
    assert!(
        report
            .errors
            .iter()
            .any(|e| e.code == "unknown_key" && e.message.contains("neds")),
        "{:?}",
        codes(&report)
    );
    let report = edited(
        "good",
        "file: agents/helper/agent.yaml, needs: [handbook]",
        "file: agents/helper/agent.yaml, neds: [handbook]",
    );
    assert!(
        report
            .errors
            .iter()
            .any(|e| e.code == "unknown_key" && e.message.contains("parts/1/neds")),
        "{:?}",
        codes(&report)
    );
    let report = edited(
        "good",
        "  kit: { chat: 1 }",
        "  kit: { chat: 1 }\n  clis_extra: []",
    );
    assert!(has(&report, "unknown_key"), "{:?}", codes(&report));
}

#[test]
fn requires_codesense_is_held_to_this_app() {
    let rows = [
        (">=99.0.0", Some("requires_newer_codesense")),
        (">=0.0.1 <99", Some("requires_invalid")),
        ("soon", Some("requires_invalid")),
        (">=0.0.1", None),
        (">=0.0.1 <99.0.0", None),
    ];
    for (range, code) in rows {
        let report = edited(
            "good",
            "requires:\n",
            &format!("requires:\n  codesense: \"{range}\"\n"),
        );
        match code {
            Some(code) => assert!(
                refused(&report, code, "pack.yml"),
                "{range}: {:?}",
                codes(&report)
            ),
            None => assert!(report.ok, "{range}: {:?}", codes(&report)),
        }
    }
}

#[test]
fn external_sources_and_pins_are_strict() {
    let rows = [
        // A git source is an https forge URL, nothing a git client would run or read locally.
        ("\"https://github.com/example/tool\"", "\"ext::sh -c touch%20x\"", "external_source_invalid"),
        ("\"https://github.com/example/tool\"", "\"file:///tmp/x\"", "external_source_invalid"),
        ("\"https://github.com/example/tool\"", "\"--upload-pack=x\"", "external_source_invalid"),
        ("\"https://github.com/example/tool\"", "\"http://github.com/example/tool\"", "external_source_invalid"),
        // An npm source is a registry package name.
        ("{ npm: example-cli }", "{ npm: \"file:../x\" }", "external_source_invalid"),
        ("{ npm: example-cli }", "{ npm: \"https://host/x.tgz\" }", "external_source_invalid"),
        // The integrity decodes to the digest's length.
        (INTEGRITY, "integrity: sha512-", "external_unpinned"),
        (INTEGRITY, "integrity: sha512-AAAA", "external_unpinned"),
        // An exact version, not a range or a tag.
        ("version: 1.2.3", "version: latest", "external_unpinned"),
        ("version: 6.11.0", "version: \"^6.11.0\"", "external_unpinned"),
        // method files pins the mapped tree.
        (
            "    tree_sha256: \"0000000000000000000000000000000000000000000000000000000000000000\"\n",
            "",
            "external_unpinned",
        ),
        // Setup paths follow the path rules; `.` is the team folder itself.
        ("cwd: \".\"", "cwd: /etc", "path_absolute"),
        ("read: .example/manifest.yaml", "read: ../x", "path_traversal"),
    ];
    for (from, to, code) in rows {
        let report = edited("good-external", from, to);
        assert!(
            has(&report, code),
            "{to}: wanted {code}, got {:?}",
            codes(&report)
        );
    }
    let report = edited("risky-more", "cwd: content/tools", "cwd: ../..");
    assert!(has(&report, "path_traversal"), "{:?}", codes(&report));
}

#[test]
fn every_segment_of_a_glob_is_held_to_the_path_rules() {
    let rows = [
        (
            "\"content/handbook/**\"",
            "\"content/*/../../x\"",
            "path_traversal",
        ),
        ("\"content/handbook/**\"", "\"**/.git/**\"", "path_git"),
        // A wildcard spelling of `.git` is the same folder to a matcher.
        ("\"content/handbook/**\"", "\"content/.g?t/**\"", "path_git"),
        (
            "\"content/handbook/**\"",
            "\"content/.[g]it/**\"",
            "path_git",
        ),
        ("\"content/handbook/**\"", "\"content/.gi*/**\"", "path_git"),
        (
            "\"content/handbook/**\"",
            "\"content/{.Git,x}/**\"",
            "path_git",
        ),
        (
            "\"content/handbook/**\"",
            "\"{../../etc,content}/*\"",
            "path_invalid",
        ),
        (
            "\"content/handbook/**\"",
            "\"content/{config,x}/*\"",
            "path_config",
        ),
        ("\"content/handbook/**\"", "\"**\"", "path_outside_roots"),
        (
            "\"content/handbook/**\"",
            "\"elsewhere/**\"",
            "path_outside_roots",
        ),
        (
            "[\"setup/steps/*.yml\"]",
            "[\"*/../../x\"]",
            "path_traversal",
        ),
        (
            "[\"setup/steps/*.yml\"]",
            "[\"setup/steps/[\"]",
            "invalid_glob",
        ),
    ];
    for (from, to, code) in rows {
        let report = edited("good", from, to);
        assert!(
            has(&report, code),
            "{to}: wanted {code}, got {:?}",
            codes(&report)
        );
    }
}

#[test]
fn the_parts_graph_names_its_other_mistakes() {
    let rows = [
        ("targets: [claude, codex, opencode]", "targets: []", "skill_targets_empty"),
        (
            "default: true }",
            "default: true }\n  - { id: second, kind: preset, includes: [helper], default: true }",
            "preset_default_duplicate",
        ),
        ("- { name: claude }", "- { name: claude, for: [nope] }", "unknown_part"),
        (
            "    targets: [claude, codex, opencode]\n",
            "    targets: [claude, codex, opencode]\n  - { id: hello-too, kind: skill, name: hello, source: commands/hello.md, targets: [claude] }\n",
            "skill_name_duplicate",
        ),
    ];
    for (from, to, code) in rows {
        let report = edited("good", from, to);
        assert!(has(&report, code), "{code}: {:?}", codes(&report));
    }
}

fn chain(len: usize, cycle: bool) -> String {
    let mut parts: Vec<String> = (0..len)
        .map(|i| {
            format!(
                "  - {{ id: p{i}, kind: preset, includes: [], needs: [p{}] }}\n",
                i + 1
            )
        })
        .collect();
    let last = if cycle { "p0" } else { "" };
    parts.push(format!(
        "  - {{ id: p{len}, kind: preset, includes: [], needs: [{last}] }}\n"
    ));
    parts.concat()
}

#[test]
fn a_long_needs_chain_is_capped_and_a_deep_cycle_is_found_without_recursion() {
    let (_guard, pack) = scratch("good");
    write_manifest(&pack, |t| {
        t.replacen("parts:\n", &format!("parts:\n{}", chain(1_500, false)), 1)
    });
    assert!(has(&validate_dir(&pack), "too_many_parts"));

    let (_guard, pack) = scratch("good");
    write_manifest(&pack, |t| {
        t.replacen("parts:\n", &format!("parts:\n{}", chain(900, true)), 1)
    });
    let report = validate_dir(&pack);
    assert!(has(&report, "part_cycle"), "{:?}", codes(&report));
}

#[test]
fn the_entry_cap_stops_the_walk() {
    let (_guard, pack) = scratch("good");
    let few = Limits {
        max_entries: 5,
        ..Default::default()
    };
    let report = validate_dir_with(&pack, few);
    assert!(has(&report, "pack_too_many_files"), "{:?}", codes(&report));
}

#[cfg(unix)]
#[test]
fn a_fifo_in_the_pack_is_refused_not_read() {
    let (_guard, pack) = scratch("good");
    let made = std::process::Command::new("mkfifo")
        .arg(pack.join("content/pipe"))
        .status()
        .unwrap();
    assert!(made.success());
    assert!(refused(
        &validate_dir(&pack),
        "special_file",
        "content/pipe"
    ));
}

#[test]
fn foreign_licenses_and_vendored_folders_are_third_party() {
    for path in [
        "content/x/LICENSE-MIT",
        "content/x/LICENSE_APACHE",
        "content/x/NOTICE",
        "content/x/COPYRIGHT.txt",
        "content/vendor/a.md",
        "content/node_modules/a/index.js",
    ] {
        let (_guard, pack) = scratch("good");
        let full = pack.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, "x\n").unwrap();
        assert!(
            refused(&validate_dir(&pack), "third_party_bundled", path),
            "{path}"
        );
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// Rewrite the listed sha256 of `path` in a scratch pack's `files`.
fn relist(pack: &Path, path: &str, sha: &str) {
    write_manifest(pack, |t| {
        let marker = format!("- path: {path}\n    sha256: ");
        let at = t.find(&marker).unwrap() + marker.len();
        format!("{}{sha}{}", &t[..at], &t[at + 64..])
    });
}

#[test]
fn a_built_copy_that_differs_from_its_source_is_drift() {
    let (_guard, pack) = scratch("good");
    let copy = ".claude/skills/hello/SKILL.md";
    let body = b"a different skill\n";
    std::fs::write(pack.join(copy), body).unwrap();
    relist(&pack, copy, &sha256_hex(body));
    let report = validate_dir(&pack);
    assert!(
        refused(&report, "skill_copy_drift", copy),
        "{:?}",
        codes(&report)
    );
    assert!(!has(&report, "hash_mismatch"), "{:?}", codes(&report));
}

#[test]
fn a_listed_exec_bit_must_match_the_file() {
    let report = edited(
        "good",
        "- path: LICENSE\n    sha256: 78ccf3c3f93a5edd22317674793f47d6f233ae4ffaf3d04c3bcbc2c064c71120\n    exec: false",
        "- path: LICENSE\n    sha256: 78ccf3c3f93a5edd22317674793f47d6f233ae4ffaf3d04c3bcbc2c064c71120\n    exec: true",
    );
    assert!(
        refused(&report, "exec_mismatch", "LICENSE"),
        "{:?}",
        codes(&report)
    );
}

#[test]
fn risk_facts_cover_every_agent_part_config_and_setup_step() {
    let report = report("risky-more");
    assert!(report.ok, "{:?}", codes(&report));
    let facts = &report.risk;
    let skipping: Vec<_> = facts
        .skip_permission_agents
        .iter()
        .map(|s| s.agent.as_str())
        .collect();
    assert_eq!(
        skipping,
        ["agents/one/claude.yaml", "agents/two/codex.yaml"]
    );
    let hooks: Vec<_> = facts
        .cli_hooks
        .iter()
        .map(|h| (h.path.as_str(), h.detail.as_str()))
        .collect();
    for (path, detail) in [
        ("content/.claude/settings.json", "statusLine"),
        ("content/.claude/settings.json", "apiKeyHelper"),
        ("content/.codex/config.toml", "notify"),
        ("content/.codex/hooks/after.sh", ".codex/hooks"),
        ("content/.opencode/plugin/guard.js", ".opencode/plugin"),
    ] {
        assert!(
            hooks.iter().any(|(p, d)| *p == path && d.contains(detail)),
            "{path} {detail}: {hooks:?}"
        );
    }
    let servers: Vec<_> = facts
        .mcp_servers
        .iter()
        .map(|m| m.server.as_str())
        .collect();
    assert!(servers.contains(&"codex-server"), "{servers:?}");
    assert!(servers.contains(&"opencode-server"), "{servers:?}");
    assert!(facts.scripts.contains(&"content/bin/tool".to_string()));
    assert_eq!(facts.setup_step_files, ["setup/steps/access.yml"]);
    assert_eq!(facts.setup_steps.len(), 1);
    assert_eq!(facts.network_fetches.len(), 1);
    assert_eq!(facts.network_fetches[0].part, "init");

    let external = super::validate::validate_dir(&fixtures().join("good-external")).risk;
    assert_eq!(external.setup_steps.len(), 1);
    assert_eq!(external.setup_steps[0].part, "cli");
    assert!(external
        .network_fetches
        .iter()
        .any(|f| f.source == "https://github.com/example/tool" && f.version == "1.2.3"));
}

// A permission an agent sets in its own keys, not in `args`: no single string shows it.
fn agent_risk(extra_agents: &[(&str, &str)]) -> Vec<String> {
    let (_guard, pack) = scratch("risky-more");
    for (name, body) in extra_agents {
        let dir = pack.join(format!("agents/{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent.yaml"), body).unwrap();
    }
    validate_dir(&pack)
        .risk
        .skip_permission_agents
        .iter()
        .map(|s| s.agent.clone())
        .filter(|a| !a.starts_with("agents/one/") && !a.starts_with("agents/two/"))
        .collect()
}

#[test]
fn permission_keys_that_skip_checks_are_risk_facts_without_any_flag() {
    let flagged = agent_risk(&[
        (
            "codex",
            "id: c\nname: C\nruntime: codex\npermissions:\n  codex:\n    sandbox_mode: danger-full-access\n    approval_policy: never\n",
        ),
        (
            "opencode",
            "id: o\nname: O\nruntime: opencode\npermissions:\n  opencode:\n    permission:\n      \"*\": allow\n",
        ),
        (
            "hermes",
            "id: h\nname: H\nruntime: hermes\npermissions:\n  hermes:\n    approval: yolo\n",
        ),
        (
            "calm",
            "id: k\nname: K\nruntime: codex\npermissions:\n  codex:\n    sandbox_mode: workspace-write\n    approval_policy: on-request\n",
        ),
    ]);
    assert_eq!(
        flagged,
        [
            "agents/codex/agent.yaml",
            "agents/hermes/agent.yaml",
            "agents/opencode/agent.yaml"
        ]
    );
}

#[test]
fn an_agent_part_that_does_not_parse_as_an_agent_is_refused() {
    let (_guard, pack) = scratch("risky-more");
    // No `id`: the app can't read it as an agent, so its permissions can't be derived.
    std::fs::write(
        pack.join("agents/one/claude.yaml"),
        "name: One\nruntime: claude\npermissions:\n  claude:\n    default_mode: bypassPermissions\n",
    )
    .unwrap();
    let report = validate_dir(&pack);
    assert!(
        refused(&report, "agent_invalid", "agents/one/claude.yaml"),
        "{:?}",
        codes(&report)
    );
    assert!(
        !report
            .errors
            .iter()
            .any(|e| e.code == "agent_invalid"
                && e.path.as_deref() != Some("agents/one/claude.yaml")),
        "{:?}",
        codes(&report)
    );
}

#[test]
fn a_newer_pack_is_named_before_the_typed_parse_can_trip_on_it() {
    // A kind and an enum value this app has never heard of, next to the version gate.
    let future = "parts:\n  - { id: future, kind: hologram }\n";
    let report = edited("good", "pack_format: 1\n", "pack_format: 2\n");
    assert!(has(&report, "unsupported_format"), "{:?}", codes(&report));
    let report = edited("good", "parts:\n", future);
    assert!(has(&report, "manifest_invalid"), "{:?}", codes(&report));
    let (_guard, pack) = scratch("good");
    write_manifest(&pack, |t| {
        t.replacen("pack_format: 1\n", "pack_format: 2\n", 1)
            .replacen("parts:\n", future, 1)
    });
    let report = validate_dir(&pack);
    assert!(has(&report, "unsupported_format"), "{:?}", codes(&report));
    assert!(!has(&report, "manifest_invalid"), "{:?}", codes(&report));
    write_manifest(&pack, |t| {
        t.replacen("pack_format: 2\n", "pack_format: 1\n", 1)
            .replacen("requires:\n", "requires:\n  codesense: \">=99.0.0\"\n", 1)
    });
    let report = validate_dir(&pack);
    assert!(
        refused(&report, "requires_newer_codesense", "pack.yml"),
        "{:?}",
        codes(&report)
    );
    assert!(!has(&report, "manifest_invalid"), "{:?}", codes(&report));
}

#[test]
fn a_key_that_is_not_a_string_cannot_switch_off_the_unknown_key_check() {
    let raw: serde_yaml::Value = serde_yaml::from_str("? [a]\n: x\nid: y\n").unwrap();
    assert_eq!(super::validate::unknown_manifest_keys(&raw), None);
    let raw: serde_yaml::Value = serde_yaml::from_str("id: y\nbogus: 1\n").unwrap();
    assert_eq!(
        super::validate::unknown_manifest_keys(&raw),
        Some(vec!["bogus".to_string()])
    );
}

#[test]
fn a_pack_over_the_cap_is_not_read_again_for_risk() {
    let (_guard, pack) = scratch("risky-more");
    let limits = Limits {
        max_pack: 1,
        ..Default::default()
    };
    let report = validate_dir_with(&pack, limits);
    assert!(has(&report, "pack_too_large"), "{:?}", codes(&report));
    // Facts that need a file's content are skipped; those from names and modes remain.
    assert!(report.risk.skip_permission_agents.is_empty());
    assert!(!report
        .risk
        .scripts
        .contains(&"content/bin/tool".to_string()));
    assert!(!report.risk.setup_steps.is_empty());
}
