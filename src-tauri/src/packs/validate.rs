// SPDX-License-Identifier: MIT
//! `packs::validate`: every rule a pack folder must keep before anything installs it.
//! Read-only: it parses `pack.yml`, walks the folder and reports named issues with the
//! path at fault, plus the risk facts derived from the files (see `risk`).
//!
//! The rules: paths are relative, inside a declared root, with no symlink, special file,
//! `..` or `.git` in any case; `pack.yml` is a regular file of at most 1 MB with no unknown
//! key; 5 MB per file, 200 MB and 10,000 entries per pack; every file on disk is listed in
//! `files` with its sha256 and exec bit; the parts graph has no unknown id or cycle;
//! external parts are pinned to an https forge or an npm name; and a bundled file is the
//! publisher's own (`third_party_bundled`). Nothing is fetched or run, and nothing is read
//! through a symlink or outside the folder.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::manifest::{ExternalMethod, PackManifest, Part, PACK_FORMAT};
use super::risk::{self, RiskFacts};

pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_PACK_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const MAX_ENTRIES: usize = 10_000;
pub const MAX_PARTS: usize = 1_000;

// Where a pack's files may live: these top-level folders and these files, plus the
// runtime locations the pack build writes skill copies to.
const ROOT_DIRS: &[&str] = &[
    "content", "panes", "seed", "agents", "routines", "roles", "docs", "media", "commands", "setup",
];
const ROOT_FILES: &[&str] = &["pack.yml", "CHANGELOG.md", "LICENSE", "NOTICE.md"];
const RUNTIME_ROOTS: &[&str] = &[
    ".claude/skills/",
    ".agents/skills/",
    ".opencode/command/",
    ".hermes/skills/",
];

const THIRD_PARTY_DIRS: &[&str] = &[
    "third_party",
    "third-party",
    "thirdparty",
    "vendor",
    "node_modules",
];
const LICENSE_STEMS: &[&str] = &[
    "LICENSE",
    "LICENCE",
    "COPYING",
    "UNLICENSE",
    "NOTICE",
    "COPYRIGHT",
];

const LICENSE_PREFIXES: &[&str] = &["LICENSE", "LICENCE", "COPYING"];

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]*$").unwrap());
static SEMVER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$").unwrap());
static NPM_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$").unwrap());
static FORGE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^https://[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$",
    )
    .unwrap()
});
static INTEGRITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$").unwrap());
// The keys `pack.yml` may hold, from the same model the schema is exported from.
static MANIFEST_SCHEMA: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::to_value(rmcp::schemars::schema_for!(PackManifest)).unwrap_or_default()
});

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_file: u64,
    pub max_pack: u64,
    pub max_entries: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_file: MAX_FILE_BYTES,
            max_pack: MAX_PACK_BYTES,
            max_entries: MAX_ENTRIES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
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
    #[serde(skip)]
    seen: BTreeSet<PackIssue>,
}

impl PackReport {
    fn empty() -> Self {
        PackReport {
            ok: false,
            errors: Default::default(),
            warnings: Default::default(),
            pack: None,
            parts: Default::default(),
            risk: Default::default(),
            seen: Default::default(),
        }
    }

    fn error(&mut self, issue: PackIssue) {
        if self.seen.insert(issue.clone()) {
            self.errors.push(issue);
        }
    }

    fn finish(mut self) -> Self {
        self.ok = self.errors.is_empty();
        self
    }
}

/// At most `cap` bytes of the regular file at `path`, never through a symlink and never
/// blocking on a FIFO or device. `Err` says why not, without the file's content.
pub(super) fn read_regular(path: &Path, cap: u64) -> Result<Vec<u8>, &'static str> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "cannot be opened (missing, a symlink, or unreadable)")?;
    let meta = file.metadata().map_err(|_| "cannot be read")?;
    if !meta.is_file() {
        return Err("is not a regular file");
    }
    if meta.len() > cap {
        return Err("is over the size cap");
    }
    let mut bytes: Vec<u8> = Default::default();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot be read")?;
    if bytes.len() as u64 > cap {
        return Err("is over the size cap");
    }
    Ok(bytes)
}

