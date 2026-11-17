// SPDX-License-Identifier: MIT
//! A ratchet on OS-specific code outside the platform layer.
//!
//! OS-specific code belongs in `crates/codesense-platform`. This guard holds
//! the number of OS-specific sites every other non-test source file has today
//! and fails any change that adds one, so the count can only shrink.
//!
//! Every path below, in the guard's messages and in the list files, is relative
//! to the app root (`src-tauri`): `src/lib.rs`,
//! `crates/codesense-pty-core/src/process.rs`.
//!
//! - **Scanned:** the `.rs` files under `src/` and `crates/*/src/`, except
//!   `vendor/` and `target/` directories and the platform crate.
//! - **Test code is not scanned:** an item gated by `#[cfg(test)]` or
//!   `#[cfg(all(test, …))]`, found by brace matching from the first attribute
//!   of its run; a file whose `#![cfg(test)]` gates all of it; and a file
//!   reached only through test-gated `mod x;` declarations, found by following
//!   `mod` from each crate root (`lib.rs`, `main.rs`, `bin/*.rs`,
//!   `bin/*/main.rs`) through `#[path]`, `x.rs` and `x/mod.rs`. A file no
//!   crate root reaches is scanned.
//! - **A site** is one `#[cfg(…)]`, `#![cfg(…)]`, `#[cfg_attr(<predicate>, …)]`
//!   or `cfg!(…)` whose predicate names `unix`, `windows`, `target_os` or
//!   `target_family` anywhere, inside `all`/`any`/`not` too, counted once per
//!   attribute or macro however many it names. A `cfg_attr` also counts when
//!   one of its attributes is such a `cfg` (`cfg_attr(feature = "x",
//!   cfg(unix))`). Plus one per `libc::` or `windows_sys::` path and one per
//!   `os::unix` or `os::windows` segment of a `std` path or use tree
//!   (`std::os::unix::net`, `use std::{io, os::unix::fs}`,
//!   `use std::os::{fd, windows::io}`). `debug_assertions`,
//!   `test` and `feature = …` predicates are not sites. Comments and the
//!   contents of string, byte-string, raw-string and char literals are blanked
//!   before anything is matched.
//!
//! The lists live beside this file (under the guard root's
//! `crates/codesense-guards/tests/`, so a fixture tree carries its own):
//!
//! - `platform_cfg_baseline.txt`, `<path> <count>`: the ceiling per file. The
//!   guard fails (a) a file above its count, (b) a file below its count until
//!   the row is lowered in the same change, (c) a file with sites and no row,
//!   and (d) a row whose file is gone or has no counted sites.
//! - `platform_macos_ui_allowlist.txt`, `<path> <reason>`: the objc2
//!   WebKit/AppKit UI files, exempt as a whole.
//! - `platform_caps_allowlist.txt`, `<path> <cap key> <removing slug> <reason>`:
//!   one capability gate per row, each exempting one site in its file.
//!
//! An allowlist row with no reason fails. Every failure is collected and
//! reported at once. The baseline only goes down. After removing sites, lower
//! the rows with
//!
//! ```text
//! CODESENSE_PLATFORM_CFG_BASELINE_WRITE=1 cargo test -p codesense-guards --test platform_cfg_ratchet_guard
//! ```
//!
//! which lowers rows and deletes stale ones but never raises or adds a row. A
//! failing run prints the whole computed baseline too. With
//! `GITHUB_STEP_SUMMARY` set, the guard appends the total and, per crate, the
//! number of OS-gated items in test code (`#[cfg(unix)]` test modules and
//! tests, a report rather than a check).
//!
//! Std-only, like the other guards: point `CODESENSE_GUARD_ROOT` at another
//! `src-tauri` to run it on that tree. Each failure is shown that way on the
//! trees under `tests/fixtures/platform_cfg/`.

use codesense_guards::guard_support::{self, app_root};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const LISTS: &str = "crates/codesense-guards/tests";
const BASELINE: &str = "platform_cfg_baseline.txt";
const MACOS_UI: &str = "platform_macos_ui_allowlist.txt";
const CAPS: &str = "platform_caps_allowlist.txt";
const PLATFORM_CRATE: &str = "crates/codesense-platform";
const WRITE_BASELINE: &str = "CODESENSE_PLATFORM_CFG_BASELINE_WRITE";
const OS_KEYS: [&str; 4] = ["unix", "windows", "target_os", "target_family"];
/// Crates whose every path is OS-specific.
const OS_CRATES: [&str; 2] = ["libc", "windows_sys"];
/// The `std::os` modules that are OS-specific.
const STD_OS_MODULES: [&str; 2] = ["unix", "windows"];

// ---------------------------------------------------------------------------
// Lexing: blank comments and literals, keeping every byte offset.

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

fn ident_end(b: &[u8], mut at: usize) -> usize {
    while at < b.len() && is_ident(b[at]) {
        at += 1;
    }
    at
}

fn skip_ws(b: &[u8], mut at: usize) -> usize {
    while at < b.len() && b[at].is_ascii_whitespace() {
        at += 1;
    }
    at
}

fn blank(bytes: &mut [u8]) {
    for byte in bytes {
        if *byte != b'\n' {
            *byte = b' ';
        }
    }
}

