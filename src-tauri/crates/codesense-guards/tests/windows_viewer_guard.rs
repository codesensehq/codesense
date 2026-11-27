// SPDX-License-Identifier: MIT
//! No terminal viewer id spelled outside `commands/pty_viewer.rs`.
//!
//! Each window is its own viewer on a terminal host, and `commands::pty_viewer` derives the ids
//! (`viewer_for`, `viewport_for`, `main_viewer`, the boot slots). A site that spells `main`'s ids
//! itself would act as `main` from any window. This guard parses each `.rs` file under `src/`
//! with `syn` and fails on:
//!
//! - a call of `app_viewer`, or any `app_viewer` or `WEBVIEW_BOOT` name;
//! - `ViewerId::new("app")` or `ViewportId::new("webview")`;
//! - any of those inside a macro's tokens.
//!
//! - **Skipped:** `commands/pty_viewer.rs`, test files (`tests.rs`, `*_tests.rs`, anything under a
//!   `tests/` directory), and files and items under `#[cfg(test)]` or `#[test]`.
//!
//! Std plus `syn`, like the other guards: point `CODESENSE_GUARD_ROOT` at another `src-tauri` to
//! run it on that tree.

use codesense_guards::guard_support::app_root;
use std::fs;
use std::path::{Path, PathBuf};
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

/// The one module that may spell the ids.
const HELPER: &str = "commands/pty_viewer.rs";

/// Names that only the helper's predecessors used.
const RETIRED_NAMES: [&str; 2] = ["app_viewer", "WEBVIEW_BOOT"];

/// `<Type>::new(<literal>)` constructors that spell `main`'s ids.
const SPELLED_IDS: [(&str, &str); 2] = [("ViewerId", "app"), ("ViewportId", "webview")];

/// Whether `file` (relative to `src/`, `/`-separated) is outside the scan.
fn skipped(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    file == HELPER
        || name == "tests.rs"
        || name.ends_with("_tests.rs")
        || file.split('/').any(|part| part == "tests")
}

/// Whether `attrs` hold `#[test]` or a `#[cfg(..)]` that names `test`.
fn test_only(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        if path.is_ident("test") {
            return true;
        }
        if !path.is_ident("cfg") {
            return false;
        }
        let syn::Meta::List(list) = &attr.meta else {
            return false;
        };
        list.tokens
            .to_string()
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .any(|word| word == "test")
    })
}

fn item_attrs(item: &syn::Item) -> &[syn::Attribute] {
    match item {
        syn::Item::Const(i) => &i.attrs,
        syn::Item::Enum(i) => &i.attrs,
        syn::Item::Fn(i) => &i.attrs,
        syn::Item::Impl(i) => &i.attrs,
        syn::Item::Macro(i) => &i.attrs,
        syn::Item::Mod(i) => &i.attrs,
        syn::Item::Static(i) => &i.attrs,
        syn::Item::Struct(i) => &i.attrs,
        syn::Item::Trait(i) => &i.attrs,
        syn::Item::Use(i) => &i.attrs,
        _ => &[],
    }
}

/// The expression under any parentheses and references.
fn bare(expr: &syn::Expr) -> &syn::Expr {
    match expr {
        syn::Expr::Paren(e) => bare(&e.expr),
        syn::Expr::Reference(e) => bare(&e.expr),
        _ => expr,
    }
}

/// The id a `<Type>::new("<literal>")` call spells, if it is one of `SPELLED_IDS`.
fn spelled_id(call: &syn::ExprCall) -> Option<String> {
    let syn::Expr::Path(func) = bare(&call.func) else {
        return None;
    };
    let segments: Vec<String> = func
        .path
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect();
    let [.., ty, new] = segments.as_slice() else {
        return None;
    };
    if new != "new" || call.args.len() != 1 {
        return None;
    }
    let syn::Expr::Lit(syn::ExprLit {
        lit: syn::Lit::Str(value),
        ..
    }) = bare(&call.args[0])
    else {
        return None;
    };
    SPELLED_IDS
        .iter()
        .find(|(id_type, id)| ty == id_type && value.value() == *id)
        .map(|(id_type, id)| format!("{id_type}::new(\"{id}\")"))
}

/// The spellings a macro's tokens hold, compared with all whitespace removed.
fn macro_spellings(tokens: &str) -> Vec<String> {
    let flat: String = tokens.chars().filter(|c| !c.is_whitespace()).collect();
    let mut found: Vec<String> = RETIRED_NAMES
        .iter()
        .filter(|name| {
            flat.match_indices(**name).any(|(at, _)| {
                let before = flat[..at].chars().next_back();
                let after = flat[at + name.len()..].chars().next();
                !before.is_some_and(|c| c.is_alphanumeric() || c == '_')
                    && !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
            })
        })
        .map(|name| name.to_string())
        .collect();
    for (id_type, id) in SPELLED_IDS {
        let spelled = format!("{id_type}::new(\"{id}\")");
        if flat.contains(&spelled) {
            found.push(spelled);
        }
    }
    found
}

struct Scan<'a> {
    file: &'a str,
    hits: Vec<String>,
}

impl Scan<'_> {
    fn hit(&mut self, node: &impl Spanned, spelling: &str) {
        let line = node.span().start().line;
        self.hits.push(format!("{}:{line}: {spelling}", self.file));
    }
}