// A short clip of a parser message: the file is the caller's to read, but a report is
// relayed, so it never carries more than a line of it.
fn clip(message: &str) -> String {
    let line = message.lines().next().unwrap_or_default();
    match line.char_indices().nth(200) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

/// The first rule a relative path in a pack breaks, as an issue code and a message.
/// A trailing `/` (a destination folder) is fine; glob characters are left to the caller.
/// Components compare case-insensitively: on APFS `.GIT` is `.git`.
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
        if let Some(rule) = component_rule(part) {
            return Some(rule);
        }
    }
    if parts.len() >= 2
        && parts[0].eq_ignore_ascii_case("content")
        && parts[1].eq_ignore_ascii_case("config")
    {
        return Some(("path_config", "`config/` under content is refused".into()));
    }
    None
}

// One `/`-separated component: no `..`, `.`, `.git` in any spelling, or empty name.
fn component_rule(part: &str) -> Option<(&'static str, String)> {
    let lower = part.to_ascii_lowercase();
    if part == ".." || part == "." {
        return Some((
            "path_traversal",
            "`..` and `.` components are refused".into(),
        ));
    }
    if lower == ".git" || lower == "git~1" {
        return Some(("path_git", "a `.git` folder is never part of a pack".into()));
    }
    if part.is_empty() {
        return Some(("path_invalid", "an empty path component".into()));
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return Some((
            "path_invalid",
            "a component may not end in a dot or a space".into(),
        ));
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

// The literal folders before the first glob character.
fn glob_literal(glob: &str) -> &str {
    match glob.find(['*', '?', '[', '{']) {
        Some(at) => glob[..at]
            .trim_end_matches(|c| c != '/')
            .trim_end_matches('/'),
        None => glob,
    }
}

// Each spelling of a glob's `{a,b}` groups (not nested), at most 64.
fn expand_braces(glob: &str) -> Option<Vec<String>> {
    let Some(open) = glob.find('{') else {
        return Some(vec![glob.to_string()]);
    };
    let close = open + glob[open..].find('}')?;
    let inner = &glob[open + 1..close];
    if inner.contains('{') {
        return None;
    }
    let mut out: Vec<String> = Default::default();
    for choice in inner.split(',') {
        let spelled = format!("{}{choice}{}", &glob[..open], &glob[close + 1..]);
        out.extend(expand_braces(&spelled)?);
        if out.len() > 64 {
            return None;
        }
    }
    Some(out)
}

// A glob segment with a literal part that a matcher would take for `.git` (`.g?t`, `.[g]it`,
// `.gi*`). A segment of only `*`s is the usual wildcard and stays; whatever matches a pack's
// paths against a fetched tree must still skip `.git` itself.
fn git_wildcard_rule(part: &str) -> Option<(&'static str, String)> {
    if part.chars().all(|c| c == '*') {
        return None;
    }
    let matcher = globset::GlobBuilder::new(part)
        .case_insensitive(true)
        .build()
        .ok()?
        .compile_matcher();
    matcher.is_match(".git").then(|| {
        (
            "path_git",
            "a glob segment that could match `.git` is refused".into(),
        )
    })
}

/// The first rule a glob in `pack.yml` breaks: every segment of every spelling is held to
/// the path rules, and with `rooted` its literal folders sit under a declared root.
pub fn glob_rule(glob: &str, rooted: bool) -> Option<(&'static str, String)> {
    // A `{}` group holding `/` or `..` reshapes the path; refuse it outright.
    let mut rest = glob;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').map_or(rest.len(), |c| open + c);
        let inner = &rest[open..close];
        if inner.contains('/') || inner.contains("..") {
            return Some((
                "path_invalid",
                "a `{}` group may not hold `/` or `..`".into(),
            ));
        }
        rest = &rest[close..];
        rest = rest.strip_prefix('}').unwrap_or(rest);
    }
    if globset::Glob::new(glob).is_err() {
        return Some(("invalid_glob", "not a valid glob".into()));
    }
    let Some(spellings) = expand_braces(glob) else {
        return Some((
            "path_invalid",
            "`{}` groups are not nested and spell at most 64 paths".into(),
        ));
    };
    for spelled in &spellings {
        if spelled.contains('{') || spelled.contains('}') {
            return Some(("path_invalid", "an unbalanced `{}` group".into()));
        }
        if spelled.starts_with('/') {
            return Some(("path_absolute", "absolute paths are refused".into()));
        }
        for part in spelled.split('/') {
            if let Some(rule) = component_rule(part).or_else(|| git_wildcard_rule(part)) {
                return Some(rule);
            }
        }
        let literal = glob_literal(spelled);
        if !literal.is_empty() {
            if let Some(rule) = path_rule(literal) {
                return Some(rule);
            }
        }
        if rooted && !in_declared_roots(&format!("{literal}/")) {
            return Some((
                "path_outside_roots",
                "a glob starts with the declared root folder it selects from".into(),
            ));
        }
    }
    None
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

// What `check_files` read: each file's sha256, and its bytes for the risk derivation.
#[derive(Default)]
struct FileReads {
    hashes: BTreeMap<String, String>,
    bytes: BTreeMap<String, Vec<u8>>,
}

struct DiskFile {
    path: String,
    size: u64,
    exec: bool,
}

#[cfg(unix)]
fn mode_exec(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn mode_exec(_meta: &std::fs::Metadata) -> bool {
    false
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

// Regular files, relative to the root with `/`. Symlinks, `.git`, special files and
// anything the walk can't read are issues, not files; the walk stops at the entry cap.
fn scan_disk(root: &Path, limits: Limits, report: &mut PackReport) -> Vec<DiskFile> {
    let mut files: Vec<DiskFile> = Default::default();
    let mut walk = WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter();
    let mut entries = 0usize;
    while let Some(entry) = walk.next() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                let path = e.path().map(|p| relative_path(root, p)).unwrap_or_default();
                report.error(PackIssue::at("walk_error", path, "cannot be read"));
                continue;
            }
        };
        let path = relative_path(root, entry.path());
        if path.is_empty() {
            continue;
        }
        entries += 1;
        if entries > limits.max_entries {
            report.error(PackIssue::bare(
                "pack_too_many_files",
                format!(
                    "more than {} files and folders; the rest are not checked",
                    limits.max_entries
                ),
            ));
            break;
        }
        let kind = entry.file_type();
        if kind.is_symlink() {
            report.error(PackIssue::at("symlink", &path, "symlinks are refused"));
        } else if kind.is_dir() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name == ".git" || name == "git~1" {
                report.error(PackIssue::at(
                    "path_git",
                    &path,
                    "a `.git` folder is never part of a pack",
                ));
                walk.skip_current_dir();
            }
        } else if !kind.is_file() {
            report.error(PackIssue::at(
                "special_file",
                &path,
                "only regular files and folders belong in a pack",
            ));
        } else if path != "pack.yml" {
            match entry.metadata() {
                Ok(meta) => files.push(DiskFile {
                    path,
                    size: meta.len(),
                    exec: mode_exec(&meta),
                }),
                Err(_) => report.error(PackIssue::at("file_unreadable", &path, "cannot be read")),
            }
        }
    }
    files
}

