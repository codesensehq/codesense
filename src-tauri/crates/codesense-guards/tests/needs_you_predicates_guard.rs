// SPDX-License-Identifier: MIT
//! Durable guards for the one needs-you set and the one work item mint site.
//!
//! 1. **One needs-you set.** What waits on the person is derived once, in
//!    `live_hub/needs_you.rs`, and every surface reads that set. Production code
//!    elsewhere that still says a needs-you or permission predicate ([`line_hits`], by
//!    the patterns in [`PATTERNS`]) is in `needs_you_predicates_allowlist.txt` with its
//!    exact hit count, so a new file fails, a new predicate in a listed file fails, and
//!    a stale entry fails. This file checks the Rust entries; the frontend guard
//!    (`src/shared/lib/needs-you-predicates.guard.test.ts`) checks the rest, from the
//!    same patterns.
//! 2. **The list matches its release ceilings.** `tests/fixtures/allowlist-ceilings.json`
//!    holds the release in progress (`current`) and, per release, a ceiling on the
//!    list's length and one on the sum of its pinned counts. Both must equal the
//!    ceilings for `current`, and no ceiling rises from one release to the next, so a
//!    removal is locked in by lowering them.
//! 3. **One mint site.** `WorkItemId::mint` is private to `work_item.rs` and named
//!    once there, in `resolve_for_launch`; only `mint` and `parse` build a `WorkItemId`,
//!    and no other production code builds one or writes a `wi_` id by hand.
//!
//! Test code is exempt: items under `#[cfg(test)]` or `#[cfg(all(test, …))]`, modules
//! and files under `#![cfg(test)]`, and the test files [`PATTERNS`] names. Std-only;
//! point `CODESENSE_GUARD_ROOT` at another checkout's `src-tauri` to run it against that
//! tree, which then supplies the patterns, the allow-list and the ceilings too.

use codesense_guards::guard_support;
use codesense_guards::guard_support::app_root as root;
use std::collections::BTreeMap;
use std::fs;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The allow-list, relative to the app root.
const ALLOWLIST: &str = "crates/codesense-guards/tests/needs_you_predicates_allowlist.txt";
/// The release ceilings, relative to the app root.
const CEILINGS: &str = "../tests/fixtures/allowlist-ceilings.json";
/// The predicate patterns and test-file rules both guards read, relative to the app root.
const PATTERNS: &str = "../tests/fixtures/needs-you-predicates.txt";
/// The ceiling keys in [`CEILINGS`]: the list's length, and the sum of its pinned counts.
const LIST: &str = "needsYouPredicates";
const LIST_HITS: &str = "needsYouPredicatesHits";
/// The owner module: the set is derived here, so it is never listed.
const OWNER: &str = "src-tauri/src/live_hub/needs_you.rs";