/// `src` with comments (line, nested block and doc) and the contents of every
/// literal replaced by spaces. Newlines, delimiters and byte offsets are kept,
/// so a `#[path = "…"]` value can still be read from `src` at the same offset.
fn strip(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        let next = b.get(i + 1).copied();
        match b[i] {
            b'/' if next == Some(b'/') => {
                let end = b[i..]
                    .iter()
                    .position(|&c| c == b'\n')
                    .map_or(b.len(), |n| i + n);
                blank(&mut out[i..end]);
                i = end;
            }
            b'/' if next == Some(b'*') => {
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
                let end = j.min(b.len());
                blank(&mut out[i..end]);
                i = end;
            }
            b'"' => {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                let end = j.min(b.len());
                blank(&mut out[i + 1..end]);
                i = end + 1;
            }
            b'\'' => match char_literal(b, i) {
                Some(close) => {
                    blank(&mut out[i + 1..close]);
                    i = close + 1;
                }
                None => i += 1,
            },
            c if is_ident(c) => match raw_string(b, i) {
                Some((open, hashes)) => {
                    let close = (open + 1..b.len())
                        .find(|&j| {
                            b[j] == b'"'
                                && b.get(j + 1..j + 1 + hashes)
                                    .is_some_and(|h| h.iter().all(|&c| c == b'#'))
                        })
                        .unwrap_or(b.len());
                    blank(&mut out[open + 1..close]);
                    i = (close + 1 + hashes).min(b.len());
                }
                None => i = ident_end(b, i),
            },
            _ => i += 1,
        }
    }
    String::from_utf8(out).expect("blanking whole characters keeps UTF-8")
}

/// The closing quote of a char literal opening at `open` (`'"'`, `'\''`,
/// `'\u{1F600}'`), or `None` for a lifetime or a label (`'a`).
fn char_literal(b: &[u8], open: usize) -> Option<usize> {
    let first = *b.get(open + 1)?;
    if first == b'\\' {
        let from = open + 3;
        return b
            .get(from..)?
            .iter()
            .take(10)
            .position(|&c| c == b'\'')
            .map(|n| from + n);
    }
    let width = match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    };
    (b.get(open + 1 + width) == Some(&b'\'')).then_some(open + 1 + width)
}

/// A raw string (`r"…"`, `r#"…"#`, `br…`, `cr…`) starting at the identifier at
/// `at`: its opening quote and its number of hashes. `r#ident` is not one.
fn raw_string(b: &[u8], at: usize) -> Option<(usize, usize)> {
    let r = if matches!(b[at], b'b' | b'c') {
        at + 1
    } else {
        at
    };
    if b.get(r) != Some(&b'r') {
        return None;
    }
    let hashes = b[r + 1..].iter().take_while(|&&c| c == b'#').count();
    (b.get(r + 1 + hashes) == Some(&b'"')).then_some((r + 1 + hashes, hashes))
}

/// The bracket closing the one at `open`, or the end of the text.
fn close_of(b: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    for (k, &c) in b.iter().enumerate().skip(open) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return k;
                }
            }
            _ => {}
        }
    }
    b.len()
}

fn squash(b: &[u8]) -> String {
    b.iter()
        .filter(|c| !c.is_ascii_whitespace())
        .map(|&c| c as char)
        .collect()
}

// ---------------------------------------------------------------------------
// Attributes and cfg predicates.

struct Attr {
    start: usize,
    end: usize,
    inner: bool,
    /// The text between the brackets, without whitespace.
    body: String,
}

impl Attr {
    /// The predicate of a `cfg(…)` attribute.
    fn cfg(&self) -> Option<&str> {
        call(&self.body, "cfg")
    }
}

/// The arguments of `name(…)` in a squashed meta item.
fn call<'a>(meta: &'a str, name: &str) -> Option<&'a str> {
    meta.strip_prefix(name)?
        .strip_prefix('(')?
        .strip_suffix(')')
}

/// `cfg(<OS predicate>)`, or `cfg_attr(<predicate>, <attrs>)` whose predicate
/// names an OS or whose attributes hold such a `cfg`/`cfg_attr`.
fn meta_names_os(meta: &str) -> bool {
    if let Some(predicate) = call(meta, "cfg") {
        return names_os(predicate);
    }
    let Some(inner) = call(meta, "cfg_attr") else {
        return false;
    };
    let args = args(inner);
    args.first().is_some_and(|predicate| names_os(predicate))
        || args.iter().skip(1).any(|attr| meta_names_os(attr))
}

fn attr_at(b: &[u8], at: usize) -> Option<Attr> {
    if b.get(at) != Some(&b'#') {
        return None;
    }
    let mut k = skip_ws(b, at + 1);
    let inner = b.get(k) == Some(&b'!');
    if inner {
        k = skip_ws(b, k + 1);
    }
    if b.get(k) != Some(&b'[') {
        return None;
    }
    let close = close_of(b, k);
    Some(Attr {
        start: at,
        end: (close + 1).min(b.len()),
        inner,
        body: squash(&b[k + 1..close]),
    })
}

/// The top-level comma-separated arguments of a squashed list.
fn args(list: &str) -> Vec<&str> {
    let (mut out, mut depth, mut from) = (Vec::new(), 0usize, 0);
    for (k, c) in list.char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push(&list[from..k]);
                from = k + 1;
            }
            _ => {}
        }
    }
    out.push(&list[from..]);
    out.retain(|arg| !arg.is_empty());
    out
}

/// Whether a predicate names an OS (string values are already blanked, so
/// `feature = "unix"` does not).
fn names_os(predicate: &str) -> bool {
    predicate
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|word| OS_KEYS.contains(&word))
}

/// `test`, or `all(…)` with `test` among its arguments.
fn is_test(predicate: &str) -> bool {
    predicate == "test" || call(predicate, "all").is_some_and(|inner| args(inner).contains(&"test"))
}

// ---------------------------------------------------------------------------
// One file: test regions, `mod` declarations, sites.

/// Byte ranges of the test-gated items, each from the first attribute of the
/// attribute run holding the test cfg to the end of the item. An inner
/// attribute (`#![…]`) belongs to its enclosing module, never to a run.
fn test_regions(b: &[u8]) -> Vec<(usize, usize)> {
    let mut regions = Vec::new();
    let (mut run_start, mut prev_end) = (0, None);
    let mut k = 0;
    while k < b.len() {
        let Some(attr) = attr_at(b, k) else {
            k += 1;
            continue;
        };
        if attr.inner {
            k = attr.end;
            prev_end = None;
            continue;
        }
        let joined = prev_end.is_some_and(|end: usize| {
            b[end..attr.start]
                .iter()
                .all(|c: &u8| c.is_ascii_whitespace())
        });
        if !joined {
            run_start = attr.start;
        }
        if attr.cfg().is_some_and(is_test) {
            let end = item_end(b, attr.end);
            regions.push((run_start, end));
            k = end;
            prev_end = None;
        } else {
            k = attr.end;
            prev_end = Some(attr.end);
        }
    }
    regions
}

