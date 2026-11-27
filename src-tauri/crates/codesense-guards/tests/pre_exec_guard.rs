// SPDX-License-Identifier: MIT
//! A census of `pre_exec(` in the app's own processes.
//!
//! A `pre_exec` hook forces std to spawn through `fork()` instead of
//! `posix_spawn`. In the desktop app, a multi-gigabyte process, that fork
//! holds the malloc lock process-wide while it copies the address space, so
//! every thread that allocates stalls, the main thread among them. Spawn with
//! no hook (`CommandExt::process_group(0)` covers a new process group, and a
//! `/bin/sh` wrapper covers a `ulimit`), or list the site below with the reason
//! it cannot.
//!
//! - **Scanned:** the `.rs` files under `src/` and `crates/*/src/`, test
//!   modules included, except `crates/codesense-session-server/src/`: the
//!   session server is its own small process, where a fork is cheap.
//!   Integration tests (`tests/`) are not scanned.
//! - **A site** is the identifier `pre_exec` followed by `(`, outside comments
//!   and string or char literals, named by its file and the function it is in.
//! - **Fails** on a site that is not in [`ALLOWED`], and on an [`ALLOWED`] row
//!   with no site left (remove the row).
//!
//! Std-only, like the other guards: point `CODESENSE_GUARD_ROOT` at another
//! `src-tauri` to run it on that tree.

use codesense_guards::guard_support::app_root;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// The session server's sources, outside the census.
const EXEMPT_ROOT: &str = "crates/codesense-session-server/src";

/// `(file, function, reason)`: the sites `posix_spawn` cannot replace.
const ALLOWED: &[(&str, &str, &str)] = &[
    (
        "src/commands/deps.rs",
        "in_new_session",
        "std has no stable setsid; one login-shell probe per deps check, off the stall path",
    ),
    (
        "crates/codesense-platform/src/limits/unix.rs",
        "inherit_original_limit",
        "restores the original open-file rlimit, which posix_spawn cannot set; once per sidecar start",
    ),
];

/// Files whose spawns moved off `pre_exec`; they must stay at zero sites.
const NO_SITES: &[&str] = &[
    "src/runtime_diagnostics.rs",
    "src/mcp/remote_workspace_bundle.rs",
    "src/commands/machines/mod.rs",
];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Site {
    file: String,
    function: String,
    line: usize,
}

