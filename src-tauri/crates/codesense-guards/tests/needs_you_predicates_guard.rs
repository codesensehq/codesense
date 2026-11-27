// SPDX-License-Identifier: MIT
//! Durable guards for the one needs-you set and the one work item mint site.
//!
//! 1. **One needs-you set.** What waits on the person is derived once, in
//!    `live_hub/needs_you.rs`, and every surface reads that set. Production code
//!    elsewhere that still says a needs-you or permission predicate ([`line_hits`])
//!    is in `needs_you_predicates_allowlist.txt` with its exact hit count, so a new
//!    file fails, a new predicate in a listed file fails, and a stale entry fails.
//!    The list only shrinks: a surface that moves onto the set drops its entry.
//!    This file checks the Rust entries; the frontend guard
//!    (`src/shared/lib/needs-you-predicates.guard.test.ts`) checks the rest.
//! 2. **The list stays under its release ceiling.** `tests/fixtures/allowlist-ceilings.json`
//!    holds the release in progress (`current`) and a ceiling per release; the
//!    whole list (Rust and frontend entries) may not be longer than the ceiling
//!    for `current`.
//! 3. **One mint site.** `WorkItemId::mint` is private to `work_item.rs` and called
//!    once there, by `resolve_for_launch`; no other production code builds a
//!    `WorkItemId` or writes a `wi_` id by hand.
//!
//! Test code is exempt: `#[cfg(test)]` items and `*_tests.rs` / `tests.rs` /
//! `tests/` files. Std-only; point `CODESENSE_GUARD_ROOT` at another checkout's
//! `src-tauri` to run it against that tree.

use codesense_guards::guard_support;
use codesense_guards::guard_support::{app_root as root, read};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const ALLOWLIST: &str = "tests/needs_you_predicates_allowlist.txt";
const CEILINGS: &str = "tests/fixtures/allowlist-ceilings.json";
/// The ceiling key for this list in [`CEILINGS`].
const LIST: &str = "needsYouPredicates";
/// The owner module: the set is derived here, so it is never listed.
const OWNER: &str = "src-tauri/src/live_hub/needs_you.rs";

/// Literal text that compares or names a needs-you or permission state.
const LITERALS: &[&str] = &[
    "\"needs-permission\"",
    "'needs-permission'",
    "\"needs-you\"",
    "'needs-you'",
    "\"needs_you\"",
    "'needs_you'",
    "=== \"needs\"",
    "!== \"needs\"",
];
/// Identifiers that are a needs-you or permission predicate or its input.
const IDENTS: &[&str] = &[
    "needsYouKind",
    "needs_you_kind",
    "NeedsPermission",
    "needsYouBySender",
    "needsMailBySender",
    "needsBySender",
    "ASK_USER_STATE",
    "kindOf",
];
/// A function or hook named for what needs you (`isNeedsYouStatus`, `selectNeedsYouKind`).
const PREFIXES: &[&str] = &["is", "has", "select", "get", "count", "use"];

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn predicate_ident(token: &str) -> bool {
    IDENTS.contains(&token)
        || (token.contains("NeedsYou")
            && PREFIXES.iter().any(|prefix| {
                token
                    .strip_prefix(prefix)
                    .and_then(|rest| rest.chars().next())
                    .is_some_and(|c| c.is_ascii_uppercase())
            }))
}

/// Whether a line says a needs-you or permission predicate.
fn line_hits(line: &str) -> bool {
    LITERALS.iter().any(|literal| line.contains(literal))
        || line
            .split(|c: char| !is_ident(c))
            .any(|token| !token.is_empty() && predicate_ident(token))
}