/// The end of what an attribute gates: past its `;` or its `{…}` body, at the
/// `,` after a field, variant, parameter or match arm, or at the close of the
/// enclosing block. Generic `<…>` holds its commas, a comparison's `<` does
/// not; `->` and `=>` are not brackets.
fn item_end(b: &[u8], from: usize) -> usize {
    let (mut depth, mut angle) = (0usize, 0usize);
    let mut k = from;
    while k < b.len() {
        match b[k] {
            b'-' if b.get(k + 1) == Some(&b'>') => k += 1,
            // A match arm's guard is over: no generic spans `=>`.
            b'=' if b.get(k + 1) == Some(&b'>') => {
                angle = 0;
                k += 1;
            }
            b'<' if opens_generic(b, k) => angle += 1,
            b'>' => angle = angle.saturating_sub(1),
            b'{' if depth == 0 => return (close_of(b, k) + 1).min(b.len()),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => return k,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth == 0 => return k + 1,
            b',' if depth == 0 && angle == 0 => return k + 1,
            _ => {}
        }
        k += 1;
    }
    b.len()
}

/// Whether the `<` at `at` opens generic arguments (`Vec<u8>`, `f::<T>`)
/// rather than comparing (`a < b`, `a <= b`, `a << b`): it follows an
/// identifier or `::` directly, and no space, `=` or `<` follows it (rustfmt
/// spaces every comparison).
fn opens_generic(b: &[u8], at: usize) -> bool {
    let after_path = at > 0 && (is_ident(b[at - 1]) || b[at - 1] == b':');
    let next = b.get(at + 1).copied().unwrap_or(b' ');
    after_path && !next.is_ascii_whitespace() && next != b'=' && next != b'<'
}

/// Whether a file-level `#![cfg(test)]` gates the whole file.
fn test_only_file(b: &[u8]) -> bool {
    (0..b.len()).filter_map(|k| attr_at(b, k)).any(|attr| {
        let depth = || {
            b[..attr.start].iter().fold(0isize, |depth, &c| match c {
                b'{' => depth + 1,
                b'}' => depth - 1,
                _ => depth,
            })
        };
        attr.inner && attr.cfg().is_some_and(is_test) && depth() == 0
    })
}

struct ModDecl {
    name: String,
    /// The `#[path = "…"]` value, if any.
    path: Option<String>,
    /// The inline modules (`mod a { … }`) the declaration sits in.
    inline: Vec<String>,
    /// Whether the declaration is test-gated, itself or by an enclosing item.
    test: bool,
    at: usize,
}

/// Every `mod name;` in the stripped text `b` of `src`.
fn mod_decls(src: &str, b: &[u8]) -> Vec<ModDecl> {
    let (mut decls, mut scopes, mut path) = (Vec::new(), Vec::<Option<String>>::new(), None);
    let mut k = 0;
    while k < b.len() {
        if let Some(attr) = attr_at(b, k) {
            if !attr.inner && attr.body.starts_with("path=") {
                path = literal_in(src, b, &attr);
            }
            k = attr.end;
            continue;
        }
        if is_ident(b[k]) {
            let end = ident_end(b, k);
            if &b[k..end] == b"mod" {
                let name_at = skip_ws(b, end);
                let name_end = ident_end(b, name_at);
                let after = skip_ws(b, name_end);
                let name = String::from_utf8_lossy(&b[name_at..name_end]).into_owned();
                match b.get(after).copied() {
                    Some(b';') if name_end > name_at => {
                        decls.push(ModDecl {
                            name,
                            path: path.take(),
                            inline: scopes.iter().flatten().cloned().collect(),
                            test: false,
                            at: k,
                        });
                        k = after + 1;
                        continue;
                    }
                    Some(b'{') if name_end > name_at => {
                        scopes.push(Some(name));
                        path = None;
                        k = after + 1;
                        continue;
                    }
                    _ => {}
                }
            }
            k = end;
            continue;
        }
        match b[k] {
            b'{' => scopes.push(None),
            b'}' => {
                scopes.pop();
            }
            _ => {}
        }
        if matches!(b[k], b'{' | b'}' | b';') {
            path = None;
        }
        k += 1;
    }
    decls
}

/// The string literal inside an attribute, read from the unstripped source.
fn literal_in(src: &str, b: &[u8], attr: &Attr) -> Option<String> {
    let open = attr.start + b[attr.start..attr.end].iter().position(|&c| c == b'"')?;
    let close = open + 1 + b[open + 1..attr.end].iter().position(|&c| c == b'"')?;
    Some(src[open + 1..close].to_string())
}

#[derive(Clone, Copy, Default)]
struct Counts {
    /// OS-specific sites.
    sites: usize,
    /// The attributes among them (`cfg`/`cfg_attr`), for the test-code report.
    os_attrs: usize,
}

fn count(b: &[u8]) -> Counts {
    let mut counts = Counts::default();
    let mut k = 0;
    while k < b.len() {
        if let Some(attr) = attr_at(b, k) {
            if meta_names_os(&attr.body) {
                counts.sites += 1;
                counts.os_attrs += 1;
            }
            k = attr.end;
            continue;
        }
        if !is_ident(b[k]) {
            k += 1;
            continue;
        }
        let end = ident_end(b, k);
        let word = &b[k..end];
        if word == b"cfg" && b.get(skip_ws(b, end)) == Some(&b'!') {
            let open = skip_ws(b, skip_ws(b, end) + 1);
            if b.get(open) == Some(&b'(') {
                let close = close_of(b, open);
                if names_os(&squash(&b[open + 1..close])) {
                    counts.sites += 1;
                }
                k = close;
                continue;
            }
        }
        if OS_CRATES.iter().any(|name| word == name.as_bytes()) && path_sep(b, end).is_some() {
            counts.sites += 1;
        } else if word == b"std" {
            if let Some(next) = path_sep(b, end) {
                counts.sites += std_os_paths(b, next, b"std").0;
            }
        }
        k = end;
    }
    counts
}