fn third_party(path: &str) -> bool {
    let components: Vec<&str> = path.split('/').collect();
    let dir_hit = components[..components.len().saturating_sub(1)]
        .iter()
        .any(|c| THIRD_PARTY_DIRS.contains(&c.to_ascii_lowercase().as_str()));
    let name = components.last().copied().unwrap_or("");
    let stem = |separators: &[char]| {
        name.split(separators)
            .next()
            .unwrap_or("")
            .to_ascii_uppercase()
    };
    // `LICENSE-MIT` and `COPYING_GPL` are licenses too; `notice-board.md` is not a notice.
    let named = LICENSE_STEMS.contains(&stem(&['.']).as_str())
        || LICENSE_PREFIXES.contains(&stem(&['.', '-', '_']).as_str());
    // The pack's own LICENSE sits at the root; a nested one belongs to someone else's code.
    let foreign_license = components.len() > 1 && named;
    dir_hit || foreign_license
}

// The `license:` of a SKILL.md frontmatter, if it has one.
fn skill_license(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head);
    let body = text.strip_prefix("---")?;
    let end = body.find("\n---")?;
    body[..end].lines().find_map(|line| {
        let value = line.strip_prefix("license:")?;
        Some(value.trim().trim_matches(['"', '\'']).to_string())
    })
}