/// Per line: is it inside a `#[cfg(test)]` item? The item after the attribute
/// runs to its matching close brace (or a `;` before any brace). Braces inside
/// string, raw-string and char literals and comments are skipped.
fn rust_test_lines(src: &str) -> Vec<bool> {
    let lines: Vec<&str> = src.lines().collect();
    let mut in_test = vec![false; lines.len()];
    let mut offsets = Vec::with_capacity(lines.len());
    let mut acc = 0usize;
    for l in &lines {
        offsets.push(acc);
        acc += l.len() + 1;
    }
    let line_of = |byte: usize| offsets.partition_point(|&o| o <= byte) - 1;
    let bytes = src.as_bytes();
    let mut search = 0usize;
    while let Some(found) = src[search..].find("#[cfg(test)]") {
        let attr = search + found;
        let mut i = attr + "#[cfg(test)]".len();
        let mut depth = 0usize;
        let mut end = None;
        while i < bytes.len() {
            match bytes[i] {
                b'/' if bytes.get(i + 1) == Some(&b'/') => {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                b'r' if bytes.get(i + 1) == Some(&b'#') || bytes.get(i + 1) == Some(&b'"') => {
                    let mut j = i + 1;
                    let mut hashes = 0;
                    while bytes.get(j) == Some(&b'#') {
                        hashes += 1;
                        j += 1;
                    }
                    if bytes.get(j) == Some(&b'"') && (i == 0 || !is_ident(bytes[i - 1] as char)) {
                        let close = format!("\"{}", "#".repeat(hashes));
                        i = j + 1 + src[j + 1..].find(&close).map_or(0, |k| k + close.len());
                        continue;
                    }
                }
                b'"' => {
                    i += 1;
                    while i < bytes.len() && bytes[i] != b'"' {
                        if bytes[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                }
                b'\'' if bytes.get(i + 2) == Some(&b'\'') || bytes.get(i + 1) == Some(&b'\\') => {
                    i += if bytes.get(i + 1) == Some(&b'\\') {
                        4
                    } else {
                        3
                    };
                    continue;
                }
                b'{' => depth += 1,
                b'}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                b';' if depth == 0 => {
                    end = Some(i);
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        let end = end.unwrap_or(bytes.len() - 1);
        for flag in &mut in_test[line_of(attr)..=line_of(end)] {
            *flag = true;
        }
        search = end + 1;
    }
    in_test
}

fn is_test_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.ends_with("_tests.rs") || name == "tests.rs" || rel.contains("/tests/")
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `src-tauri/<root>/<path>` → production source, for every Rust file that is not test code.
fn production_sources() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for base in guard_support::source_roots() {
        let label = format!("src-tauri/{}", base.strip_prefix(root()).unwrap().display())
            .replace('\\', "/");
        let mut files = Vec::new();
        sources(&base, &mut files);
        for file in files {
            let rel = file
                .strip_prefix(&base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let key = format!("{label}/{rel}");
            if is_test_file(&key) {
                continue;
            }
            let text = fs::read_to_string(&file).unwrap_or_default();
            let test_lines = rust_test_lines(&text);
            let production: Vec<&str> = text
                .lines()
                .enumerate()
                .map(|(n, line)| {
                    if test_lines.get(n).copied().unwrap_or(false) {
                        ""
                    } else {
                        line
                    }
                })
                .collect();
            out.insert(key, production.join("\n"));
        }
    }
    out
}

/// `path → hit count` for every Rust file outside the owner whose production code says
/// a needs-you or permission predicate.
fn hits() -> BTreeMap<String, usize> {
    production_sources()
        .into_iter()
        .filter(|(path, _)| path != OWNER)
        .filter_map(|(path, text)| {
            let count = text.lines().filter(|line| line_hits(line)).count();
            (count > 0).then_some((path, count))
        })
        .collect()
}

/// `path → pinned hit count`, for every entry of the allow-list (Rust and frontend).
/// Lines are `<path> <count> # note`.
fn allowlist() -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for (n, raw) in read(ALLOWLIST).lines().enumerate() {
        let line = raw.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let path = parts.next().unwrap().to_string();
        let count: usize = parts
            .next()
            .and_then(|c| c.parse().ok())
            .unwrap_or_else(|| panic!("{ALLOWLIST}:{}: `{path}` has no hit count", n + 1));
        assert!(
            out.insert(path.clone(), count).is_none(),
            "{ALLOWLIST}:{}: `{path}` is listed twice",
            n + 1
        );
    }
    out
}

/// Production Rust says a needs-you or permission predicate only in the owner and the
/// allow-listed files, exactly as often as pinned, and the list has no stale Rust entry.
#[test]
fn needs_you_predicates_stay_in_the_owner_and_the_allowlist() {
    let hits = hits();
    let allowed = allowlist();
    let mut problems = Vec::new();
    for (path, count) in &hits {
        match allowed.get(path) {
            None => problems.push(format!(
                "{path}: {count} lines, not allow-listed; read the needs-you set instead"
            )),
            Some(pinned) if pinned != count => {
                problems.push(format!("{path}: {count} lines, allow-list pins {pinned}"))
            }
            Some(_) => {}
        }
    }
    for path in allowed
        .keys()
        .filter(|p| p.ends_with(".rs") && !hits.contains_key(*p))
    {
        problems.push(format!(
            "{path}: allow-listed but says no predicate now; drop it"
        ));
    }
    assert!(
        problems.is_empty(),
        "needs-you is derived once, in {OWNER}; production code outside it and the \
         allow-list ({ALLOWLIST}) says a needs-you or permission predicate:\n{}",
        problems.join("\n")
    );
}

/// The value of `"key": <value>` in `json`, unquoted, from the first match after `from`.
fn json_value<'a>(json: &'a str, key: &str, from: usize) -> Option<&'a str> {
    let at = from + json[from..].find(&format!("\"{key}\""))?;
    let rest = json[at + key.len() + 2..].trim_start().strip_prefix(':')?;
    let rest = rest.trim_start();
    let end = rest.find([',', '}', '\n']).unwrap_or(rest.len());
    Some(rest[..end].trim().trim_matches('"'))
}

/// Whether a list of `count` entries is within the ceiling for `current` in `json`.
/// `json` holds `"ceilings": { "<list>": { "<release>": <n>, … } }`.
fn check_ceiling(json: &str, list: &str, current: &str, count: usize) -> Result<(), String> {
    let ceilings = json
        .find("\"ceilings\"")
        .ok_or("the ceilings file has no `ceilings`")?;
    let list_at = ceilings
        + json[ceilings..]
            .find(&format!("\"{list}\""))
            .ok_or_else(|| format!("the ceilings file has no `{list}`"))?;
    let block_end = list_at + json[list_at..].find('}').unwrap_or(json.len() - list_at);
    let ceiling: usize = json_value(&json[..block_end], current, list_at)
        .ok_or_else(|| format!("`{list}` has no ceiling for release `{current}`"))?
        .parse()
        .map_err(|_| format!("`{list}`'s ceiling for `{current}` is not a number"))?;
    if count > ceiling {
        Err(format!(
            "`{list}` has {count} entries, above release {current}'s ceiling of {ceiling}"
        ))
    } else {
        Ok(())
    }
}

fn ceilings_file() -> String {
    let path = root().join("..").join(CEILINGS);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The allow-list (Rust and frontend entries) is no longer than the ceiling for the
/// release in progress.
#[test]
fn the_allowlist_stays_within_the_ceiling_for_the_current_release() {
    let json = ceilings_file();
    let current = json_value(&json, "current", 0).expect("the ceilings file names `current`");
    if let Err(problem) = check_ceiling(&json, LIST, current, allowlist().len()) {
        panic!("{problem}: move a surface onto the needs-you set instead of adding to {ALLOWLIST}");
    }
}

/// The ceiling check itself, with `current` injected: above the ceiling fails, at or
/// below passes, and a release with no ceiling fails.
#[test]
fn the_ceiling_check_follows_the_release_it_is_given() {
    let json = r#"{
  "current": "R1",
  "ceilings": {
    "needsYouPredicates": { "R0": 3, "R1": 2, "R2": 0 },
    "other": { "R0": 9 }
  }
}"#;
    assert_eq!(json_value(json, "current", 0), Some("R1"));
    assert!(check_ceiling(json, LIST, "R0", 3).is_ok(), "at the ceiling");
    assert!(check_ceiling(json, LIST, "R0", 4).is_err(), "above it");
    assert!(check_ceiling(json, LIST, "R1", 2).is_ok());
    assert!(check_ceiling(json, LIST, "R1", 3).is_err());
    assert!(check_ceiling(json, LIST, "R2", 0).is_ok());
    assert!(check_ceiling(json, LIST, "R2", 1).is_err());
    assert!(
        check_ceiling(json, LIST, "R9", 0).is_err(),
        "no ceiling for that release"
    );
    assert!(
        check_ceiling(json, "missing", "R0", 0).is_err(),
        "no such list"
    );
    assert!(
        check_ceiling(json, "other", "R1", 0).is_err(),
        "another list's ceilings are its own"
    );
}

/// `WorkItemId::mint` is private, called once in `work_item.rs`, and nothing else builds
/// a `WorkItemId` or a `wi_` id.
#[test]
fn work_item_ids_are_minted_in_one_place() {
    let code = |text: &str| -> Vec<(usize, String)> {
        text.lines()
            .enumerate()
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
            .map(|(n, line)| (n, line.to_string()))
            .collect()
    };
    let sources = production_sources();
    let owner = "src-tauri/src/work_item.rs";
    let work_item = code(sources.get(owner).expect("work_item.rs exists"));
    let decl: Vec<&str> = work_item
        .iter()
        .map(|(_, line)| line.trim())
        .filter(|line| line.contains("fn mint("))
        .collect();
    assert_eq!(
        decl,
        ["fn mint() -> Self {"],
        "mint stays private to {owner}"
    );
    assert_eq!(
        work_item
            .iter()
            .map(|(_, line)| line.matches("WorkItemId::mint").count())
            .sum::<usize>(),
        1,
        "{owner} calls mint once, in resolve_for_launch"
    );
    let mut problems = Vec::new();
    for (path, text) in sources.iter().filter(|(path, _)| *path != owner) {
        for (n, line) in code(text) {
            if line.contains("WorkItemId::mint")
                || line.contains("WorkItemId(")
                || line.contains("\"wi_")
            {
                problems.push(format!("{path}:{}: {}", n + 1, line.trim()));
            }
        }
    }
    assert!(
        problems.is_empty(),
        "work item ids are minted only by work_item::resolve_for_launch:\n{}",
        problems.join("\n")
    );
}

/// The scanner's own behavior: test regions are exempt, identifiers match whole, and a
/// planted production hit is found.
#[test]
fn scanner_self_test() {
    let src = "fn prod() { matches!(s, AgentState::NeedsPermission) }\n#[cfg(test)]\nmod tests {\n    fn t() { let s = \"}\"; AgentState::NeedsPermission; }\n}\nfn after() { let NeedsPermissionish = 1; }\n";
    let test_lines = rust_test_lines(src);
    let flagged: Vec<usize> = src
        .lines()
        .enumerate()
        .filter(|(n, l)| !test_lines[*n] && line_hits(l))
        .map(|(n, _)| n)
        .collect();
    assert_eq!(flagged, vec![0], "only the production line is flagged");
    assert!(line_hits("if (row.needsYouKind === null) return;"));
    assert!(line_hits("const waiting = selectNeedsYouKind(state);"));
    assert!(line_hits("if (state === \"needs\") return;"));
    assert!(line_hits("kind: \"needs-you\","));
    assert!(!line_hits("const needsYouHandlers = {};"));
    assert!(!line_hits("// what needs you"));
}