/// Blank comments and string, raw-string and char literals with spaces,
/// keeping newlines and every byte offset.
fn blank(src: &str) -> Vec<u8> {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    let wipe = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut out[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    while i < b.len() {
        let rest = &b[i..];
        if rest.starts_with(b"//") {
            let end = rest.iter().position(|&c| c == b'\n').map_or(b.len(), |n| i + n);
            wipe(&mut out, i, end);
            i = end;
        } else if rest.starts_with(b"/*") {
            let (mut depth, mut j) = (1, i + 2);
            while j < b.len() && depth > 0 {
                if b[j..].starts_with(b"/*") {
                    depth += 1;
                    j += 2;
                } else if b[j..].starts_with(b"*/") {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            wipe(&mut out, i, j);
            i = j;
        } else if let Some(end) = raw_string_end(b, i) {
            wipe(&mut out, i, end);
            i = end;
        } else if b[i] == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(b.len());
            wipe(&mut out, i, end);
            i = end;
        } else if b[i] == b'\'' {
            // A char literal ('x', '\n', '\u{..}'), not a lifetime ('a).
            let end = if b.get(i + 1) == Some(&b'\\') {
                // The escaped byte at i + 2 may itself be a quote ('\'').
                b.get(i + 3..)
                    .and_then(|rest| rest.iter().position(|&c| c == b'\''))
                    .map(|n| i + 4 + n)
            } else {
                let width = src[i + 1..].chars().next().map_or(1, char::len_utf8);
                (b.get(i + 1 + width) == Some(&b'\'')).then_some(i + 2 + width)
            };
            match end {
                Some(end) => {
                    wipe(&mut out, i, end);
                    i = end;
                }
                None => i += 1,
            }
        } else {
            i += 1;
        }
    }
    out
}

/// The end of a raw (byte) string starting at `i`, if one does.
fn raw_string_end(b: &[u8], i: usize) -> Option<usize> {
    if i > 0 && is_ident(b[i - 1]) {
        return None;
    }
    let mut j = i;
    if b.get(j) == Some(&b'b') {
        j += 1;
    }
    if b.get(j) != Some(&b'r') {
        return None;
    }
    j += 1;
    let hashes = b[j..].iter().take_while(|&&c| c == b'#').count();
    j += hashes;
    if b.get(j) != Some(&b'"') {
        return None;
    }
    let close: Vec<u8> = std::iter::once(b'"')
        .chain(std::iter::repeat(b'#').take(hashes))
        .collect();
    let body = j + 1;
    let n = b[body..].windows(close.len()).position(|w| w == close.as_slice())?;
    Some(body + n + close.len())
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The name of the last `fn` declared before `at`, or `<top level>`.
fn enclosing_fn(code: &[u8], at: usize) -> String {
    let mut found = None;
    let mut i = 0;
    while let Some(n) = code[i..at].windows(3).position(|w| w == b"fn ") {
        let start = i + n;
        if start == 0 || !is_ident(code[start - 1]) {
            let name_start = start + 3;
            let name_end = name_start
                + code[name_start..].iter().take_while(|&&c| is_ident(c)).count();
            if name_end > name_start {
                found = Some(String::from_utf8_lossy(&code[name_start..name_end]).into_owned());
            }
        }
        i = start + 3;
    }
    found.unwrap_or_else(|| "<top level>".into())
}

/// Every `pre_exec(` site in one file's source.
fn sites_in(file: &str, src: &str) -> Vec<Site> {
    let code = blank(src);
    let needle = b"pre_exec";
    let mut sites = Vec::new();
    let mut i = 0;
    while let Some(n) = code[i..].windows(needle.len()).position(|w| w == needle) {
        let start = i + n;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_ident(code[start - 1]);
        let after = code[end..].iter().position(|c| !c.is_ascii_whitespace());
        if before_ok && after.is_some_and(|k| code[end + k] == b'(') {
            sites.push(Site {
                file: file.to_owned(),
                function: enclosing_fn(&code, start),
                line: 1 + code[..start].iter().filter(|&&c| c == b'\n').count(),
            });
        }
        i = end;
    }
    sites
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries {
        let path = entry.expect("read source entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_dir() {
            if name != "target" && name != "vendor" {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

fn label(app: &Path, file: &Path) -> String {
    file.strip_prefix(app)
        .expect("source under the app root")
        .to_string_lossy()
        .replace('\\', "/")
}

fn census(app: &Path) -> Vec<Site> {
    let mut roots = vec![app.join("src")];
    let mut crates: Vec<_> = fs::read_dir(app.join("crates"))
        .expect("read crates")
        .map(|entry| entry.expect("read crate entry").path().join("src"))
        .filter(|path| path.is_dir() && !path.ends_with(EXEMPT_ROOT))
        .collect();
    crates.sort();
    roots.extend(crates);
    let mut files = Vec::new();
    for root in &roots {
        rust_files(root, &mut files);
    }
    files.sort();
    let mut sites = Vec::new();
    for file in files {
        let src = fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
        sites.extend(sites_in(&label(app, &file), &src));
    }
    sites
}

/// Each failure as one line: unlisted sites, then rows with no site left.
fn violations(sites: &[Site], allowed: &[(&str, &str, &str)]) -> Vec<String> {
    let mut out = Vec::new();
    for site in sites {
        let listed = allowed
            .iter()
            .any(|(file, function, _)| *file == site.file && *function == site.function);
        if !listed {
            out.push(format!(
                "{}:{} `pre_exec(` in fn {}: it forks the whole app; spawn with \
                 process_group(0) or a /bin/sh wrapper, or list it in ALLOWED with the reason",
                site.file, site.line, site.function
            ));
        }
    }
    let present: BTreeSet<_> = sites
        .iter()
        .map(|s| (s.file.as_str(), s.function.as_str()))
        .collect();
    for (file, function, reason) in allowed {
        assert!(!reason.trim().is_empty(), "ALLOWED row {file} {function} has no reason");
        if !present.contains(&(*file, *function)) {
            out.push(format!(
                "ALLOWED row {file} fn {function} has no `pre_exec(` left: remove the row"
            ));
        }
    }
    out
}

#[test]
fn pre_exec_only_at_allowlisted_sites() {
    let app = app_root();
    let sites = census(&app);
    let failures = violations(&sites, ALLOWED);
    assert!(failures.is_empty(), "pre_exec census:\n{}", failures.join("\n"));
}

#[test]
fn moved_spawns_stay_without_pre_exec() {
    let app = app_root();
    for file in NO_SITES {
        let path = app.join(file);
        let src = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{file} must exist for this check: {e}"));
        let sites = sites_in(file, &src);
        assert!(sites.is_empty(), "{file} must spawn without pre_exec: {sites:?}");
    }
}

#[test]
fn the_session_server_is_outside_the_census() {
    let app = app_root();
    assert!(app.join(EXEMPT_ROOT).is_dir(), "{EXEMPT_ROOT} moved: update the guard");
    assert!(census(&app)
        .iter()
        .all(|s| !s.file.starts_with(EXEMPT_ROOT)));
}

#[test]
fn scanner_finds_code_sites_and_skips_prose() {
    let src = r##"
// command.pre_exec(|| Ok(()));
/* pre_exec( in a block */
fn first() {
    let s = "pre_exec(";
    let r = r#"pre_exec("#;
    let c = '(';
    let q = '\'';
    let not_it = my_pre_exec(1);
    unsafe { command.pre_exec(|| Ok(())) };
}
fn second<'a>(x: &'a str) {
    CommandExt::pre_exec (command, || Ok(()));
}
"##;
    let sites = sites_in("src/x.rs", src);
    let named: Vec<_> = sites.iter().map(|s| (s.function.as_str(), s.line)).collect();
    assert_eq!(named, [("first", 10), ("second", 13)]);
}

#[test]
fn an_unlisted_site_and_a_stale_row_both_fail() {
    let sites = sites_in("src/a.rs", "fn spawn_it() { c.pre_exec(|| Ok(())); }");
    let failures = violations(&sites, &[("src/b.rs", "gone", "a reason")]);
    assert_eq!(failures.len(), 2, "{failures:?}");
    assert!(failures[0].starts_with("src/a.rs:1 `pre_exec(` in fn spawn_it"));
    assert!(failures[1].contains("src/b.rs fn gone has no `pre_exec(` left"));
    let listed = violations(&sites, &[("src/a.rs", "spawn_it", "a reason")]);
    assert!(listed.is_empty(), "{listed:?}");
}
