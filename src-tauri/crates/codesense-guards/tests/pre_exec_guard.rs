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
//! - **A site** is the identifier `pre_exec` or its deprecated alias
//!   `before_exec` followed by `(`, outside comments and string or char
//!   literals, named by its file and the function it is in.
//! - **A helper use.** An [`ALLOWED`] site's function installs the hook for
//!   whoever calls it, so every mention of that function's name outside its
//!   definition and `use` items (a call through any re-export path, or a
//!   function pointer) is a use, named the same way. A file with its own
//!   same-named function (another platform's stub) reaches that one through a
//!   bare, `self::` or `super::` path, so those uses are not counted.
//! - **Fails** on a site not in [`ALLOWED`], a helper use not in [`CALLERS`],
//!   a `use` that renames a helper (it would hide its callers), and an
//!   [`ALLOWED`] or [`CALLERS`] row with nothing left (remove the row).
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

/// `(helper, file, function, reason)`: the callers of an [`ALLOWED`] helper.
const CALLERS: &[(&str, &str, &str, &str)] = &[
    (
        "in_new_session",
        "src/commands/deps.rs",
        "capture_stdout_within",
        "the deps check's login-shell probe, so its timeout can kill the whole session",
    ),
    (
        "inherit_original_limit",
        "src/terminal/session_server.rs",
        "sidecar_command",
        "the sidecar starts with the open-file limit the app had before its raise",
    ),
];

/// The spawn hooks that force a fork.
const HOOKS: [&str; 2] = ["pre_exec", "before_exec"];

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

/// The offsets of the identifier `ident` in blanked `code`.
fn idents(code: &[u8], ident: &str) -> Vec<usize> {
    let needle = ident.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while let Some(n) = code[i..].windows(needle.len()).position(|w| w == needle) {
        let start = i + n;
        let end = start + needle.len();
        let bounded = (start == 0 || !is_ident(code[start - 1]))
            && code.get(end).is_none_or(|&c| !is_ident(c));
        if bounded {
            found.push(start);
        }
        i = end;
    }
    found
}

/// The first non-whitespace byte at or after `at`.
fn next_byte(code: &[u8], at: usize) -> Option<u8> {
    code[at..].iter().copied().find(|c| !c.is_ascii_whitespace())
}

fn site(file: &str, code: &[u8], at: usize) -> Site {
    Site {
        file: file.to_owned(),
        function: enclosing_fn(code, at),
        line: 1 + code[..at].iter().filter(|&&c| c == b'\n').count(),
    }
}

/// Every spawn-hook site (`pre_exec(`, `before_exec(`) in blanked `code`.
fn hook_sites(file: &str, code: &[u8]) -> Vec<Site> {
    let mut sites: Vec<_> = HOOKS
        .iter()
        .flat_map(|hook| {
            idents(code, hook)
                .into_iter()
                .filter(|&at| next_byte(code, at + hook.len()) == Some(b'('))
                .map(|at| site(file, code, at))
        })
        .collect();
    sites.sort();
    sites
}

/// Every spawn-hook site in one file's source.
fn sites_in(file: &str, src: &str) -> Vec<Site> {
    hook_sites(file, &blank(src))
}

/// Whether the identifier at `at` is the name in its own `fn` definition.
fn is_definition(code: &[u8], at: usize) -> bool {
    let before = code[..at].trim_ascii_end();
    before.ends_with(b"fn") && (before.len() == 2 || !is_ident(before[before.len() - 3]))
}

/// Whether `at` is inside a `use` item: a `use` keyword with no `;` since.
fn in_use_item(code: &[u8], at: usize) -> bool {
    idents(&code[..at], "use")
        .last()
        .is_some_and(|&start| !code[start..at].contains(&b';'))
}

/// Whether the path before `at` is empty, `self::` or `super::`: it names an
/// item of this file's own module tree.
fn local_path(code: &[u8], at: usize) -> bool {
    let Some(before) = code[..at].trim_ascii_end().strip_suffix(b"::") else {
        return true;
    };
    let before = before.trim_ascii_end();
    let segment = before.len() - before.iter().rev().take_while(|&&c| is_ident(c)).count();
    matches!(&before[segment..], b"self" | b"super")
}