/// Past the `::` after `at` (whitespace allowed), if there is one.
fn path_sep(b: &[u8], at: usize) -> Option<usize> {
    let k = skip_ws(b, at);
    (b.get(k..k + 2) == Some(b"::".as_slice())).then(|| skip_ws(b, k + 2))
}

/// The `os::unix` / `os::windows` segments in the path or use tree at `at`,
/// whose parent segment is `parent`: `std::os::unix::net::UnixStream`,
/// `std::{io, os::unix::fs::PermissionsExt}`, `std::os::{fd, unix::io}`. One
/// per segment; returns the count and where the tree ends.
fn std_os_paths(b: &[u8], at: usize, parent: &[u8]) -> (usize, usize) {
    let mut k = skip_ws(b, at);
    match b.get(k).copied() {
        Some(b'{') => {
            let mut hits = 0;
            k += 1;
            loop {
                k = skip_ws(b, k);
                match b.get(k).copied() {
                    Some(b'}') => return (hits, k + 1),
                    Some(b',') => k += 1,
                    Some(_) => {
                        let (n, next) = std_os_paths(b, k, parent);
                        if next == k {
                            return (hits, k);
                        }
                        hits += n;
                        k = next;
                    }
                    None => return (hits, k),
                }
            }
        }
        Some(c) if is_ident(c) => {
            let end = ident_end(b, k);
            let segment = &b[k..end];
            let hit = usize::from(
                parent == b"os" && STD_OS_MODULES.iter().any(|m| segment == m.as_bytes()),
            );
            if let Some(next) = path_sep(b, end).filter(|&n| b.get(n) != Some(&b'<')) {
                let (n, after) = std_os_paths(b, next, segment);
                return (hit + n, after);
            }
            // `unix as u` in a use tree.
            let after = skip_ws(b, end);
            if b[after..].starts_with(b"as") && !b.get(after + 2).is_some_and(|&c| is_ident(c)) {
                return (hit, ident_end(b, skip_ws(b, after + 2)));
            }
            (hit, end)
        }
        Some(b'*') => (0, k + 1),
        _ => (0, k),
    }
}

struct Parsed {
    /// Every OS attribute and site, test code included.
    all: Counts,
    /// What remains once the test-gated items are blanked (nothing for a
    /// file `#![cfg(test)]` gates as a whole).
    kept: Counts,
    mods: Vec<ModDecl>,
}

fn parse(src: &str) -> Parsed {
    let stripped = strip(src);
    let b = stripped.as_bytes();
    let test_only = test_only_file(b);
    let regions = test_regions(b);
    let mut mods = mod_decls(src, b);
    for decl in &mut mods {
        decl.test = test_only || regions.iter().any(|&(s, e)| s <= decl.at && decl.at < e);
    }
    let all = count(b);
    let kept = if test_only {
        Counts::default()
    } else if regions.is_empty() {
        all
    } else {
        let mut kept = b.to_vec();
        for &(start, end) in &regions {
            blank(&mut kept[start..end]);
        }
        count(&kept)
    };
    Parsed { all, kept, mods }
}

// ---------------------------------------------------------------------------
// The tree: files, crate roots, `mod` reachability.

/// What one tree holds: per file (app-root-relative label), its non-test
/// sites (files with none are left out) and, per crate, the OS-gated
/// attributes in its test code.
#[derive(Default)]
struct Scan {
    sites: BTreeMap<String, usize>,
    test_gates: BTreeMap<String, usize>,
}

fn scan(root: &Path) -> Scan {
    let platform = root.join(PLATFORM_CRATE).join("src");
    let mut src_dirs = guard_support::roots_at(root);
    src_dirs.retain(|dir| *dir != platform);
    let mut parsed = BTreeMap::new();
    for dir in &src_dirs {
        for file in rust_files(dir) {
            let src = fs::read_to_string(&file)
                .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
            parsed.insert(file, parse(&src));
        }
    }
    let mut seen = BTreeSet::new();
    for dir in &src_dirs {
        for crate_root in crate_roots(dir) {
            let dir = crate_root.parent().expect("a crate root has a directory");
            walk(&parsed, &crate_root, dir, false, &mut seen);
        }
    }
    let mut out = Scan::default();
    for (file, file_parsed) in &parsed {
        let reached = |test: bool| seen.contains(&(file.clone(), test));
        let test_only = reached(true) && !reached(false);
        let label = label(root, file);
        let kept = if test_only {
            Counts::default()
        } else {
            file_parsed.kept
        };
        let gates = file_parsed.all.os_attrs - kept.os_attrs;
        if gates > 0 {
            *out.test_gates.entry(crate_of(&label)).or_default() += gates;
        }
        if kept.sites > 0 {
            out.sites.insert(label, kept.sites);
        }
    }
    out
}

/// Every `.rs` file under `dir`, outside `vendor/` and `target/`, sorted.
fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("read a source entry").path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.is_dir() {
                if name != "vendor" && name != "target" {
                    stack.push(path);
                }
            } else if name.ends_with(".rs") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// `lib.rs`, `main.rs`, `bin/*.rs` and `bin/*/main.rs` under a `src` directory.
fn crate_roots(src: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["lib.rs", "main.rs"]
        .iter()
        .map(|name| src.join(name))
        .collect();
    if let Ok(entries) = fs::read_dir(src.join("bin")) {
        for entry in entries {
            let path = entry.expect("read a bin entry").path();
            roots.push(if path.is_dir() {
                path.join("main.rs")
            } else {
                path
            });
        }
    }
    roots.retain(|path| path.is_file() && path.extension().is_some_and(|e| e == "rs"));
    roots.sort();
    roots
}

