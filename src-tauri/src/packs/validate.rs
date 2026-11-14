// SPDX-License-Identifier: MIT
//! `packs::validate`: every rule a pack folder must keep before anything installs it.
//! Read-only: it parses `pack.yml`, walks the folder and reports named issues with the
//! path at fault, plus the risk facts derived from the files (see `risk`).
//!
//! The rules: paths are relative, inside a declared root, with no symlink, `..` or `.git/`;
//! 5 MB per file and 200 MB per pack; every file on disk is listed in `files` with its
//! sha256; the parts graph has no unknown id or cycle; external parts are pinned; and a
//! bundled file is the publisher's own (`third_party_bundled`). Nothing is fetched or run.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::manifest::{ExternalMethod, PackManifest, Part, PACK_FORMAT};
use super::risk::{self, RiskFacts};

pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_PACK_BYTES: u64 = 200 * 1024 * 1024;

// Where a pack's files may live: these top-level folders and these files, plus the
// runtime locations the pack build writes skill copies to.
const ROOT_DIRS: &[&str] = &[
    "content", "panes", "seed", "agents", "routines", "roles", "docs", "media", "commands", "setup",
];
const ROOT_FILES: &[&str] = &["pack.yml", "CHANGELOG.md", "LICENSE", "NOTICE.md"];
const RUNTIME_ROOTS: &[&str] = &[".claude/skills/", ".agents/skills/", ".opencode/command/"];