/// Uses of `helper` in blanked `code`, and the `use` items that rename it.
/// `own_stub`: this file defines a same-named function that is not the
/// allowed one, so local paths reach the stub.
fn helper_uses(file: &str, code: &[u8], helper: &str, own_stub: bool) -> (Vec<Site>, Vec<Site>) {
    let (mut uses, mut renames) = (Vec::new(), Vec::new());
    for at in idents(code, helper) {
        if is_definition(code, at) || (own_stub && local_path(code, at)) {
            continue;
        }
        if !in_use_item(code, at) {
            uses.push(site(file, code, at));
            continue;
        }
        let after = at + helper.len();
        let renamed = code[after..].trim_ascii_start();
        if renamed.starts_with(b"as") && renamed.get(2).is_none_or(|&c| !is_ident(c)) {
            renames.push(site(file, code, at));
        }
    }
    (uses, renames)
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

/// Every scanned source as `(label, blanked code)`.
fn sources(app: &Path) -> Vec<(String, Vec<u8>)> {
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
    files
        .into_iter()
        .map(|file| {
            let src = fs::read_to_string(&file)
                .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
            (label(app, &file), blank(&src))
        })
        .collect()
}

type Allowed<'a> = &'a [(&'a str, &'a str, &'a str)];
type Callers<'a> = &'a [(&'a str, &'a str, &'a str, &'a str)];

/// Each failure as one line: unlisted sites and helper uses, renamed helpers,
/// then rows with nothing left.
fn violations(sources: &[(String, Vec<u8>)], allowed: Allowed, callers: Callers) -> Vec<String> {
    let mut out = Vec::new();
    let mut sites_seen = BTreeSet::new();
    let mut callers_seen = BTreeSet::new();
    for (file, code) in sources {
        for site in hook_sites(file, code) {
            let listed = allowed
                .iter()
                .any(|(f, function, _)| *f == site.file && *function == site.function);
            if !listed {
                out.push(format!(
                    "{}:{} spawn hook in fn {}: it forks the whole app; spawn with \
                     process_group(0) or a /bin/sh wrapper, or list it in ALLOWED with the reason",
                    site.file, site.line, site.function
                ));
            }
            sites_seen.insert((site.file, site.function));
        }
        for (allowed_file, _, helper) in allowed {
            let own_stub = file.as_str() != *allowed_file
                && idents(code, helper).into_iter().any(|at| is_definition(code, at));
            let (uses, renames) = helper_uses(file, code, helper, own_stub);
            for site in renames {
                out.push(format!(
                    "{}:{} renames {helper} in a use: call it by its name so CALLERS sees it",
                    site.file, site.line
                ));
            }
            for site in uses {
                let listed = callers.iter().any(|(h, f, function, _)| {
                    h == helper && *f == site.file && *function == site.function
                });
                if !listed {
                    out.push(format!(
                        "{}:{} uses {helper} in fn {}: it installs a pre_exec hook; spawn \
                         without it, or list the caller in CALLERS with the reason",
                        site.file, site.line, site.function
                    ));
                }
                callers_seen.insert((helper.to_string(), site.file, site.function));
            }
        }
    }
    for (file, function, reason) in allowed {
        assert!(!reason.trim().is_empty(), "ALLOWED row {file} {function} has no reason");
        if !sites_seen.contains(&(file.to_string(), function.to_string())) {
            out.push(format!(
                "ALLOWED row {file} fn {function} has no spawn hook left: remove the row"
            ));
        }
    }
    for (helper, file, function, reason) in callers {
        assert!(!reason.trim().is_empty(), "CALLERS row {file} {function} has no reason");
        let key = (helper.to_string(), file.to_string(), function.to_string());
        if !callers_seen.contains(&key) {
            out.push(format!(
                "CALLERS row {helper} {file} fn {function} no longer uses it: remove the row"
            ));
        }
    }
    out
}

fn blanked(file: &str, src: &str) -> (String, Vec<u8>) {
    (file.to_owned(), blank(src))
}

#[test]
fn pre_exec_only_at_allowlisted_sites() {
    let failures = violations(&sources(&app_root()), ALLOWED, CALLERS);
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
    assert!(sources(&app)
        .iter()
        .all(|(file, _)| !file.starts_with(EXEMPT_ROOT)));
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
    command.before_exec(|| Ok(()));
}
"##;
    let sites = sites_in("src/x.rs", src);
    let named: Vec<_> = sites.iter().map(|s| (s.function.as_str(), s.line)).collect();
    assert_eq!(named, [("first", 10), ("second", 13), ("second", 14)]);
}

#[test]
fn an_unlisted_site_and_a_stale_row_both_fail() {
    let sources = [blanked("src/a.rs", "fn spawn_it() { c.pre_exec(|| Ok(())); }")];
    let failures = violations(&sources, &[("src/b.rs", "gone", "a reason")], &[]);
    assert_eq!(failures.len(), 2, "{failures:?}");
    assert!(failures[0].starts_with("src/a.rs:1 spawn hook in fn spawn_it"));
    assert!(failures[1].contains("src/b.rs fn gone has no spawn hook left"));
    let listed = violations(&sources, &[("src/a.rs", "spawn_it", "a reason")], &[]);
    assert!(listed.is_empty(), "{listed:?}");
}

#[test]
fn a_new_caller_of_an_allowed_helper_fails() {
    let helper = "pub fn limit(c: &mut Command) { unsafe { c.pre_exec(|| Ok(())) }; }";
    let allowed = [("crates/p/src/l.rs", "limit", "a reason")];
    let callers = [("limit", "src/s.rs", "sidecar", "a reason")];
    let listed_caller = "use p::{limit, other};\nfn sidecar() { p::l::limit(&mut c); }";
    let base = [blanked("crates/p/src/l.rs", helper), blanked("src/s.rs", listed_caller)];
    let clean = violations(&base, &allowed, &callers);
    assert!(clean.is_empty(), "{clean:?}");
    for (mutant, expected) in [
        ("fn spawn() { host_proto::nofile::limit(&mut c); }", "src/n.rs:1 uses limit in fn spawn"),
        ("fn spawn() { commands.iter_mut().for_each(limit); }", "src/n.rs:1 uses limit in fn spawn"),
        ("use p::limit as quiet;\nfn spawn() { quiet(&mut c); }", "src/n.rs:1 renames limit"),
    ] {
        let mut sources = base.to_vec();
        sources.push(blanked("src/n.rs", mutant));
        let failures = violations(&sources, &allowed, &callers);
        assert_eq!(failures.len(), 1, "{mutant}: {failures:?}");
        assert!(failures[0].starts_with(expected), "{mutant}: {failures:?}");
    }
    let stub = "pub fn limit(_: &mut Command) {}\nfn t() { super::limit(&mut c); limit(&mut c); }";
    let mut with_stub = base.to_vec();
    with_stub.push(blanked("crates/p/src/stub.rs", stub));
    let stub_only = violations(&with_stub, &allowed, &callers);
    assert!(stub_only.is_empty(), "a stub's own calls reach the stub: {stub_only:?}");
    with_stub.push(blanked(
        "crates/p/src/other.rs",
        "pub fn limit() {}\nfn t() { p::l::limit(&mut c); }",
    ));
    let through_path = violations(&with_stub, &allowed, &callers);
    assert_eq!(through_path.len(), 1, "{through_path:?}");
    assert!(through_path[0].starts_with("crates/p/src/other.rs:2 uses limit in fn t"));
    let gone = violations(&base[..1], &allowed, &callers);
    assert_eq!(gone.len(), 1, "{gone:?}");
    assert!(gone[0].contains("CALLERS row limit src/s.rs fn sidecar no longer uses it"));
}