/// Read `relative` to the app root, so every input comes from the tree under test.
fn read_tree(relative: &str) -> String {
    let path = root().join(relative);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The rules in [`PATTERNS`], `<rule> <value>` per line, by rule.
struct Patterns(BTreeMap<String, Vec<String>>);

impl Patterns {
    fn parse(text: &str) -> Self {
        let mut rules = BTreeMap::<String, Vec<String>>::new();
        for line in text.lines() {
            if line.starts_with('#') || str::is_empty(str::trim(line)) {
                continue;
            }
            let (rule, value) = str::split_once(line, ' ').unwrap_or((line, ""));
            rules
                .entry(rule.to_string())
                .or_default()
                .push(value.to_string());
        }
        Patterns(rules)
    }

    fn get(&self, rule: &str) -> &[String] {
        self.0.get(rule).map_or(&[][..], Vec::as_slice)
    }
}

fn patterns() -> &'static Patterns {
    static PARSED: OnceLock<Patterns> = OnceLock::new();
    PARSED.get_or_init(|| Patterns::parse(&read_tree(PATTERNS)))
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `NeedsYou` → `needs_you`.
fn snake(stem: &str) -> String {
    let mut out = String::new();
    for (i, c) in stem.char_indices() {
        if i > 0 && c.is_ascii_uppercase() {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn predicate_ident(rules: &Patterns, token: &str) -> bool {
    rules.get("ident").iter().any(|ident| ident == token)
        || rules.get("prefix").iter().any(|prefix| {
            let Some(rest) = token.strip_prefix(prefix.as_str()) else {
                return false;
            };
            let stems = rules.get("stem");
            if rest.starts_with(|c: char| c.is_ascii_uppercase()) {
                stems.iter().any(|stem| rest.contains(stem.as_str()))
            } else if rest.starts_with('_') {
                stems
                    .iter()
                    .any(|stem| rest.contains(&format!("_{}", snake(stem))))
            } else {
                false
            }
        })
}

/// Whether a line says a needs-you or permission predicate, by the rules in `rules`.
fn hits_by(rules: &Patterns, line: &str) -> bool {
    let flat = line
        .split_whitespace()
        .collect::<String>()
        .replace('\'', "\"");
    let arm = flat.contains("=>")
        && rules.get("arm").iter().any(|state| {
            flat.contains(&format!("{state}|"))
                || flat.contains(&format!("|{state}"))
                || flat.contains(&format!("{state}=>"))
        });
    arm || rules
        .get("literal")
        .iter()
        .any(|literal| flat.contains(literal.as_str()))
        || line
            .split(|c: char| !is_ident(c))
            .any(|token| !str::is_empty(token) && predicate_ident(rules, token))
}

/// Whether a line says a needs-you or permission predicate.
fn line_hits(line: &str) -> bool {
    hits_by(patterns(), line)
}

/// The first `needle` in `hay` at or after `from`.
fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| from + at)
}

/// `src` with its comments and the insides of its string and char literals blanked to
/// spaces (newlines kept), so braces, `;` and attributes in it are code and byte
/// offsets still line up with `src`.
fn mask(src: &str) -> Vec<u8> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut out = bytes.to_vec();
    let mut blank = |from: usize, to: usize| {
        for byte in &mut out[from.min(n)..to.min(n)] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let ident = |at: usize| is_ident(bytes[at] as char);
    let mut i = 0;
    while i < n {
        let rest = &bytes[i..];
        if rest.starts_with(b"//") {
            let end = find(bytes, b"\n", i).unwrap_or(n);
            blank(i, end);
            i = end;
            continue;
        }
        if rest.starts_with(b"/*") {
            let (mut j, mut depth) = (i + 2, 1);
            while j < n && depth > 0 {
                if bytes[j..].starts_with(b"/*") {
                    depth += 1;
                    j += 2;
                } else if bytes[j..].starts_with(b"*/") {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(i, j);
            i = j;
            continue;
        }
        let raw_start = i == 0
            || !ident(i - 1)
            || (matches!(bytes[i - 1], b'b' | b'c') && (i < 2 || !ident(i - 2)));
        if bytes[i] == b'r' && raw_start {
            let mut j = i + 1;
            while bytes.get(j) == Some(&b'#') {
                j += 1;
            }
            if bytes.get(j) == Some(&b'"') {
                let mut close = vec![b'"'];
                close.resize(j - i, b'#');
                match find(bytes, &close, j + 1) {
                    Some(k) => {
                        blank(j + 1, k);
                        i = k + close.len();
                    }
                    None => {
                        blank(j + 1, n);
                        i = n;
                    }
                }
                continue;
            }
        }
        if bytes[i] == b'"' {
            let mut j = i + 1;
            while j < n && bytes[j] != b'"' {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            blank(i + 1, j);
            i = j + 1;
            continue;
        }
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\\') {
                if let Some(k) = find(&bytes[..n.min(i + 14)], b"'", i + 2) {
                    blank(i + 1, k);
                    i = k + 1;
                    continue;
                }
            } else if let Some(c) = src.get(i + 1..).and_then(|s| s.chars().next()) {
                let len = c.len_utf8();
                if bytes.get(i + 1 + len) == Some(&b'\'') {
                    blank(i + 1, i + 1 + len);
                    i += 2 + len;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// Whether an attribute's text (between `[` and `]`) gates on test builds:
/// `cfg(test)`, or `cfg(all(…))` with `test` among its terms.
fn is_test_cfg(attr: &str) -> bool {
    let flat: String = attr.split_whitespace().collect();
    if flat == "cfg(test)" {
        return true;
    }
    let Some(body) = flat
        .strip_prefix("cfg(all(")
        .and_then(|rest| rest.strip_suffix("))"))
    else {
        return false;
    };
    let mut depth = 0i32;
    let mut terms = vec![String::new()];
    for c in body.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if c == ',' && depth == 0 {
            terms.push(String::new());
        } else if let Some(term) = terms.last_mut() {
            term.push(c);
        }
    }
    terms.iter().any(|term| term == "test")
}

/// Per line: is it test code? An outer test attribute covers the item after it, to its
/// matching close brace (or a `;` before any brace); an inner one (`#![cfg(test)]`)
/// covers the block it sits in, or the whole file. Comments and literals never count.
fn rust_test_lines(src: &str) -> Vec<bool> {
    let code = mask(src);
    let n = code.len();
    let last = n.saturating_sub(1);
    let mut blocks = Vec::new();
    let mut open = Vec::new();
    for (at, &c) in code.iter().enumerate() {
        match c {
            b'{' => open.push(at),
            b'}' => {
                if let Some(start) = open.pop() {
                    blocks.push((start, at));
                }
            }
            _ => {}
        }
    }
    let mut regions = Vec::new();
    let mut search = 0;
    while let Some(hash) = find(&code, b"#", search) {
        search = hash + 1;
        let inner = code.get(hash + 1) == Some(&b'!');
        let bracket = hash + 1 + usize::from(inner);
        if code.get(bracket) != Some(&b'[') {
            continue;
        }
        let (mut j, mut depth) = (bracket + 1, 1);
        while j < n && depth > 0 {
            match code[j] {
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            }
            j += 1;
        }
        let attr = code.get(bracket + 1..j - 1).unwrap_or_default();
        if !is_test_cfg(&String::from_utf8_lossy(attr)) {
            continue;
        }
        regions.push(if inner {
            Iterator::max(
                blocks
                    .iter()
                    .filter(|(start, end)| *start < hash && hash < *end),
            )
            .copied()
            .unwrap_or((0, last))
        } else {
            let mut depth = 0usize;
            let mut end = last;
            for (at, &c) in code.iter().enumerate().skip(j) {
                match c {
                    b'{' => depth += 1,
                    b'}' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            end = at;
                            break;
                        }
                    }
                    b';' if depth == 0 => {
                        end = at;
                        break;
                    }
                    _ => {}
                }
            }
            (hash, end)
        });
    }
    let mut starts = vec![0];
    starts.extend(
        src.bytes()
            .enumerate()
            .filter(|(_, c)| *c == b'\n')
            .map(|(at, _)| at + 1),
    );
    let line_of = |byte: usize| starts.partition_point(|&start| start <= byte) - 1;
    let mut in_test = vec![false; starts.len()];
    for (start, end) in regions {
        for flag in &mut in_test[line_of(start)..=line_of(end)] {
            *flag = true;
        }
    }
    in_test
}

fn is_test_file(rel: &str) -> bool {
    let rules = patterns();
    let name = rel.rsplit('/').next().unwrap_or(rel);
    rules.get("test-name").iter().any(|whole| whole == name)
        || rules
            .get("test-name-suffix")
            .iter()
            .any(|suffix| name.ends_with(suffix.as_str()))
        || rules
            .get("test-name-part")
            .iter()
            .any(|part| name.contains(part.as_str()))
        || rules
            .get("test-dir")
            .iter()
            .any(|dir| rel.contains(dir.as_str()))
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
    for (n, raw) in read_tree(ALLOWLIST).lines().enumerate() {
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

/// `list`'s ceilings in `json`, in release order: the `"<release>": <n>` pairs of its
/// block in `"ceilings": { "<list>": { … } }`.
fn release_ceilings(json: &str, list: &str) -> Result<Vec<(String, usize)>, String> {
    let ceilings = json
        .find("\"ceilings\"")
        .ok_or("the ceilings file has no `ceilings`")?;
    let key = format!("\"{list}\"");
    let at = ceilings
        + json[ceilings..]
            .find(&key)
            .ok_or_else(|| format!("the ceilings file has no `{list}`"))?;
    let rest = &json[at + key.len()..];
    let open = rest
        .find('{')
        .ok_or_else(|| format!("`{list}` has no ceilings"))?;
    let close = open
        + rest[open..]
            .find('}')
            .ok_or_else(|| format!("`{list}`'s ceilings are not closed"))?;
    rest[open + 1..close]
        .split(',')
        .filter(|pair| !str::is_empty(str::trim(pair)))
        .map(|pair| {
            let (release, ceiling) = str::split_once(pair, ':').ok_or_else(|| {
                format!("`{list}`: `{}` is not `\"<release>\": <n>`", pair.trim())
            })?;
            let release = release.trim().trim_matches('"').to_string();
            let ceiling = str::parse(str::trim(ceiling))
                .map_err(|_| format!("`{list}`'s ceiling for `{release}` is not a number"))?;
            Ok((release, ceiling))
        })
        .collect()
}

/// Whether `list` has exactly its ceiling for `current` in `json`. Above it, a surface
/// was added instead of moved onto the set; below it, the ceiling was not lowered with
/// the removal, so the removal is not locked in.
fn check_ceiling(json: &str, list: &str, current: &str, count: usize) -> Result<(), String> {
    let ceiling = Iterator::find(
        &mut release_ceilings(json, list)?.into_iter(),
        |(release, _)| release == current,
    )
    .map(|(_, ceiling)| ceiling)
    .ok_or_else(|| format!("`{list}` has no ceiling for release `{current}`"))?;
    match count.cmp(&ceiling) {
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Greater => Err(format!(
            "`{list}` is {count}, above release {current}'s ceiling of {ceiling}: move a \
             surface onto the needs-you set instead of adding to {ALLOWLIST}"
        )),
        std::cmp::Ordering::Less => Err(format!(
            "`{list}` is {count}, below release {current}'s ceiling of {ceiling}: lower it to \
             {count} for {current} and every later release in {CEILINGS}"
        )),
    }
}

/// Whether no ceiling of `list` in `json` is above the one before it.
fn check_never_rising(json: &str, list: &str) -> Result<(), String> {
    let ceilings = release_ceilings(json, list)?;
    match Iterator::find(&mut ceilings.windows(2), |pair| pair[1].1 > pair[0].1) {
        Some(pair) => Err(format!(
            "`{list}` rises from {} at {} to {} at {}",
            pair[0].1, pair[0].0, pair[1].1, pair[1].0
        )),
        None => Ok(()),
    }
}

/// The allow-list (Rust and frontend entries) has exactly the length and the pinned-count
/// sum its ceilings give for the release in progress.
#[test]
fn the_allowlist_matches_the_ceilings_for_the_current_release() {
    let json = read_tree(CEILINGS);
    let current = json_value(&json, "current", 0).expect("the ceilings file names `current`");
    let allowed = allowlist();
    let problems: Vec<String> = [
        check_ceiling(&json, LIST, current, allowed.len()),
        check_ceiling(&json, LIST_HITS, current, allowed.values().sum()),
    ]
    .into_iter()
    .filter_map(Result::err)
    .collect();
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// No ceiling rises from one release to the next, and every list has one for `current`.
#[test]
fn the_ceilings_never_rise_in_release_order() {
    let json = read_tree(CEILINGS);
    let current = json_value(&json, "current", 0).expect("the ceilings file names `current`");
    for list in [LIST, LIST_HITS] {
        if let Err(problem) = check_never_rising(&json, list) {
            panic!("{problem}; a ceiling may only fall");
        }
        assert!(
            release_ceilings(&json, list)
                .unwrap()
                .iter()
                .any(|(release, _)| release == current),
            "`{list}` has no ceiling for release `{current}`"
        );
    }
}

/// The ceiling checks themselves, with `current` injected: only the exact ceiling passes,
/// a release with no ceiling fails, and a rise between releases fails.
#[test]
fn the_ceiling_checks_follow_the_release_they_are_given() {
    let json = r#"{
  "current": "R1",
  "ceilings": {
    "needsYouPredicates": { "R0": 3, "R1": 2, "R2": 0 },
    "needsYouPredicatesHits": { "R0": 9, "R1": 9 },
    "other": { "R0": 1, "R1": 4 }
  }
}"#;
    assert_eq!(json_value(json, "current", 0), Some("R1"));
    assert!(check_ceiling(json, LIST, "R0", 3).is_ok(), "at the ceiling");
    assert!(check_ceiling(json, LIST, "R0", 4).is_err(), "above it");
    assert!(check_ceiling(json, LIST, "R0", 2).is_err(), "below it");
    assert!(check_ceiling(json, LIST, "R1", 2).is_ok());
    assert!(check_ceiling(json, LIST, "R2", 0).is_ok());
    assert!(check_ceiling(json, LIST, "R2", 1).is_err());
    assert!(check_ceiling(json, LIST_HITS, "R1", 9).is_ok());
    assert!(
        check_ceiling(json, LIST_HITS, "R2", 9).is_err(),
        "no ceiling for that release"
    );
    assert!(
        check_ceiling(json, "missing", "R0", 0).is_err(),
        "no such list"
    );
    assert!(
        check_ceiling(json, "other", "R1", 3).is_err(),
        "another list's ceilings are its own"
    );
    assert!(check_never_rising(json, LIST).is_ok());
    assert!(
        check_never_rising(json, LIST_HITS).is_ok(),
        "level is not a rise"
    );
    assert!(check_never_rising(json, "other").is_err());
}

/// Every occurrence of `word` in `code` as a whole token.
fn occurrences(code: &[u8], word: &str) -> Vec<usize> {
    let word = word.as_bytes();
    let ends_in_ident = word.last().is_some_and(|&c| is_ident(c as char));
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = find(code, word, from) {
        from = at + 1;
        let before = at > 0 && is_ident(code[at - 1] as char);
        let after = ends_in_ident
            && code
                .get(at + word.len())
                .is_some_and(|&c| is_ident(c as char));
        if !before && !after {
            out.push(at);
        }
    }
    out
}

/// The byte range of `fn <name>`'s body in masked `code`, braces included.
fn fn_body(code: &[u8], name: &str) -> Option<RangeInclusive<usize>> {
    let at = find(code, format!("fn {name}(").as_bytes(), 0)?;
    let open = find(code, b"{", at)?;
    let mut depth = 0usize;
    for (i, &c) in code.iter().enumerate().skip(open) {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open..=i);
                }
            }
            _ => {}
        }
    }
    None
}

/// `WorkItemId::mint` is private and named once in `work_item.rs`, in
/// `resolve_for_launch`; only `mint` and `parse` build a `WorkItemId` there; and nothing
/// else builds a `WorkItemId` or a `wi_` id.
#[test]
fn work_item_ids_are_minted_in_one_place() {
    let sources = production_sources();
    let owner = "src-tauri/src/work_item.rs";
    let code = mask(sources.get(owner).expect("work_item.rs exists"));
    let text = String::from_utf8_lossy(&code);
    let line_at = |at: usize| text[..at].lines().count();
    let decl: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| line.contains("fn mint("))
        .collect();
    assert_eq!(
        decl,
        ["fn mint() -> Self {"],
        "mint stays private to {owner}"
    );
    let launch = fn_body(&code, "resolve_for_launch").expect("work_item.rs has resolve_for_launch");
    let named: Vec<usize> = occurrences(&code, "mint")
        .into_iter()
        .filter(|&at| !code[..at].ends_with(b"fn "))
        .collect();
    assert!(
        named.len() == 1 && launch.contains(&named[0]),
        "{owner} names mint once, in resolve_for_launch; it names it on lines {:?}",
        Vec::from_iter(named.iter().map(|&at| line_at(at)))
    );
    let builders = [
        fn_body(&code, "mint").expect("work_item.rs has mint"),
        fn_body(&code, "parse").expect("work_item.rs has parse"),
    ];
    let stray: Vec<usize> = ["WorkItemId(", "Self("]
        .into_iter()
        .flat_map(|word| occurrences(&code, word))
        .filter(|&at| !code[..at].ends_with(b"struct "))
        .filter(|at| !builders.iter().any(|body| body.contains(at)))
        .map(line_at)
        .collect();
    assert!(
        stray.is_empty(),
        "only mint and parse build a WorkItemId in {owner}; it is also built on lines {stray:?}"
    );
    let code = |text: &str| -> Vec<(usize, String)> {
        text.lines()
            .enumerate()
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
            .map(|(n, line)| (n, line.to_string()))
            .collect()
    };
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

/// Each `hit` and `miss` example in the shared patterns flags as it says. The frontend
/// guard runs the same examples, so the two guards agree on every form listed.
#[test]
fn the_shared_pattern_examples_hold() {
    let rules = patterns();
    let wrong: Vec<String> = [("hit", true), ("miss", false)]
        .into_iter()
        .flat_map(|(rule, flagged)| {
            rules
                .get(rule)
                .iter()
                .filter(move |line| line_hits(line) != flagged)
                .map(move |line| format!("{rule} {line}"))
        })
        .collect();
    assert!(!rules.get("hit").is_empty(), "{PATTERNS} has hit examples");
    assert!(
        wrong.is_empty(),
        "examples flagged wrongly:\n{}",
        wrong.join("\n")
    );
}

/// The test-region scanner: test items, `cfg(all(test, …))` items and `#![cfg(test)]`
/// modules are exempt; an attribute in a comment or a string, `cfg(not(test))`, and
/// braces in comments and char literals exempt nothing; identifiers match whole.
#[test]
fn scanner_self_test() {
    let src = r##"fn prod() { matches!(s, AgentState::NeedsPermission) }
// #[cfg(test)] in a comment exempts nothing
fn commented() { AgentState::NeedsPermission }
const S: &str = "#[cfg(test)]";
fn quoted() { AgentState::NeedsPermission }
#[cfg(test)]
mod tests {
    /* } */ const C: char = '\u{7d}';
    fn t() { let s = "}"; AgentState::NeedsPermission; }
}
#[cfg(all(test, feature = "x"))]
fn gated() { AgentState::NeedsPermission }
#[cfg(not(test))]
fn live() { AgentState::NeedsPermission }
mod inner {
    #![cfg(test)]
    fn t() { AgentState::NeedsPermission }
}
fn after() { let NeedsPermissionish = 1; }
"##;
    let test_lines = rust_test_lines(src);
    let flagged: Vec<usize> = src
        .lines()
        .enumerate()
        .filter(|(n, l)| !test_lines[*n] && line_hits(l))
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        flagged,
        vec![0, 2, 4, 13],
        "only the production lines are flagged"
    );
    let whole = rust_test_lines("#![cfg(test)]\nfn t() { AgentState::NeedsPermission }\n");
    assert!(
        whole.iter().take(2).all(|&flag| flag),
        "a file-level #![cfg(test)] exempts the file"
    );
}