// `pack.yml`: a regular file inside the pack, under the manifest cap.
fn read_manifest(root: &Path, report: &mut PackReport) -> Option<String> {
    let path = root.join("pack.yml");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) => {
            report.error(PackIssue::at(
                "manifest_missing",
                "pack.yml",
                format!("cannot read pack.yml: {}", e.kind()),
            ));
            return None;
        }
    };
    if meta.file_type().is_symlink() {
        report.error(PackIssue::at("symlink", "pack.yml", "symlinks are refused"));
        return None;
    }
    if meta.is_file() && meta.len() > MAX_MANIFEST_BYTES {
        report.error(PackIssue::at(
            "manifest_too_large",
            "pack.yml",
            format!("pack.yml is over the {MAX_MANIFEST_BYTES} byte cap"),
        ));
        return None;
    }
    let bytes = match read_regular(&path, MAX_MANIFEST_BYTES) {
        Ok(bytes) => bytes,
        Err(why) => {
            report.error(PackIssue::at(
                "manifest_invalid",
                "pack.yml",
                format!("pack.yml {why}"),
            ));
            return None;
        }
    };
    match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(_) => {
            report.error(PackIssue::at(
                "manifest_invalid",
                "pack.yml",
                "pack.yml is not UTF-8",
            ));
            None
        }
    }
}

// Keys the model doesn't know, by their path in `pack.yml`. A typo such as `neds:` would
// otherwise parse and quietly skip a rule.
fn unknown_keys(
    schema: &serde_json::Value,
    node: &serde_json::Value,
    at: &str,
    out: &mut Vec<String>,
) {
    use serde_json::Value;
    let schema = match schema.get("$ref").and_then(Value::as_str) {
        Some(reference) => {
            let name = reference.rsplit('/').next().unwrap_or_default();
            &MANIFEST_SCHEMA["$defs"][name]
        }
        None => schema,
    };
    if let Some(choices) = schema.get("anyOf").and_then(Value::as_array) {
        for choice in choices {
            if choice.get("type").and_then(Value::as_str) != Some("null") {
                unknown_keys(choice, node, at, out);
            }
        }
        return;
    }
    if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
        let kind = node.get("kind");
        if let Some(branch) = branches
            .iter()
            .find(|b| b["properties"]["kind"].get("const") == kind)
        {
            unknown_keys(branch, node, at, out);
        }
        return;
    }
    let join = |key: &str| {
        if at.is_empty() {
            key.to_string()
        } else {
            format!("{at}/{key}")
        }
    };
    match node {
        Value::Object(map) => {
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for (key, value) in map {
                    match properties.get(key) {
                        Some(property) => unknown_keys(property, value, &join(key), out),
                        None if at.is_empty() && key == "risk" => {}
                        None => out.push(join(key)),
                    }
                }
            } else if let Some(values) =
                schema.get("additionalProperties").filter(|v| v.is_object())
            {
                for (key, value) in map {
                    unknown_keys(values, value, &join(key), out);
                }
            }
        }
        Value::Array(items) => {
            if let Some(item) = schema.get("items") {
                for (i, value) in items.iter().enumerate() {
                    unknown_keys(item, value, &join(&i.to_string()), out);
                }
            }
        }
        _ => {}
    }
}

// The unknown keys of a parsed `pack.yml`; `None` when a mapping key is not a string, which
// JSON can't hold, so the check can't run and the file is refused rather than passed.
pub(super) fn unknown_manifest_keys(raw: &serde_yaml::Value) -> Option<Vec<String>> {
    let json = serde_json::to_value(raw).ok()?;
    let mut unknown: Vec<String> = Default::default();
    unknown_keys(&MANIFEST_SCHEMA, &json, "", &mut unknown);
    Some(unknown)
}

// `pack_format` and `requires.codesense`, read from the raw document. `false` when this app
// can't read the pack: it is refused by name, not as a parse error on a field it doesn't know.
fn check_version_gates(raw: &serde_yaml::Value, report: &mut PackReport) -> bool {
    let format = raw.get("pack_format").and_then(|f| f.as_u64());
    if format.is_some_and(|f| f != u64::from(PACK_FORMAT)) {
        report.error(PackIssue::at(
            "unsupported_format",
            "pack.yml",
            format!(
                "pack_format {} is not supported (expected {PACK_FORMAT})",
                format.unwrap_or_default()
            ),
        ));
        return false;
    }
    let range = raw
        .get("requires")
        .and_then(|r| r.get("codesense"))
        .and_then(|c| c.as_str());
    let Some(range) = range else {
        return true;
    };
    let app = env!("CARGO_PKG_VERSION");
    match version_satisfies(range, app) {
        None => report.error(PackIssue::at(
            "requires_invalid",
            "pack.yml",
            format!("requires.codesense {range:?} is not a version range of full x.y.z versions"),
        )),
        Some(false) => {
            report.error(PackIssue::at(
                "requires_newer_codesense",
                "pack.yml",
                format!("this pack needs CodeSense {range}; this is {app}"),
            ));
            return false;
        }
        Some(true) => {}
    }
    true
}

