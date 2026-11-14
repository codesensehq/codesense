// SPDX-License-Identifier: MIT
//! The pack and lock models: wire shapes accepted and refused, and the exported JSON
//! Schemas agreeing with the serde types on both.

use std::path::{Path, PathBuf};

use rmcp::schemars::schema_for;
use serde_json::{json, Value};

use super::lock::{LicenseClass, LockSourceKind, LockTrust, PacksLock};
use super::manifest::{ExternalMethod, Follow, PackManifest, Part, SkillTarget};

fn fixture(name: &str) -> String {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("scripts/fixtures/packs")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn manifest_schema() -> Value {
    serde_json::to_value(schema_for!(PackManifest)).unwrap()
}

fn lock_schema() -> Value {
    serde_json::to_value(schema_for!(PacksLock)).unwrap()
}

fn base() -> Value {
    json!({
        "pack_format": 1, "id": "demo", "name": "Demo", "version": "0.1.0",
        "publisher": "me", "summary": "A demo.", "license": "MIT",
        "parts": [{"id": "a", "kind": "agent", "file": "agents/a/agent.yaml"}]
    })
}

fn with(patch: Value) -> Value {
    let mut wire = base();
    for (key, value) in patch.as_object().unwrap() {
        wire[key] = value.clone();
    }
    wire
}

#[test]
fn the_design_example_pack_parses_and_validates_against_the_schema() {
    let wire: Value = serde_yaml::from_str(&fixture("design-example.pack.yml")).unwrap();
    assert!(
        jsonschema::is_valid(&manifest_schema(), &wire),
        "schema refuses the design example"
    );
    let manifest: PackManifest = serde_yaml::from_str(&fixture("design-example.pack.yml")).unwrap();
    assert_eq!(manifest.parts.len(), 8);
    let kinds: Vec<_> = manifest.parts.iter().map(Part::kind).collect();
    assert_eq!(
        kinds,
        [
            "preset",
            "agent",
            "content",
            "external",
            "external",
            "routine",
            "dashboards",
            "seed"
        ]
    );
    let Part::External { method, source, .. } = &manifest.parts[3] else {
        panic!("bmad is external");
    };
    assert_eq!(*method, ExternalMethod::Setup);
    assert_eq!(source.npm.as_deref(), Some("bmad-method"));
    assert_eq!(manifest.files.len(), 1);
}

#[test]
fn the_design_example_lock_parses_and_validates_against_the_schema() {
    let wire: Value = serde_yaml::from_str(&fixture("design-example.packs.lock.yml")).unwrap();
    assert!(
        jsonschema::is_valid(&lock_schema(), &wire),
        "schema refuses the design lock"
    );
    let lock: PacksLock = serde_yaml::from_str(&fixture("design-example.packs.lock.yml")).unwrap();
    assert_eq!(lock.packs.len(), 1);
    let pack = &lock.packs[0];
    assert_eq!(pack.trust, LockTrust::Verified);
    assert_eq!(pack.source.kind, LockSourceKind::Catalog);
    assert_eq!(pack.external.len(), 2);
    assert_eq!(pack.external[1].method, ExternalMethod::Setup);
    let license = pack.external[0].license.as_ref().unwrap();
    assert_eq!(license.class, Some(LicenseClass::OpenSource));
    assert_eq!(license.confidence, Some(0.99));
    assert_eq!(pack.external[0].follow, Some(Follow::Pinned));
}

#[test]
fn a_lock_round_trips_through_yaml_unchanged() {
    let lock: PacksLock = serde_yaml::from_str(&fixture("design-example.packs.lock.yml")).unwrap();
    let again: PacksLock = serde_yaml::from_str(&serde_yaml::to_string(&lock).unwrap()).unwrap();
    assert_eq!(lock, again);
}

#[test]
fn a_skill_part_with_targets_requires_kit_and_setup_steps_parse() {
    let wire = with(json!({
        "requires": {"clis": [{"name": "claude"}], "kit": {"chat": 1}},
        "setup_steps": ["setup/steps/*.yml"],
        "parts": [
            {"id": "codesense-setup", "kind": "skill", "source": "commands/codesense-setup.md",
             "targets": ["claude", "codex", "opencode", "hermes"]},
            {"id": "upstream", "kind": "setup", "command": "npx tool@1.2.3 init"}
        ]
    }));
    assert!(jsonschema::is_valid(&manifest_schema(), &wire));
    let manifest: PackManifest = serde_json::from_value(wire).unwrap();
    assert_eq!(manifest.requires.unwrap().kit.unwrap().chat, Some(1));
    assert_eq!(manifest.setup_steps, ["setup/steps/*.yml"]);
    let Part::Skill {
        source, targets, ..
    } = &manifest.parts[0]
    else {
        panic!("a skill part");
    };
    assert_eq!(source, "commands/codesense-setup.md");
    assert_eq!(targets, &SkillTarget::ALL);
    let Part::Setup { command, .. } = &manifest.parts[1] else {
        panic!("a setup part");
    };
    assert_eq!(command, "npx tool@1.2.3 init");
}

#[test]
fn skill_targets_build_to_each_runtimes_own_location() {
    let rows = [
        (
            SkillTarget::Claude,
            ".claude/skills/codesense-setup/SKILL.md",
        ),
        (
            SkillTarget::Codex,
            ".agents/skills/codesense-setup/SKILL.md",
        ),
        (
            SkillTarget::Opencode,
            ".opencode/command/codesense-setup.md",
        ),
        (
            SkillTarget::Hermes,
            ".hermes/skills/codesense-setup/SKILL.md",
        ),
    ];
    for (target, path) in rows {
        assert_eq!(target.built_path("codesense-setup"), path);
    }
}

#[test]
fn a_publishers_risk_claim_is_carried_nowhere() {
    let wire = with(json!({"risk": {"level": "none"}}));
    let manifest: PackManifest = serde_json::from_value(wire).unwrap();
    let rendered = serde_json::to_value(&manifest).unwrap();
    assert!(rendered.get("risk").is_none());
}

#[test]
fn the_schema_and_the_serde_model_refuse_the_same_bad_manifests() {
    let rows: [(&str, Value); 13] = [
        ("no id", {
            let mut w = base();
            w.as_object_mut().unwrap().remove("id");
            w
        }),
        ("no parts", {
            let mut w = base();
            w.as_object_mut().unwrap().remove("parts");
            w
        }),
        (
            "pack_format not a number",
            with(json!({"pack_format": "1"})),
        ),
        (
            "unknown part kind",
            with(json!({"parts": [{"id": "a", "kind": "script", "file": "x"}]})),
        ),
        (
            "agent part without a file",
            with(json!({"parts": [{"id": "a", "kind": "agent"}]})),
        ),
        (
            "skill part without targets",
            with(json!({"parts": [{"id": "a", "kind": "skill", "source": "c.md"}]})),
        ),
        (
            "unknown skill target",
            with(
                json!({"parts": [{"id": "a", "kind": "skill", "source": "c.md", "targets": ["vim"]}]}),
            ),
        ),
        (
            "kit chat not an integer",
            with(json!({"requires": {"kit": {"chat": "1"}}})),
        ),
        (
            "kit chat negative",
            with(json!({"requires": {"kit": {"chat": -1}}})),
        ),
        (
            "unknown kit module",
            with(json!({"requires": {"kit": {"canvas": 1}}})),
        ),
        (
            "external without a version",
            with(
                json!({"parts": [{"id": "a", "kind": "external", "method": "files", "source": {"npm": "x"}}]}),
            ),
        ),
        (
            "external follow not pinned or latest-compatible",
            with(
                json!({"parts": [{"id": "a", "kind": "external", "method": "files", "source": {"npm": "x"}, "version": "1.0.0", "follow": "latest"}]}),
            ),
        ),
        (
            "external method unknown",
            with(
                json!({"parts": [{"id": "a", "kind": "external", "method": "curl", "source": {"npm": "x"}, "version": "1.0.0"}]}),
            ),
        ),
    ];
    let schema = manifest_schema();
    for (name, wire) in rows {
        assert!(
            serde_json::from_value::<PackManifest>(wire.clone()).is_err(),
            "{name}: serde accepted it"
        );
        assert!(
            !jsonschema::is_valid(&schema, &wire),
            "{name}: the schema accepted it"
        );
    }
}

#[test]
fn a_manifest_round_trips_through_yaml_unchanged() {
    let manifest: PackManifest = serde_yaml::from_str(&fixture("design-example.pack.yml")).unwrap();
    let again: PackManifest =
        serde_yaml::from_str(&serde_yaml::to_string(&manifest).unwrap()).unwrap();
    assert_eq!(manifest, again);
}

#[test]
fn the_lock_refuses_an_unknown_trust_and_a_missing_format() {
    for wire in [
        json!({"packs": []}),
        json!({"lock_format": 1, "packs": [{"id": "a", "version": "1.0.0",
            "source": {"kind": "catalog"}, "archive_sha256": "x", "trust": "trusted",
            "installed_at": "2026-11-20T18:00:00Z", "parts": {}}]}),
        lock_with_external(json!({"follow": "sometimes"})),
        lock_with_external(json!({"license": {"spdx": "MIT", "class": "free"}})),
    ] {
        assert!(
            serde_json::from_value::<PacksLock>(wire.clone()).is_err(),
            "{wire}"
        );
        assert!(!jsonschema::is_valid(&lock_schema(), &wire), "{wire}");
    }
}

fn lock_with_external(patch: Value) -> Value {
    let mut external = json!({"id": "x", "method": "files", "source": "npm:x", "version": "1.0.0"});
    for (key, value) in patch.as_object().unwrap() {
        external[key] = value.clone();
    }
    json!({"lock_format": 1, "packs": [{"id": "a", "version": "1.0.0",
        "source": {"kind": "catalog"}, "archive_sha256": "x", "trust": "verified",
        "installed_at": "2026-11-20T18:00:00Z", "parts": {}, "external": [external]}]})
}

#[test]
fn a_well_formed_lock_external_is_accepted() {
    let wire = lock_with_external(json!({"follow": "latest-compatible",
        "license": {"spdx": "GPL-3.0", "class": "copyleft", "confidence": 0.95}}));
    assert!(jsonschema::is_valid(&lock_schema(), &wire));
    let lock: PacksLock = serde_json::from_value(wire).unwrap();
    assert_eq!(
        lock.packs[0].external[0].follow,
        Some(Follow::LatestCompatible)
    );
}

#[test]
fn a_folder_source_keeps_no_local_path_in_the_shared_lock() {
    let wire = json!({"lock_format": 1, "packs": [{"id": "a", "version": "1.0.0",
        "source": {"kind": "folder", "path": "/home/someone/packs/a"}, "archive_sha256": "x",
        "trust": "unverified", "installed_at": "2026-11-20T18:00:00Z", "parts": {}}]});
    let lock: PacksLock = serde_json::from_value(wire).unwrap();
    assert_eq!(lock.packs[0].source.kind, LockSourceKind::Folder);
    let written = serde_yaml::to_string(&lock).unwrap();
    assert!(!written.contains("/home/someone"), "{written}");
    let schema = lock_schema();
    assert!(schema["$defs"]["LockSource"]["properties"]
        .get("path")
        .is_none());
}