impl<'ast> Visit<'ast> for Scan<'_> {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        if !test_only(item_attrs(item)) {
            visit::visit_item(self, item);
        }
    }

    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        if !test_only(&item.attrs) {
            visit::visit_impl_item_fn(self, item);
        }
    }

    fn visit_stmt(&mut self, stmt: &'ast syn::Stmt) {
        let attrs: &[syn::Attribute] = match stmt {
            syn::Stmt::Local(local) => &local.attrs,
            syn::Stmt::Macro(mac) => &mac.attrs,
            _ => &[],
        };
        if !test_only(attrs) {
            visit::visit_stmt(self, stmt);
        }
    }

    fn visit_ident(&mut self, ident: &'ast proc_macro2::Ident) {
        if RETIRED_NAMES.iter().any(|name| ident == name) {
            self.hit(ident, &ident.to_string());
        }
    }

    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let Some(spelling) = spelled_id(call) {
            self.hit(call, &spelling);
        }
        visit::visit_expr_call(self, call);
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        for spelling in macro_spellings(&mac.tokens.to_string()) {
            self.hit(mac, &spelling);
        }
        visit::visit_macro(self, mac);
    }
}

/// The viewer id spellings in one file's source. `file` is relative to `src/`.
fn scan(file: &str, source: &str) -> Vec<String> {
    let parsed = syn::parse_file(source).unwrap_or_else(|error| panic!("parse {file}: {error}"));
    let mut scan = Scan {
        file,
        hits: Vec::new(),
    };
    if !test_only(&parsed.attrs) {
        scan.visit_file(&parsed);
    }
    scan.hits
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| entry.expect("read entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_viewer_id_spelled_outside_the_viewer_helper() {
    let src = app_root().join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut scanned = 0;
    let mut hits = Vec::new();
    for path in files {
        let file = path
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if skipped(&file) {
            continue;
        }
        scanned += 1;
        let source = fs::read_to_string(&path).unwrap();
        hits.extend(scan(&file, &source));
    }
    assert!(
        scanned > 100,
        "scanned only {scanned} files under {}",
        src.display()
    );
    assert!(
        hits.is_empty(),
        "derive terminal viewer ids through crate::commands::pty_viewer \
         (viewer_for, viewport_for, main_viewer, boots):\n{}",
        hits.join("\n")
    );
}

#[test]
fn the_helper_exists_where_the_guard_skips() {
    assert!(app_root().join("src").join(HELPER).is_file(), "{HELPER}");
}

#[test]
fn fails_each_spelling() {
    let planted = [
        (
            "fn a() { host.focus(&app_viewer(), &key); }",
            "planted.rs:1: app_viewer",
        ),
        (
            "fn a() { let v = codesense_pty_core::domain::ViewerId::new(\"app\"); }",
            "planted.rs:1: ViewerId::new(\"app\")",
        ),
        (
            "fn a() { subscribe(&app, &id, &ViewportId::new(\"webview\")); }",
            "planted.rs:1: ViewportId::new(\"webview\")",
        ),
        (
            "fn a() -> Option<Boot> { WEBVIEW_BOOT.lock().clone() }",
            "planted.rs:1: WEBVIEW_BOOT",
        ),
        (
            "#[cfg(test)]\nmod x;\nfn a() { host.focus(&app_viewer(), &key); }",
            "planted.rs:3: app_viewer",
        ),
        (
            "fn a() { assert!(host.is_owner(&ViewerId :: new (\"app\"))); }",
            "planted.rs:1: ViewerId::new(\"app\")",
        ),
    ];
    for (source, expected) in planted {
        assert_eq!(
            scan("planted.rs", source),
            vec![expected.to_owned()],
            "{source}"
        );
    }
}

#[test]
fn passes_test_code_the_helper_comments_and_strings() {
    let negatives = [
        "#[cfg(test)] mod tests { fn a() { host.focus(&ViewerId::new(\"app\"), &key); } }",
        "#[test] fn a() { subscribe(&app, &id, &ViewportId::new(\"webview\")); }",
        "impl S { #[cfg(all(test, unix))] fn a(&self) { self.f(&app_viewer()); } }",
        "// host.focus(&app_viewer(), &key) in a comment is not a call",
        "fn a() -> &'static str { \"ViewerId::new(\\\"app\\\") and WEBVIEW_BOOT\" }",
        "fn a() { let v = ViewerId::new(\"dashboard\"); let w = ViewportId::new(\"mcp\"); }",
        "fn a() { tracing::info!(viewer = %main_viewer(), \"read\"); }",
        "#![cfg(test)]\nfn a() { host.focus(&app_viewer(), &key); }",
    ];
    for source in negatives {
        assert_eq!(scan("planted.rs", source), Vec::<String>::new(), "{source}");
    }
    assert!(skipped("commands/pty_viewer.rs"));
    assert!(skipped("commands/pty_backend/rm4f_reservation_tests.rs"));
    assert!(skipped(
        "commands/pty_backend/tests/hook_trust_respawn_tests.rs"
    ));
    assert!(skipped("terminal/session_server/tests.rs"));
    assert!(!skipped("commands/pty_backend.rs"));
    assert!(!skipped("commands/pty_viewer_extra.rs"));
}