pub fn validate_dir(root: &Path) -> PackReport {
    validate_dir_with(root, Limits::default())
}

pub fn validate_dir_with(root: &Path, limits: Limits) -> PackReport {
    let mut report = PackReport::empty();
    let Some(text) = read_manifest(root, &mut report) else {
        return report.finish();
    };
    let raw: serde_yaml::Value = match serde_yaml::from_str(&text) {
        Ok(raw) => raw,
        Err(e) => {
            report.error(PackIssue::at(
                "manifest_invalid",
                "pack.yml",
                format!("not valid YAML: {}", clip(&e.to_string())),
            ));
            return report.finish();
        }
    };
    // A newer pack is named before the typed parse, which would only say it can't read it.
    if !check_version_gates(&raw, &mut report) {
        return report.finish();
    }
    if raw.get("risk").is_some() {
        report.warnings.push(PackIssue::at(
            "risk_claim_ignored",
            "pack.yml",
            "a pack's own risk claim is ignored; risk facts are derived from its files",
        ));
    }
    let Some(unknown) = unknown_manifest_keys(&raw) else {
        report.error(PackIssue::at(
            "manifest_invalid",
            "pack.yml",
            "a mapping key is not a string",
        ));
        return report.finish();
    };
    for key in unknown {
        report.error(PackIssue::at(
            "unknown_key",
            "pack.yml",
            format!("{key}: not a pack.yml field"),
        ));
    }
    let manifest: PackManifest = match serde_yaml::from_value(raw) {
        Ok(manifest) => manifest,
        Err(e) => {
            report.error(PackIssue::at(
                "manifest_invalid",
                "pack.yml",
                clip(&e.to_string()),
            ));
            return report.finish();
        }
    };

    check_identity(&manifest, &mut report);
    let disk = scan_disk(root, limits, &mut report);
    let reads = check_files(root, &manifest, &disk, limits, &mut report);
    check_parts(&manifest, &mut report);
    check_part_files(&manifest, &disk, &reads.hashes, &mut report);

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
    let (facts, invalid_agents) = risk::derive(root, &manifest, &paths, reads.bytes);
    report.risk = facts;
    for path in invalid_agents {
        report.error(PackIssue::at(
            "agent_invalid",
            path,
            "does not parse as an agent definition, so its permissions can't be checked",
        ));
    }
    report.finish()
}