/// Follow `mod` declarations from `file`, whose child modules live in `dir`,
/// marking each file reached with whether the route there is test-gated.
fn walk(
    parsed: &BTreeMap<PathBuf, Parsed>,
    file: &Path,
    dir: &Path,
    test: bool,
    seen: &mut BTreeSet<(PathBuf, bool)>,
) {
    if !seen.insert((file.to_path_buf(), test)) {
        return;
    }
    let Some(file_parsed) = parsed.get(file) else {
        return;
    };
    for decl in &file_parsed.mods {
        let base = decl.inline.iter().fold(dir.to_path_buf(), |d, m| d.join(m));
        let (child, child_dir) = match &decl.path {
            // `#[path]` outside an inline module is relative to the file's own
            // directory; the module it loads owns its directory.
            Some(rel) => {
                let from = if decl.inline.is_empty() {
                    file.parent()
                        .expect("a source has a directory")
                        .to_path_buf()
                } else {
                    base
                };
                let child = clean(&from.join(rel));
                let child_dir = child
                    .parent()
                    .expect("a module file has a directory")
                    .to_path_buf();
                (child, child_dir)
            }
            None => {
                let flat = base.join(format!("{}.rs", decl.name));
                let nested = base.join(&decl.name);
                if parsed.contains_key(&flat) {
                    (flat, nested)
                } else {
                    (nested.join("mod.rs"), nested)
                }
            }
        };
        walk(parsed, &child, &child_dir, test || decl.test, seen);
    }
}

fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn label(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or_else(|_| panic!("{} is outside {}", file.display(), root.display()))
        .to_string_lossy()
        .replace('\\', "/")
}