const THIRD_PARTY_DIRS: &[&str] = &["third_party", "third-party", "thirdparty"];
const LICENSE_STEMS: &[&str] = &["LICENSE", "LICENCE", "COPYING", "UNLICENSE"];

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_file: u64,
    pub max_pack: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_file: MAX_FILE_BYTES,
            max_pack: MAX_PACK_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackIssue {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

impl PackIssue {
    fn at(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Self {
        PackIssue {
            code,
            path: Some(path.into()),
            message: message.into(),
        }
    }

    fn bare(code: &'static str, message: impl Into<String>) -> Self {
        PackIssue {
            code,
            path: None,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub license: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartSummary {
    pub id: String,
    pub kind: &'static str,
    pub needs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackReport {
    pub ok: bool,
    pub errors: Vec<PackIssue>,
    pub warnings: Vec<PackIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack: Option<PackSummary>,
    pub parts: Vec<PartSummary>,
    pub risk: RiskFacts,
}

impl PackReport {
    fn new() -> Self {
        PackReport {
            ok: false,
            errors: Vec::new(),
            warnings: Vec::new(),
            pack: None,
            parts: Vec::new(),
            risk: Default::default(),
        }
    }

    fn error(&mut self, issue: PackIssue) {
        if !self.errors.contains(&issue) {
            self.errors.push(issue);
        }
    }

    fn finish(mut self) -> Self {
        self.ok = self.errors.is_empty();
        self
    }
}

/// The first rule a relative path in a pack breaks, as an issue code and a message.
/// A trailing `/` (a destination folder) is fine; glob characters are left to the caller.
pub fn path_rule(raw: &str) -> Option<(&'static str, String)> {
    if raw.is_empty()
        || raw
            .chars()
            .any(|c| c == '\0' || c == '\\' || c.is_control())
    {
        return Some((
            "path_invalid",
            "empty, or holds a backslash or control character".into(),
        ));
    }
    let bytes = raw.as_bytes();
    if raw.starts_with('/') || (bytes.len() > 1 && bytes[1] == b':') {
        return Some(("path_absolute", "absolute paths are refused".into()));
    }
    let trimmed = raw.strip_suffix('/').unwrap_or(raw);
    let parts: Vec<&str> = trimmed.split('/').collect();
    for part in &parts {
        match *part {
            ".." | "." => {
                return Some((
                    "path_traversal",
                    "`..` and `.` components are refused".into(),
                ))
            }
            ".git" => return Some(("path_git", "a `.git` folder is never part of a pack".into())),
            "" => return Some(("path_invalid", "an empty path component".into())),
            _ => {}
        }
    }
    if parts.len() >= 2 && parts[0] == "content" && parts[1] == "config" {
        return Some(("path_config", "`config/` under content is refused".into()));
    }
    None
}

fn in_declared_roots(path: &str) -> bool {
    ROOT_FILES.contains(&path)
        || ROOT_DIRS
            .iter()
            .any(|dir| path.starts_with(&format!("{dir}/")))
        || RUNTIME_ROOTS.iter().any(|root| path.starts_with(root))
}

// The literal folders before the first glob character, so a glob is held to the same rules.
fn glob_literal(glob: &str) -> &str {
    match glob.find(['*', '?', '[', '{']) {
        Some(at) => glob[..at]
            .trim_end_matches(|c| c != '/')
            .trim_end_matches('/'),
        None => glob,
    }
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

struct DiskFile {
    path: String,
    size: u64,
}

// Regular files, relative to the root with `/`; symlinks and `.git` are issues, not files.
fn scan_disk(root: &Path, report: &mut PackReport) -> Vec<DiskFile> {
    let mut files = Vec::new();
    let mut walk = WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter();
    while let Some(entry) = walk.next() {
        let Ok(entry) = entry else { continue };
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let path = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if path.is_empty() {
            continue;
        }
        let kind = entry.file_type();
        if kind.is_symlink() {
            report.error(PackIssue::at("symlink", &path, "symlinks are refused"));
        } else if kind.is_dir() {
            if entry.file_name() == ".git" {
                report.error(PackIssue::at(
                    "path_git",
                    &path,
                    "a `.git` folder is never part of a pack",
                ));
                walk.skip_current_dir();
            }
        } else if kind.is_file() && path != "pack.yml" {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(DiskFile { path, size });
        }
    }
    files
}

fn sha256_of(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

// The `license:` of a SKILL.md frontmatter, if it has one.
fn skill_license(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_end(&mut head)
        .ok()?;
    let text = String::from_utf8_lossy(&head);
    let body = text.strip_prefix("---")?;
    let end = body.find("\n---")?;
    body[..end].lines().find_map(|line| {
        let value = line.strip_prefix("license:")?;
        Some(value.trim().trim_matches(['"', '\'']).to_string())
    })
}

fn third_party(path: &str) -> bool {
    let components: Vec<&str> = path.split('/').collect();
    let dir_hit = components[..components.len().saturating_sub(1)]
        .iter()
        .any(|c| THIRD_PARTY_DIRS.contains(&c.to_ascii_lowercase().as_str()));
    let name = components.last().copied().unwrap_or("");
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    // The pack's own LICENSE sits at the root; a nested one belongs to someone else's code.
    let foreign_license = components.len() > 1 && LICENSE_STEMS.contains(&stem.as_str());
    dir_hit || foreign_license
}

pub fn validate_dir(root: &Path) -> PackReport {
    validate_dir_with(root, Limits::default())
}

pub fn validate_dir_with(root: &Path, limits: Limits) -> PackReport {
    let mut report = PackReport::new();
    let text = match std::fs::read_to_string(root.join("pack.yml")) {
        Ok(text) => text,
        Err(e) => {
            report.error(PackIssue::at(
                "manifest_missing",
                "pack.yml",
                format!("cannot read pack.yml: {e}"),
            ));
            return report.finish();
        }
    };
    let raw: serde_yaml::Value = match serde_yaml::from_str(&text) {
        Ok(raw) => raw,
        Err(e) => {
            report.error(PackIssue::at(
                "manifest_invalid",
                "pack.yml",
                format!("not valid YAML: {e}"),
            ));
            return report.finish();
        }
    };
    if raw.get("risk").is_some() {
        report.warnings.push(PackIssue::at(
            "risk_claim_ignored",
            "pack.yml",
            "a pack's own risk claim is ignored; risk facts are derived from its files",
        ));
    }
    let manifest: PackManifest = match serde_yaml::from_value(raw) {
        Ok(manifest) => manifest,
        Err(e) => {
            report.error(PackIssue::at("manifest_invalid", "pack.yml", e.to_string()));
            return report.finish();
        }
    };

    check_identity(&manifest, &mut report);
    let disk = scan_disk(root, &mut report);
    check_files(root, &manifest, &disk, limits, &mut report);
    check_parts(&manifest, &mut report);
    check_part_files(&manifest, &disk, &mut report);

    report.pack = Some(PackSummary {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        publisher: manifest.publisher.clone(),
        license: manifest.license.clone(),
    });
    report.parts = manifest
        .parts
        .iter()
        .map(|part| PartSummary {
            id: part.id().to_string(),
            kind: part.kind(),
            needs: part.needs().to_vec(),
        })
        .collect();
    let paths: Vec<String> = disk.iter().map(|f| f.path.clone()).collect();
    report.risk = risk::derive(root, &manifest, &paths, limits.max_file);
    report.finish()
}

fn check_identity(manifest: &PackManifest, report: &mut PackReport) {
    if manifest.pack_format != PACK_FORMAT {
        report.error(PackIssue::at(
            "unsupported_format",
            "pack.yml",
            format!(
                "pack_format {} is not supported (expected {PACK_FORMAT})",
                manifest.pack_format
            ),
        ));
    }
    let id = Regex::new(r"^[a-z0-9][a-z0-9-]*$").unwrap();
    if !id.is_match(&manifest.id) {
        report.error(PackIssue::at("invalid_id", "pack.yml", "id is [a-z0-9-]"));
    }
    let version = Regex::new(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$").unwrap();
    if !version.is_match(&manifest.version) {
        report.error(PackIssue::at(
            "invalid_version",
            "pack.yml",
            format!("version {} is not semver", manifest.version),
        ));
    }
}

// `files` against the disk: every file listed, hashed, in a declared root, and the caps.
fn check_files(
    root: &Path,
    manifest: &PackManifest,
    disk: &[DiskFile],
    limits: Limits,
    report: &mut PackReport,
) {
    let on_disk: BTreeMap<&str, &DiskFile> = disk.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut listed: BTreeSet<&str> = BTreeSet::new();
    for entry in &manifest.files {
        let path = entry.path.as_str();
        if path == "pack.yml" {
            report.error(PackIssue::at(
                "file_self_listed",
                path,
                "pack.yml cannot list itself",
            ));
        }
        if !listed.insert(path) {
            report.error(PackIssue::at("file_duplicate", path, "listed twice"));
        }
        if !is_hex(&entry.sha256, 64) {
            report.error(PackIssue::at(
                "hash_malformed",
                path,
                "sha256 is 64 lowercase hex characters",
            ));
        }
        match on_disk.get(path) {
            None => report.error(PackIssue::at(
                "file_missing",
                path,
                "listed in files but not in the pack",
            )),
            Some(file) if file.size <= limits.max_file => {
                if sha256_of(&root.join(path)).is_some_and(|actual| actual != entry.sha256) {
                    report.error(PackIssue::at(
                        "hash_mismatch",
                        path,
                        "the file's sha256 differs from the one in files",
                    ));
                }
            }
            Some(_) => {}
        }
    }

    let mut total = 0u64;
    for file in disk {
        total += file.size;
        if file.size > limits.max_file {
            report.error(PackIssue::at(
                "file_too_large",
                &file.path,
                format!(
                    "{} bytes is over the {} byte file cap",
                    file.size, limits.max_file
                ),
            ));
        }
        if !listed.contains(file.path.as_str()) {
            report.error(PackIssue::at(
                "file_unlisted",
                &file.path,
                "in the pack but not listed in files",
            ));
        }
    }
    if total > limits.max_pack {
        report.error(PackIssue::bare(
            "pack_too_large",
            format!(
                "{total} bytes is over the {} byte pack cap",
                limits.max_pack
            ),
        ));
    }

    let every: BTreeSet<&str> = disk
        .iter()
        .map(|f| f.path.as_str())
        .chain(manifest.files.iter().map(|f| f.path.as_str()))
        .collect();
    for path in every {
        if let Some((code, message)) = path_rule(path) {
            report.error(PackIssue::at(code, path, message));
        } else if !in_declared_roots(path) {
            report.error(PackIssue::at(
                "path_outside_roots",
                path,
                "not under a declared root (content, panes, seed, agents, routines, roles, docs, media, commands, setup)",
            ));
        }
        let own_license = manifest.license.to_ascii_lowercase();
        let skill_mismatch = path.ends_with("/SKILL.md")
            && skill_license(&root.join(path))
                .is_some_and(|license| license.to_ascii_lowercase() != own_license);
        if third_party(path) || skill_mismatch {
            report.error(PackIssue::at(
                "third_party_bundled",
                path,
                "a bundled file must be the publisher's own work under the pack license; reference third-party code as an external part",
            ));
        }
    }
}

// Part paths follow the same rules as files; the graph has no unknown id or cycle.
fn check_parts(manifest: &PackManifest, report: &mut PackReport) {
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for part in &manifest.parts {
        if !ids.insert(part.id()) {
            report.error(PackIssue::at(
                "duplicate_part",
                format!("parts/{}", part.id()),
                "two parts share an id",
            ));
        }
    }
    let mut edges: BTreeMap<&str, Vec<&str>> = Default::default();
    for part in &manifest.parts {
        let includes: &[String] = match part {
            Part::Preset { includes, .. } => includes,
            _ => &[],
        };
        let links = part
            .needs()
            .iter()
            .map(|n| ("needs", n))
            .chain(includes.iter().map(|n| ("includes", n)));
        for (field, target) in links {
            if ids.contains(target.as_str()) {
                edges.entry(part.id()).or_default().push(target.as_str());
            } else {
                report.error(PackIssue::at(
                    "unknown_part",
                    format!("parts/{}/{field}", part.id()),
                    format!("{target} is not a part of this pack"),
                ));
            }
        }
    }
    if let Some(id) = find_cycle(&edges) {
        report.error(PackIssue::at(
            "part_cycle",
            format!("parts/{id}"),
            "parts need each other in a cycle",
        ));
    }
    for part in &manifest.parts {
        check_part(part, report);
    }
}

// Depth-first search; returns a part that sits on a cycle.
fn find_cycle<'a>(edges: &BTreeMap<&'a str, Vec<&'a str>>) -> Option<&'a str> {
    fn visit<'a>(
        node: &'a str,
        edges: &BTreeMap<&'a str, Vec<&'a str>>,
        done: &mut BTreeSet<&'a str>,
        active: &mut BTreeSet<&'a str>,
    ) -> Option<&'a str> {
        if done.contains(node) {
            return None;
        }
        if !active.insert(node) {
            return Some(node);
        }
        for next in edges.get(node).into_iter().flatten() {
            if let Some(hit) = visit(*next, edges, done, active) {
                return Some(hit);
            }
        }
        active.remove(node);
        done.insert(node);
        None
    }
    let mut done = BTreeSet::new();
    let mut active = BTreeSet::new();
    edges
        .keys()
        .find_map(|node| visit(*node, edges, &mut done, &mut active))
}

// A path a part names, held to the same rules as a file; a glob by its literal folders.
fn part_path(report: &mut PackReport, id: &str, field: &str, value: &str, glob: bool) {
    let literal = if glob { glob_literal(value) } else { value };
    if literal.is_empty() && glob {
        return;
    }
    if let Some((code, message)) = path_rule(literal) {
        report.error(PackIssue::at(
            code,
            value,
            format!("parts/{id}/{field}: {message}"),
        ));
    }
}

fn unpinned(report: &mut PackReport, id: &str, message: &str) {
    report.error(PackIssue::at(
        "external_unpinned",
        format!("parts/{id}"),
        message,
    ));
}

fn check_part(part: &Part, report: &mut PackReport) {
    let id = part.id();
    match part {
        Part::Preset { .. } => {}
        Part::Agent { file, .. } | Part::Routine { file, .. } => {
            part_path(report, id, "file", file, false)
        }
        Part::Content { paths, .. } | Part::Dashboards { paths, .. } => {
            for p in paths {
                part_path(report, id, "paths", p, true);
            }
        }
        Part::Skill { source, name, .. } => {
            part_path(report, id, "source", source, false);
            let name = name.as_deref().unwrap_or(id);
            if !Regex::new(r"^[a-z0-9][a-z0-9-]*$").unwrap().is_match(name) {
                report.error(PackIssue::at(
                    "invalid_skill_name",
                    format!("parts/{id}"),
                    "a skill name is [a-z0-9-]",
                ));
            }
        }
        Part::Seed { from, to, .. } => {
            part_path(report, id, "from", from, false);
            part_path(report, id, "to", to, false);
        }
        Part::Setup { command, .. } => {
            if command.trim().is_empty() {
                report.error(PackIssue::at(
                    "setup_command_empty",
                    format!("parts/{id}"),
                    "a setup step names the exact upstream command",
                ));
            }
        }
        Part::External {
            method,
            source,
            version,
            commit,
            integrity,
            paths,
            setup,
            ..
        } => {
            if version.trim().is_empty() {
                unpinned(report, id, "an external part pins a version");
            }
            match (source.git.is_some(), source.npm.is_some()) {
                (true, false) => {
                    if !commit.as_deref().is_some_and(|c| is_hex(c, 40)) {
                        unpinned(report, id, "a git source pins a full 40-hex commit");
                    }
                }
                (false, true) => {
                    let pinned = integrity.as_deref().is_some_and(|i| {
                        ["sha512-", "sha384-", "sha256-"]
                            .iter()
                            .any(|prefix| i.starts_with(prefix))
                    });
                    if !pinned {
                        unpinned(
                            report,
                            id,
                            "an npm source pins the registry integrity (sha512-...)",
                        );
                    }
                }
                _ => report.error(PackIssue::at(
                    "external_source_invalid",
                    format!("parts/{id}"),
                    "an external part names exactly one source: npm or git",
                )),
            }
            match method {
                ExternalMethod::Files => {
                    if paths.is_empty() {
                        report.error(PackIssue::at(
                            "external_paths_missing",
                            format!("parts/{id}"),
                            "method files maps upstream paths to destinations",
                        ));
                    }
                    for destinations in paths.values() {
                        for dest in destinations {
                            part_path(report, id, "paths", dest, false);
                        }
                    }
                }
                ExternalMethod::Setup => {
                    if setup.as_ref().is_none_or(|s| s.run.trim().is_empty()) {
                        report.error(PackIssue::at(
                            "external_setup_missing",
                            format!("parts/{id}"),
                            "method setup names the exact upstream command in setup.run",
                        ));
                    }
                }
            }
        }
    }
}

// What a part points at in the pack must be listed, and a skill's built copies too.
fn check_part_files(manifest: &PackManifest, disk: &[DiskFile], report: &mut PackReport) {
    let present: BTreeSet<&str> = disk.iter().map(|f| f.path.as_str()).collect();
    for part in &manifest.parts {
        let id = part.id();
        match part {
            Part::Agent { file, .. } | Part::Routine { file, .. } => {
                if path_rule(file).is_none() && !present.contains(file.as_str()) {
                    report.error(PackIssue::at(
                        "part_file_missing",
                        file,
                        format!("parts/{id} points at a file the pack does not hold"),
                    ));
                }
            }
            Part::Seed { from, .. } => {
                if path_rule(from).is_none() && !present.contains(from.as_str()) {
                    report.error(PackIssue::at(
                        "part_file_missing",
                        from,
                        format!("parts/{id} points at a file the pack does not hold"),
                    ));
                }
            }
            Part::Skill {
                source,
                targets,
                name,
                ..
            } => {
                if path_rule(source).is_none() && !present.contains(source.as_str()) {
                    report.error(PackIssue::at(
                        "part_file_missing",
                        source,
                        format!("parts/{id} points at a file the pack does not hold"),
                    ));
                }
                let name = name.as_deref().unwrap_or(id);
                for target in targets {
                    let built = target.built_path(name);
                    if !present.contains(built.as_str()) {
                        report.error(PackIssue::at(
                            "skill_copy_missing",
                            built,
                            format!(
                                "parts/{id} has no built copy for this target; run the pack build"
                            ),
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    for glob in &manifest.setup_steps {
        if let Some((code, message)) = path_rule(glob_literal(glob)) {
            report.error(PackIssue::at(code, glob, format!("setup_steps: {message}")));
        }
    }
}