fn parse_version(text: &str) -> Option<[u64; 3]> {
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        *slot = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// Whether `version` meets `range`: comparators (`>=1.2.0 <2.0.0`), each a full x.y.z.
/// `None` when the range doesn't parse.
pub fn version_satisfies(range: &str, version: &str) -> Option<bool> {
    let have = parse_version(version)?;
    let mut any = false;
    for comparator in range.split([' ', ',']).filter(|c| !c.is_empty()) {
        any = true;
        let (op, rest) = ["<=", ">=", "<", ">", "="]
            .iter()
            .find_map(|op| comparator.strip_prefix(*op).map(|rest| (*op, rest)))
            .unwrap_or(("=", comparator));
        let want = parse_version(rest)?;
        let met = match op {
            "<=" => have <= want,
            ">=" => have >= want,
            "<" => have < want,
            ">" => have > want,
            _ => have == want,
        };
        if !met {
            return Some(false);
        }
    }
    any.then_some(true)
}

fn check_identity(manifest: &PackManifest, report: &mut PackReport) {
    if !NAME.is_match(&manifest.id) {
        report.error(PackIssue::at("invalid_id", "pack.yml", "id is [a-z0-9-]"));
    }
    if !SEMVER.is_match(&manifest.version) {
        report.error(PackIssue::at(
            "invalid_version",
            "pack.yml",
            format!("version {} is not semver", manifest.version),
        ));
    }
}

// `files` against the disk: every file listed, hashed, in a declared root, and the caps.
// Returns each regular file's sha256 and bytes, read once; nothing is read for a pack over
// the cap, which is refused anyway.
fn check_files(
    root: &Path,
    manifest: &PackManifest,
    disk: &[DiskFile],
    limits: Limits,
    report: &mut PackReport,
) -> FileReads {
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
    }
    let over_pack = total > limits.max_pack;
    if over_pack {
        report.error(PackIssue::bare(
            "pack_too_large",
            format!(
                "{total} bytes is over the {} byte pack cap",
                limits.max_pack
            ),
        ));
    }

    // Each regular file under the caps is read once, with no symlink followed.
    let own_license = manifest.license.to_ascii_lowercase();
    let mut reads: FileReads = Default::default();
    for file in disk {
        if over_pack || file.size > limits.max_file || path_rule(&file.path).is_some() {
            continue;
        }
        match read_regular(&root.join(&file.path), limits.max_file) {
            Ok(bytes) => {
                if file.path.ends_with("/SKILL.md")
                    && skill_license(&bytes)
                        .is_some_and(|license| license.to_ascii_lowercase() != own_license)
                {
                    report.error(third_party_issue(&file.path));
                }
                let hash = format!("{:x}", Sha256::digest(&bytes));
                reads.hashes.insert(file.path.clone(), hash);
                reads.bytes.insert(file.path.clone(), bytes);
            }
            Err(why) => report.error(PackIssue::at("file_unreadable", &file.path, why)),
        }
    }

    let on_disk: BTreeMap<&str, &DiskFile> = disk.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut listed: BTreeSet<&str> = Default::default();
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
        let Some(file) = on_disk.get(path) else {
            report.error(PackIssue::at(
                "file_missing",
                path,
                "listed in files but not in the pack",
            ));
            continue;
        };
        if let Some(actual) = reads.hashes.get(path) {
            if *actual != entry.sha256 {
                report.error(PackIssue::at(
                    "hash_mismatch",
                    path,
                    "the file's sha256 differs from the one in files",
                ));
            }
        }
        if file.exec != entry.exec {
            report.error(PackIssue::at(
                "exec_mismatch",
                path,
                format!(
                    "files says exec: {}, but the file's mode says {}",
                    entry.exec, file.exec
                ),
            ));
        }
    }
    for file in disk {
        if !listed.contains(file.path.as_str()) {
            report.error(PackIssue::at(
                "file_unlisted",
                &file.path,
                "in the pack but not listed in files",
            ));
        }
    }

    let every: BTreeSet<&str> = disk
        .iter()
        .map(|f| f.path.as_str())
        .chain(manifest.files.iter().map(|f| f.path.as_str()))
        .collect();
    for path in every {
        if let Some((code, message)) = path_rule(path) {
            report.error(PackIssue::at(code, path, message));
            continue;
        }
        if !in_declared_roots(path) {
            report.error(PackIssue::at(
                "path_outside_roots",
                path,
                "not under a declared root (content, panes, seed, agents, routines, roles, docs, media, commands, setup)",
            ));
        }
        if third_party(path) {
            report.error(third_party_issue(path));
        }
    }
    reads
}

fn third_party_issue(path: &str) -> PackIssue {
    PackIssue::at(
        "third_party_bundled",
        path,
        "a bundled file must be the publisher's own work under the pack license; reference third-party code as an external part",
    )
}

// Part paths follow the same rules as files; the graph has no unknown id or cycle.
fn check_parts(manifest: &PackManifest, report: &mut PackReport) {
    if manifest.parts.len() > MAX_PARTS {
        report.error(PackIssue::bare(
            "too_many_parts",
            format!(
                "{} parts is over the {MAX_PARTS} part cap",
                manifest.parts.len()
            ),
        ));
        return;
    }
    let mut ids: BTreeSet<&str> = Default::default();
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
    let clis = manifest
        .requires
        .as_ref()
        .map(|r| r.clis.as_slice())
        .unwrap_or_default();
    for cli in clis {
        for target in &cli.for_parts {
            if !ids.contains(target.as_str()) {
                report.error(PackIssue::at(
                    "unknown_part",
                    format!("requires/clis/{}/for", cli.name),
                    format!("{target} is not a part of this pack"),
                ));
            }
        }
    }
    let defaults = manifest
        .parts
        .iter()
        .filter(|p| matches!(p, Part::Preset { default: true, .. }))
        .count();
    if defaults > 1 {
        report.error(PackIssue::at(
            "preset_default_duplicate",
            "pack.yml",
            "at most one preset is the default",
        ));
    }
    let mut built: BTreeMap<String, &str> = Default::default();
    for part in &manifest.parts {
        if let Part::Skill { targets, name, .. } = part {
            let name = name.as_deref().unwrap_or(part.id());
            for target in targets {
                let path = target.built_path(name);
                if let Some(other) = built.insert(path.clone(), part.id()) {
                    if other != part.id() {
                        report.error(PackIssue::at(
                            "skill_name_duplicate",
                            path,
                            format!(
                                "parts/{other} and parts/{} build to the same place",
                                part.id()
                            ),
                        ));
                    }
                }
            }
        }
        check_part(part, report);
    }
    for glob in &manifest.setup_steps {
        if let Some((code, message)) = glob_rule(glob, true) {
            report.error(PackIssue::at(code, glob, format!("setup_steps: {message}")));
        }
    }
}