fn crate_of(label: &str) -> String {
    label
        .strip_prefix("crates/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("app (src)")
        .to_string()
}

// ---------------------------------------------------------------------------
// The lists and the check.

struct Lists {
    /// path -> (line, count)
    baseline: BTreeMap<String, (usize, usize)>,
    /// path -> line
    macos_ui: BTreeMap<String, usize>,
    /// path -> the lines of its gate rows
    gates: BTreeMap<String, Vec<usize>>,
    failures: Vec<String>,
}

/// The non-comment rows of a list, as (line, words).
fn list_rows(root: &Path, name: &str, failures: &mut Vec<String>) -> Vec<(usize, Vec<String>)> {
    let path = root.join(LISTS).join(name);
    let Ok(text) = fs::read_to_string(&path) else {
        failures.push(format!(
            "{name} is missing under {LISTS}: create it (the format is in the header of platform_cfg_ratchet_guard.rs)."
        ));
        return Vec::new();
    };
    text.lines()
        .enumerate()
        .map(|(n, line)| (n + 1, line.trim()))
        .filter(|(_, line)| !line.is_empty() && !line.starts_with('#'))
        .map(|(n, line)| {
            let words = line.split_whitespace().map(str::to_string);
            (n, words.collect::<Vec<_>>())
        })
        .collect()
}

/// The words after the first `fields`, as a reason (a leading `#` is allowed).
fn reason(words: &[String], fields: usize) -> String {
    words
        .get(fields..)
        .unwrap_or_default()
        .join(" ")
        .trim_start_matches('#')
        .trim()
        .to_string()
}

fn load_lists(root: &Path) -> Lists {
    let mut failures = Vec::new();
    let mut baseline = BTreeMap::new();
    for (line, words) in list_rows(root, BASELINE, &mut failures) {
        let row = match words.as_slice() {
            [path, count] => count
                .parse::<usize>()
                .ok()
                .map(|count| (path.clone(), count)),
            _ => None,
        };
        let Some((path, count)) = row else {
            failures.push(format!("{BASELINE}:{line}: expected `<path> <count>`."));
            continue;
        };
        if baseline.insert(path.clone(), (line, count)).is_some() {
            failures.push(format!(
                "{BASELINE}:{line}: `{path}` has a second row; keep one."
            ));
        }
    }
    let mut macos_ui = BTreeMap::new();
    for (line, words) in list_rows(root, MACOS_UI, &mut failures) {
        let path = words[0].clone();
        if reason(&words, 1).is_empty() {
            failures.push(format!(
                "{MACOS_UI}:{line}: `{path}` has no reason; say why the file is exempt."
            ));
        }
        if !root.join(&path).is_file() {
            failures.push(format!(
                "{MACOS_UI}:{line}: `{path}` does not exist; delete the row."
            ));
        }
        if macos_ui.insert(path.clone(), line).is_some() {
            failures.push(format!(
                "{MACOS_UI}:{line}: `{path}` has a second row; keep one."
            ));
        }
    }
    let mut gates: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (line, words) in list_rows(root, CAPS, &mut failures) {
        if words.len() < 3 {
            failures.push(format!(
                "{CAPS}:{line}: expected `<path> <cap key> <removing slug> <reason>`."
            ));
            continue;
        }
        if reason(&words, 3).is_empty() {
            failures.push(format!(
                "{CAPS}:{line}: `{}` has no reason; say what the gate compiles out.",
                words[0]
            ));
        }
        gates.entry(words[0].clone()).or_default().push(line);
    }
    Lists {
        baseline,
        macos_ui,
        gates,
        failures,
    }
}

struct Report {
    failures: Vec<String>,
    /// The baseline this tree would have: path -> count.
    computed: BTreeMap<String, usize>,
    /// The baseline as listed: path -> count.
    listed: BTreeMap<String, usize>,
    test_gates: BTreeMap<String, usize>,
}

fn check(root: &Path) -> Report {
    let scan = scan(root);
    let lists = load_lists(root);
    let mut failures = lists.failures;

    for (path, lines) in &lists.gates {
        let sites = scan.sites.get(path).copied().unwrap_or(0);
        if lines.len() > sites {
            failures.push(format!(
                "{CAPS}:{}: `{path}` has {} gate rows but {sites} sites; delete the rows whose gate is gone.",
                lines[0],
                lines.len()
            ));
        }
    }
    let computed: BTreeMap<String, usize> = scan
        .sites
        .iter()
        .filter(|(path, _)| !lists.macos_ui.contains_key(*path))
        .map(|(path, &sites)| {
            let gates = lists.gates.get(path).map_or(0, Vec::len);
            (path.clone(), sites.saturating_sub(gates))
        })
        .filter(|&(_, n)| n > 0)
        .collect();

    for (path, &n) in &computed {
        match lists.baseline.get(path) {
            None => failures.push(format!(
                "{path}: {n} OS-specific sites and no baseline row. Put the OS code in `codesense-platform`, or gate it with a row in {CAPS}; the baseline only shrinks, so a new row is not the fix."
            )),
            Some(&(line, max)) if n > max => failures.push(format!(
                "{path}: {n} OS-specific sites, above its baseline of {max} ({BASELINE}:{line}). Put the new OS code in `codesense-platform`, or gate it with a row in {CAPS}."
            )),
            Some(&(line, max)) if n < max => failures.push(format!(
                "{path}: {n} OS-specific sites, below its baseline of {max}. Lower {BASELINE}:{line} to {n} in this change ({WRITE_BASELINE}=1 does it)."
            )),
            Some(_) => {}
        }
    }
    for (path, &(line, _)) in &lists.baseline {
        if computed.contains_key(path) {
            continue;
        }
        if root.join(path).is_file() {
            failures.push(format!(
                "{BASELINE}:{line}: `{path}` has no counted sites (moved to the platform layer, exempt or test-only); delete the row."
            ));
        } else {
            failures.push(format!(
                "{BASELINE}:{line}: `{path}` no longer exists; delete the row."
            ));
        }
    }
    Report {
        failures,
        computed,
        listed: lists
            .baseline
            .iter()
            .map(|(path, &(_, count))| (path.clone(), count))
            .collect(),
        test_gates: scan.test_gates,
    }
}

fn failure_text(report: &Report) -> String {
    let mut text = format!(
        "OS-specific code outside the platform layer: {} failure(s)\n",
        report.failures.len()
    );
    for failure in &report.failures {
        text.push_str(&format!("  - {failure}\n"));
    }
    text.push_str(
        "\nThe baseline this tree computes (copy only rows that go down; a row never goes up):\n",
    );
    for (path, n) in &report.computed {
        text.push_str(&format!("{path} {n}\n"));
    }
    text
}

/// Lower every listed row to what the tree has and drop the stale ones; never
/// raise a row or add one.
fn write_lowered_baseline(root: &Path, report: &Report) {
    let path = root.join(LISTS).join(BASELINE);
    let old = fs::read_to_string(&path).unwrap_or_default();
    let mut text: String = old
        .lines()
        .take_while(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
        .map(|line| format!("{line}\n"))
        .collect();
    for (file, &max) in &report.listed {
        if let Some(&n) = report.computed.get(file) {
            text.push_str(&format!("{file} {}\n", n.min(max)));
        }
    }
    fs::write(&path, text).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

fn append_summary(path: &Path, report: &Report) {
    let total: usize = report.computed.values().sum();
    let gated: usize = report.test_gates.values().sum();
    let mut text = format!(
        "### Platform cfg ratchet\n\n{total} OS-specific sites in {} files outside the platform layer.\n\n\
         OS-gated items in test code (report only): {gated}\n\n| Crate | OS-gated test items |\n|---|---|\n",
        report.computed.len()
    );
    for (krate, n) in &report.test_gates {
        text.push_str(&format!("| {krate} | {n} |\n"));
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .unwrap_or_else(|e| panic!("append {}: {e}", path.display()));
}

#[test]
fn platform_cfg_ratchet_holds() {
    let root = app_root();
    if std::env::var_os(WRITE_BASELINE).is_some() {
        write_lowered_baseline(&root, &check(&root));
    }
    let report = check(&root);
    if let Some(summary) = std::env::var_os("GITHUB_STEP_SUMMARY") {
        append_summary(Path::new(&summary), &report);
    }
    assert!(report.failures.is_empty(), "{}", failure_text(&report));
}

// ---------------------------------------------------------------------------
// The scanner on snippets.

fn sites(src: &str) -> usize {
    parse(src).kept.sites
}

#[test]
fn comments_and_literals_are_not_sites() {
    let src = r####"
//! cfg!(windows) in an inner doc comment
/// #[cfg(unix)] in a doc comment
// cfg(unix) and libc:: in a line comment
/* a block /* nested #[cfg(windows)] */ still a comment: std::os::unix */
fn prose() {
    let _ = "libc:: and #[cfg(unix)] in a string";
    let _ = "an escaped quote \" then libc:: \\";
    let _ = r#"a raw string with "quotes" and std::os::windows"#;
    let _ = br##"windows_sys:: "# still raw"##;
    let _ = b"libc::";
    let _ = ('"', '\'', b'"', '\\', '\u{1F600}');
}
"####;
    let stripped = strip(src);
    assert_eq!(stripped.len(), src.len(), "byte offsets are kept");
    assert_eq!(stripped.lines().count(), src.lines().count());
    assert_eq!(sites(src), 0, "{stripped}");
}

#[test]
fn code_after_tricky_literals_still_counts() {
    let src = r##"
fn chars<'a>(x: &'a str) -> char {
    let _ = ('"', '\'', b'"');
    let _ = r#"}"#;
    'outer: loop { break 'outer; }
    #[cfg(unix)]
    let _ = libc::getpid;
    'x'
}
"##;
    assert_eq!(sites(src), 2);
}

#[test]
fn one_site_per_attribute_or_macro_and_per_path() {
    for (src, n) in [
        ("#[cfg(any(unix, windows))] fn f() {}", 1),
        ("#[cfg(all(unix, not(target_os = \"macos\")))] fn f() {}", 1),
        ("#[cfg( target_family = \"unix\" )] fn f() {}", 1),
        ("#![cfg(windows)]", 1),
        ("#[cfg_attr(windows, path = \"w.rs\")] mod m;", 1),
        (
            "fn f() -> bool { cfg!(target_os = \"linux\") || cfg!(windows) }",
            2,
        ),
        ("use std::os::unix::fs::PermissionsExt;", 1),
        ("use std::os::windows::io::AsRawHandle;", 1),
        ("fn f() { unsafe { libc::kill(libc::getpid(), 0) }; }", 2),
        ("use windows_sys::Win32::Foundation::CloseHandle;", 1),
        ("use std::{os::unix::fs::PermissionsExt, path::Path};", 1),
        ("use std::os::{fd::AsRawFd, unix::io::FromRawFd};", 1),
        ("use std::{io, os::{fd, unix::prelude::*}};", 1),
        ("use std::{io, os::unix as u};", 1),
        ("use std::os::{unix, windows};", 2),
        (
            "fn f() { let _ = ::std::os::unix::net::UnixStream::connect(p); }",
            1,
        ),
        (
            "fn f() { let _ = std :: os :: windows :: io :: AsRawHandle::as_raw_handle; }",
            1,
        ),
        ("#[cfg_attr(not(feature = \"x\"), cfg(unix))] fn f() {}", 1),
        (
            "#[cfg_attr(test, cfg_attr(feature = \"y\", cfg(windows)))] fn f() {}",
            1,
        ),
    ] {
        assert_eq!(sites(src), n, "{src}");
    }
}

#[test]
fn non_os_cfgs_are_not_sites() {
    for src in [
        "#[cfg(debug_assertions)] fn f() {}",
        "#[cfg(feature = \"unix\")] fn f() {}",
        "#[cfg(any(test, feature = \"windows\"))] fn f() {}",
        "#[cfg_attr(test, allow(dead_code))] fn f() {}",
        "use std::os::fd::AsRawFd;",
        "use std::{io, os::raw::c_int, unix, windows::x};",
        "#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]",
        "fn f() -> bool { cfg!(debug_assertions) }",
        "fn f() { mylibc::x(); not_windows_sys::y(); std::os::unixish(); }",
        "fn windows() -> u8 { let unix = 1; unix }",
    ] {
        assert_eq!(sites(src), 0, "{src}");
    }
}

#[test]
fn test_items_are_skipped_by_brace_matching() {
    let src = "fn prod() {}\n#[cfg(test)]\nmod tests {\n    fn t() { let s = \"}\"; let c = '}'; libc::abort(); }\n    #[cfg(unix)]\n    fn u() {}\n}\n#[cfg(unix)]\nfn after() {}\n";
    let parsed = parse(src);
    assert_eq!(parsed.kept.sites, 1, "only the item after the test module");
    assert_eq!(parsed.all.os_attrs - parsed.kept.os_attrs, 1);

    let gated = parse("#[cfg(all(test, unix))]\nmod u {\n    #[cfg(windows)]\n    fn w() {}\n}\n");
    assert_eq!(gated.kept.sites, 0);
    assert_eq!(gated.all.os_attrs, 2, "both are OS-gated test items");

    let run = parse("#[cfg(unix)]\n#[cfg(test)]\nmod unix_tests { fn t() {} }\n#[cfg(test)]\nuse std::os::unix::fs::PermissionsExt;\n");
    assert_eq!(
        run.kept.sites, 0,
        "the whole attribute run and `use` are test code"
    );

    let file_src = "//! Tests.\n#![cfg(test)]\nuse std::os::unix::fs::PermissionsExt;\n#[cfg(unix)]\nfn t() {}\n";
    assert!(test_only_file(strip(file_src).as_bytes()));
    let file = parse(file_src);
    assert_eq!(file.kept.sites, 0);
    assert_eq!(file.all.os_attrs, 1, "its OS gates are test items");

    let inner = parse("#![cfg(unix)]\n#[cfg(test)]\nmod t {}\n");
    assert_eq!(
        inner.kept.sites, 1,
        "an inner attribute never joins a test run"
    );

    let not_test = parse("#[cfg(any(target_os = \"macos\", test))]\nfn f() { libc::getpid(); }\n");
    assert_eq!(
        not_test.kept.sites, 2,
        "`any(…, test)` is production code too"
    );
}

#[test]
fn a_test_gated_member_ends_at_its_comma() {
    for (src, n) in [
        ("struct S { #[cfg(test)] a: bool, #[cfg(unix)] fd: i32 }", 1),
        ("struct S { #[cfg(test)] a: HashMap<u8, u8>, #[cfg(unix)] fd: i32 }", 1),
        ("enum E { #[cfg(test)] A(u8, u8), #[cfg(windows)] B }", 1),
        ("fn f(#[cfg(test)] a: u8, #[cfg(unix)] b: i32) {}", 1),
        ("fn f(x: u8) { match x { #[cfg(test)] 0 => a(), #[cfg(unix)] _ => libc::abort() } }", 2),
        ("#[cfg(test)]\nfn g<A, B>(x: A) -> Result<A, B> { libc::abort() }\n#[cfg(unix)]\nfn h() {}", 1),
        ("#[cfg(test)]\nconst LESS: bool = 1 < 2;\n#[cfg(unix)]\nfn h() {}", 1),
        ("fn f(n: i32) { match n { #[cfg(test)] n if n < 0 => a(), #[cfg(unix)] _ => libc::abort() } }", 2),
        ("fn f() -> S { S { #[cfg(test)] ok: a < b, #[cfg(unix)] fd: 1 } }", 1),
        ("fn f() -> S { S { #[cfg(test)] m: HashMap::<u8, u8>::new(), #[cfg(unix)] fd: 1 } }", 1),
        ("fn f() -> S { S { #[cfg(test)] m: Vec<Option<u8>>, #[cfg(unix)] fd: 1 } }", 1),
    ] {
        assert_eq!(sites(src), n, "{src}");
    }
}

#[test]
fn mod_declarations_carry_path_inline_and_test() {
    let src = "#[cfg(test)]\nmod tests;\n#[path = \"x/y.rs\"]\npub(crate) mod z;\nmod a {\n    mod b;\n}\n#[cfg(test)]\nmod t {\n    mod helper;\n}\nmod c;\nfn f() { let module = 1; }\n";
    let summary: Vec<_> = parse(src)
        .mods
        .into_iter()
        .map(|d| (d.name, d.path, d.inline, d.test))
        .collect();
    let s = |v: &str| v.to_string();
    assert_eq!(
        summary,
        vec![
            (s("tests"), None, vec![], true),
            (s("z"), Some(s("x/y.rs")), vec![], false),
            (s("b"), None, vec![s("a")], false),
            (s("helper"), None, vec![s("t")], true),
            (s("c"), None, vec![], false),
        ]
    );
}

// ---------------------------------------------------------------------------
// The guard on fixture trees, through `CODESENSE_GUARD_ROOT`.

fn fixture(case: &str) -> PathBuf {
    guard_support::resolve(&format!("tests/fixtures/platform_cfg/{case}"))
}

/// Run the guard's own check in a child test process with
/// `CODESENSE_GUARD_ROOT` at a fixture tree (the variable is process-wide, so
/// the tests here never set it on themselves).
fn guard_on(case: &str, summary: Option<&Path>) -> (bool, String) {
    let mut run = Command::new(std::env::current_exe().expect("the test binary"));
    run.args([
        "platform_cfg_ratchet_holds",
        "--exact",
        "--nocapture",
        "--test-threads=1",
    ])
    .env("CODESENSE_GUARD_ROOT", fixture(case))
    .env_remove(WRITE_BASELINE)
    .env_remove("GITHUB_STEP_SUMMARY");
    if let Some(summary) = summary {
        run.env("GITHUB_STEP_SUMMARY", summary);
    }
    let out = run.output().expect("run the guard on a fixture");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.success(), text)
}

fn assert_guard_fails(case: &str, needles: &[&str]) {
    let (passed, out) = guard_on(case, None);
    assert!(!passed, "the guard should fail on `{case}`:\n{out}");
    for needle in needles {
        assert!(
            out.contains(needle),
            "`{case}`: expected {needle:?} in:\n{out}"
        );
    }
}

fn rows(rows: &[(&str, usize)]) -> BTreeMap<String, usize> {
    rows.iter().map(|&(k, v)| (k.to_string(), v)).collect()
}

#[test]
fn baseline_regeneration_only_lowers_and_drops_rows() {
    let root = std::env::temp_dir().join(format!("platform-cfg-write-{}", std::process::id()));
    let lists = root.join(LISTS);
    fs::create_dir_all(&lists).expect("create the temporary lists");
    fs::write(
        lists.join(BASELINE),
        "# header\n\nsrc/a.rs 3\nsrc/b.rs 2\nsrc/c.rs 1\n",
    )
    .expect("write the temporary baseline");
    let report = Report {
        failures: Vec::new(),
        computed: rows(&[("src/a.rs", 1), ("src/b.rs", 5), ("src/d.rs", 4)]),
        listed: rows(&[("src/a.rs", 3), ("src/b.rs", 2), ("src/c.rs", 1)]),
        test_gates: BTreeMap::new(),
    };
    write_lowered_baseline(&root, &report);
    let text = fs::read_to_string(lists.join(BASELINE)).unwrap_or_default();
    let _ = fs::remove_dir_all(&root);
    assert_eq!(
        text, "# header\n\nsrc/a.rs 1\nsrc/b.rs 2\n",
        "a lowers, b is not raised, stale c is dropped, new d is not added"
    );
}

#[test]
fn the_passing_fixture_scans_as_expected() {
    let tree = fixture("pass");
    let scanned = scan(&tree);
    assert_eq!(
        scanned.sites,
        rows(&[
            ("crates/demo/src/lib.rs", 2),
            ("src/bin/tool/main.rs", 1),
            ("src/both.rs", 1),
            ("src/mac_ui.rs", 1),
            ("src/main.rs", 1),
            ("src/orphan.rs", 1),
            ("src/unix_bits.rs", 3),
        ]),
        "the platform crate and every test-only file are skipped (bin roots and `#[path]` in an \
         inline module are followed); a file reached by a test and a production route, or by none, \
         is scanned"
    );
    assert_eq!(scanned.test_gates, rows(&[("app (src)", 3), ("demo", 3)]));
}

#[test]
fn the_guard_passes_a_clean_tree_and_reports_to_the_step_summary() {
    let summary =
        std::env::temp_dir().join(format!("platform-cfg-summary-{}.md", std::process::id()));
    let _ = fs::remove_file(&summary);
    let (passed, out) = guard_on("pass", Some(&summary));
    let text = fs::read_to_string(&summary).unwrap_or_default();
    let _ = fs::remove_file(&summary);
    assert!(passed, "the passing fixture failed:\n{out}");
    for needle in [
        "8 OS-specific sites in 6 files",
        "OS-gated items in test code (report only): 6",
        "| app (src) | 3 |",
        "| demo | 3 |",
    ] {
        assert!(text.contains(needle), "expected {needle:?} in:\n{text}");
    }
}

#[test]
fn a_file_above_its_baseline_fails() {
    assert_guard_fails(
        "above",
        &[
            "src/main.rs: 2 OS-specific sites, above its baseline of 1",
            "codesense-platform",
        ],
    );
}

#[test]
fn a_file_below_its_baseline_fails_until_lowered() {
    assert_guard_fails(
        "below",
        &[
            "src/main.rs: 1 OS-specific sites, below its baseline of 2",
            "Lower platform_cfg_baseline.txt",
        ],
    );
}

#[test]
fn a_file_with_sites_and_no_row_fails() {
    assert_guard_fails(
        "unlisted",
        &[
            "src/main.rs: 1 OS-specific sites and no baseline row",
            "codesense-platform",
        ],
    );
}

#[test]
fn a_stale_row_fails() {
    assert_guard_fails(
        "stale",
        &[
            "`src/gone.rs` no longer exists; delete the row",
            "`src/main.rs` has no counted sites",
        ],
    );
}

#[test]
fn an_allowlist_row_without_a_reason_fails() {
    assert_guard_fails(
        "empty_reason",
        &[
            "platform_macos_ui_allowlist.txt:2: `src/main.rs` has no reason",
            "platform_caps_allowlist.txt:2: `src/main.rs` has no reason",
        ],
    );
}