// Depth-first search with an explicit stack, so a long chain can't overflow the thread's
// stack; returns a part that sits on a cycle.
fn find_cycle<'a>(edges: &BTreeMap<&'a str, Vec<&'a str>>) -> Option<&'a str> {
    let mut done: BTreeSet<&str> = Default::default();
    let mut active: BTreeSet<&str> = Default::default();
    for &start in edges.keys() {
        if done.contains(start) {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(start, 0)];
        active.insert(start);
        while let Some(top) = stack.last_mut() {
            let (node, next) = *top;
            let successors = edges.get(node).map(Vec::as_slice).unwrap_or_default();
            if let Some(&succ) = successors.get(next) {
                top.1 += 1;
                if active.contains(succ) {
                    return Some(succ);
                }
                if !done.contains(succ) {
                    active.insert(succ);
                    stack.push((succ, 0));
                }
            } else {
                active.remove(node);
                done.insert(node);
                stack.pop();
            }
        }
    }
    None
}

// A path a part names, held to the same rules as a file.
fn part_path(report: &mut PackReport, id: &str, field: &str, value: &str) {
    if let Some((code, message)) = path_rule(value) {
        report.error(PackIssue::at(
            code,
            value,
            format!("parts/{id}/{field}: {message}"),
        ));
    }
}

// A glob a part names, every segment held to the path rules.
fn part_glob(report: &mut PackReport, id: &str, field: &str, value: &str, rooted: bool) {
    if let Some((code, message)) = glob_rule(value, rooted) {
        report.error(PackIssue::at(
            code,
            value,
            format!("parts/{id}/{field}: {message}"),
        ));
    }
}

// A working folder: `.` is the team folder itself, anything else follows the path rules.
fn part_cwd(report: &mut PackReport, id: &str, field: &str, cwd: Option<&str>) {
    if let Some(cwd) = cwd.filter(|c| *c != ".") {
        part_path(report, id, field, cwd);
    }
}

fn unpinned(report: &mut PackReport, id: &str, message: &str) {
    report.error(PackIssue::at(
        "external_unpinned",
        format!("parts/{id}"),
        message,
    ));
}

fn bad_source(report: &mut PackReport, id: &str, message: &str) {
    report.error(PackIssue::at(
        "external_source_invalid",
        format!("parts/{id}"),
        message,
    ));
}

// A registry integrity: the algorithm and a base64 digest of that algorithm's length.
fn integrity_ok(integrity: &str) -> bool {
    let Some(found) = INTEGRITY.captures(integrity) else {
        return false;
    };
    let wanted = match &found[1] {
        "sha256" => 44,
        "sha384" => 64,
        _ => 88,
    };
    found[2].len() == wanted
}

fn check_part(part: &Part, report: &mut PackReport) {
    let id = part.id();
    match part {
        Part::Preset { .. } => {}
        Part::Agent { file, .. } | Part::Routine { file, .. } => {
            part_path(report, id, "file", file)
        }
        Part::Content { paths, .. } | Part::Dashboards { paths, .. } => {
            for p in paths {
                part_glob(report, id, "paths", p, true);
            }
        }
        Part::Skill {
            source,
            name,
            targets,
            ..
        } => {
            part_path(report, id, "source", source);
            if !NAME.is_match(name.as_deref().unwrap_or(id)) {
                report.error(PackIssue::at(
                    "invalid_skill_name",
                    format!("parts/{id}"),
                    "a skill name is [a-z0-9-]",
                ));
            }
            if targets.is_empty() {
                report.error(PackIssue::at(
                    "skill_targets_empty",
                    format!("parts/{id}"),
                    "a skill part names at least one target runtime",
                ));
            }
        }
        Part::Seed { from, to, .. } => {
            part_path(report, id, "from", from);
            part_path(report, id, "to", to);
            if to
                .split('/')
                .next()
                .is_some_and(|first| first.eq_ignore_ascii_case("config"))
            {
                report.error(PackIssue::at(
                    "path_config",
                    to,
                    format!("parts/{id}/to: a seed never lands in the team's config/"),
                ));
            }
        }
        Part::Setup { command, cwd, .. } => {
            if command.trim().is_empty() {
                report.error(PackIssue::at(
                    "setup_command_empty",
                    format!("parts/{id}"),
                    "a setup step names the exact upstream command",
                ));
            }
            part_cwd(report, id, "cwd", cwd.as_deref());
        }
        Part::External {
            method,
            source,
            version,
            commit,
            integrity,
            tree_sha256,
            paths,
            setup,
            ..
        } => {
            if !SEMVER.is_match(version) {
                unpinned(report, id, "an external part pins an exact version (x.y.z)");
            }
            match (source.git.as_deref(), source.npm.as_deref()) {
                (Some(git), None) => {
                    if !FORGE_URL.is_match(git) {
                        bad_source(report, id, "a git source is an https:// forge URL");
                    }
                    if !commit.as_deref().is_some_and(|c| is_hex(c, 40)) {
                        unpinned(report, id, "a git source pins a full 40-hex commit");
                    }
                }
                (None, Some(npm)) => {
                    if npm.len() > 214 || !NPM_NAME.is_match(npm) {
                        bad_source(report, id, "an npm source is a registry package name");
                    }
                    if !integrity.as_deref().is_some_and(integrity_ok) {
                        unpinned(
                            report,
                            id,
                            "an npm source pins the registry integrity (sha512-<base64 digest>)",
                        );
                    }
                }
                _ => bad_source(
                    report,
                    id,
                    "an external part names exactly one source: npm or git",
                ),
            }
            for upstream in paths.keys() {
                part_glob(report, id, "paths", upstream, false);
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
                    if !tree_sha256.as_deref().is_some_and(|t| is_hex(t, 64)) {
                        unpinned(
                            report,
                            id,
                            "method files pins tree_sha256, the 64-hex hash of the mapped files",
                        );
                    }
                    for destinations in paths.values() {
                        for dest in destinations {
                            part_path(report, id, "paths", dest);
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
            if let Some(setup) = setup {
                part_cwd(report, id, "setup/cwd", setup.cwd.as_deref());
                if let Some(verify) = &setup.verify {
                    part_path(report, id, "setup/verify/read", &verify.read);
                }
            }
        }
    }
}

fn hold(report: &mut PackReport, present: &BTreeSet<&str>, id: &str, path: &str) {
    if path_rule(path).is_none() && !present.contains(path) {
        report.error(PackIssue::at(
            "part_file_missing",
            path,
            format!("parts/{id} points at a file the pack does not hold"),
        ));
    }
}

// What a part points at in the pack must be listed, and a skill's built copies too, each
// the same bytes as its source.
fn check_part_files(
    manifest: &PackManifest,
    disk: &[DiskFile],
    hashes: &BTreeMap<String, String>,
    report: &mut PackReport,
) {
    let present: BTreeSet<&str> = disk.iter().map(|f| f.path.as_str()).collect();
    for part in &manifest.parts {
        let id = part.id();
        match part {
            Part::Agent { file, .. } | Part::Routine { file, .. } => {
                hold(report, &present, id, file)
            }
            Part::Seed { from, .. } => hold(report, &present, id, from),
            Part::Skill {
                source,
                targets,
                name,
                ..
            } => {
                hold(report, &present, id, source);
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
                    } else if let (Some(copy), Some(original)) =
                        (hashes.get(&built), hashes.get(source))
                    {
                        if copy != original {
                            report.error(PackIssue::at(
                                "skill_copy_drift",
                                built,
                                format!("parts/{id}: the built copy differs from {source}"),
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }
}
