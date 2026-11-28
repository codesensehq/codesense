// SPDX-License-Identifier: MIT
//! Group files are written only by the group store.
//!
//! A group file lives at `orgs/<owner>/<repo>/config/groups/<id>.json` in the person's Scratch
//! space, and `groups/store.rs` is its one reader and writer: one lock, a per-file `rev`, the
//! tiles-flag check and the version gate all live in its write entry. This guard parses every
//! production source with `syn` and fails when anything outside the store builds a path into a
//! group folder:
//!
//! - a string literal holding `config/groups` or `groups/` (macro tokens included);
//! - a `join("groups")` or `push("groups")`;
//! - a `const` or `static` whose value is the string `groups`, and an array literal that holds
//!   `"groups"` (`["config", "groups"].iter().collect::<PathBuf>()`);
//! - a `concat!` whose literals join into a group path (`concat!("config/", "groups")`);
//! - a use of the store's `groups_dir` or `GROUPS_DIR`, outside [`ALLOWED`].
//!
//! Test code is skipped: items under a `cfg` that names `test`, `#[test]` functions, and files
//! that only tests include (`*_tests.rs`, `tests.rs`, `tests/`). Point `CODESENSE_GUARD_ROOT` at
//! another checkout's `src-tauri` to run it there; the planted self-tests show each form failing.

use codesense_guards::guard_support;
use proc_macro2::{TokenStream, TokenTree};
use std::path::Path;
use syn::visit::{self, Visit};

/// The store: the one file that may name a group folder.
const STORE: &str = "groups/store.rs";

/// Files other than the store that may name the group folder, each with its reason.
const ALLOWED: &[(&str, &str)] = &[(
    "context_repo/scratch_space.rs",
    "opens the Scratch space for a group write: creates the folder and its `.gitignore` of `*`, \
     never a group file",
)];

/// The names that resolve to a group folder.
const FOLDER_NAMES: &[&str] = &["groups_dir", "GROUPS_DIR"];

fn is_test_file(label: &str) -> bool {
    let name = label.rsplit('/').next().unwrap_or(label);
    name.ends_with("_tests.rs")
        || name == "tests.rs"
        || label.contains("/tests/")
        || label.starts_with("tests/")
}

fn names_test(attrs: &[syn::Attribute]) -> bool {
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
            .clone()
            .into_iter()
            .any(|tree| names_test_token(&tree))
    })
}

fn names_test_token(tree: &TokenTree) -> bool {
    match tree {
        TokenTree::Ident(ident) => ident == "test",
        TokenTree::Group(group) => group.stream().into_iter().any(|t| names_test_token(&t)),
        _ => false,
    }
}

/// Whether `text` names a path into a group folder. A Rust source path such as
/// `src/groups/shape.rs` (a generated file's header names its source) is not one.
fn group_literal(text: &str) -> bool {
    text.contains("config/groups")
        || text.match_indices("groups/").any(|(at, found)| {
            let rest = &text[at + found.len()..];
            let name_len = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            !(name_len > 0 && rest[name_len..].starts_with(".rs"))
        })
}

struct Scan<'a> {
    label: &'a str,
    found: Vec<String>,
}

impl Scan<'_> {
    fn flag(&mut self, span: proc_macro2::Span, what: String) {
        let line = span.start().line;
        self.found.push(format!("{}:{line}: {what}", self.label));
    }

    /// `expr` is the string `groups`: the folder's name held in a constant or a list of segments.
    fn named_folder(&mut self, expr: &syn::Expr) {
        if let syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Str(lit),
            ..
        }) = expr
        {
            if lit.value() == "groups" {
                self.flag(
                    lit.span(),
                    "the folder name \"groups\" held in a value".into(),
                );
            }
        }
    }

    /// A `concat!` whose string literals join into a group path.
    fn concat(&mut self, mac: &syn::Macro) {
        let joined: String = mac
            .tokens
            .clone()
            .into_iter()
            .filter_map(|tree| match tree {
                TokenTree::Literal(literal) => syn::parse_str::<syn::LitStr>(&literal.to_string())
                    .ok()
                    .map(|lit| lit.value()),
                _ => None,
            })
            .collect();
        if group_literal(&joined) {
            self.flag(
                mac.path.segments[0].ident.span(),
                format!("`concat!` joining {joined:?}"),
            );
        }
    }

    fn tokens(&mut self, stream: TokenStream) {
        for tree in stream {
            match tree {
                TokenTree::Group(group) => self.tokens(group.stream()),
                TokenTree::Literal(literal) => {
                    let text = literal.to_string();
                    if group_literal(&text) {
                        self.flag(literal.span(), format!("literal {text} in a macro"));
                    }
                }
                TokenTree::Ident(ident) => {
                    if FOLDER_NAMES.iter().any(|name| ident == name) {
                        self.flag(ident.span(), format!("`{ident}` in a macro"));
                    }
                }
                TokenTree::Punct(_) => {}
            }
        }
    }
}

impl<'ast> Visit<'ast> for Scan<'_> {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        let attrs = match item {
            syn::Item::Fn(f) => &f.attrs,
            syn::Item::Mod(m) => &m.attrs,
            syn::Item::Impl(i) => &i.attrs,
            syn::Item::Const(c) => &c.attrs,
            syn::Item::Static(s) => &s.attrs,
            syn::Item::Struct(s) => &s.attrs,
            syn::Item::Enum(e) => &e.attrs,
            syn::Item::Use(u) => &u.attrs,
            syn::Item::Macro(m) => &m.attrs,
            syn::Item::Trait(t) => &t.attrs,
            _ => return visit::visit_item(self, item),
        };
        if !names_test(attrs) {
            visit::visit_item(self, item);
        }
    }

    /// Doc comments and attributes describe; they never build a path.
    fn visit_attribute(&mut self, _: &'ast syn::Attribute) {}

    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        if !names_test(&f.attrs) {
            visit::visit_impl_item_fn(self, f);
        }
    }

    fn visit_lit_str(&mut self, lit: &'ast syn::LitStr) {
        let text = lit.value();
        if group_literal(&text) {
            self.flag(lit.span(), format!("literal {text:?}"));
        }
    }

    fn visit_item_const(&mut self, item: &'ast syn::ItemConst) {
        self.named_folder(&item.expr);
        visit::visit_item_const(self, item);
    }

    fn visit_item_static(&mut self, item: &'ast syn::ItemStatic) {
        self.named_folder(&item.expr);
        visit::visit_item_static(self, item);
    }

    fn visit_expr_array(&mut self, array: &'ast syn::ExprArray) {
        for elem in &array.elems {
            self.named_folder(elem);
        }
        visit::visit_expr_array(self, array);
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        let joins = call.method == "join" || call.method == "push";
        if let (true, Some(syn::Expr::Lit(arg))) = (joins, call.args.first()) {
            if let syn::Lit::Str(lit) = &arg.lit {
                if lit.value() == "groups" {
                    let method = &call.method;
                    self.flag(lit.span(), format!("`{method}(\"groups\")`"));
                }
            }
        }
        visit::visit_expr_method_call(self, call);
    }

    fn visit_path(&mut self, path: &'ast syn::Path) {
        if let Some(last) = path.segments.last() {
            if FOLDER_NAMES.iter().any(|name| last.ident == name) {
                self.flag(last.ident.span(), format!("`{}`", last.ident));
            }
        }
        visit::visit_path(self, path);
    }

    fn visit_use_name(&mut self, name: &'ast syn::UseName) {
        if FOLDER_NAMES.iter().any(|folder| name.ident == folder) {
            self.flag(name.ident.span(), format!("`use … {}`", name.ident));
        }
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac.path.is_ident("concat") {
            self.concat(mac);
        }
        self.tokens(mac.tokens.clone());
        visit::visit_macro(self, mac);
    }
}

/// What `src` (labelled `label`, relative to its source root) does that only the store may.
fn violations(label: &str, src: &str) -> Vec<String> {
    if label == STORE || is_test_file(label) {
        return vec![];
    }
    let file = syn::parse_file(src).unwrap_or_else(|e| panic!("parse {label}: {e}"));
    if names_test(&file.attrs) {
        return vec![];
    }
    let mut scan = Scan {
        label,
        found: vec![],
    };
    scan.visit_file(&file);
    if ALLOWED.iter().any(|(allowed, _)| *allowed == label) {
        // An allowed file may name the folder, never a file in it.
        scan.found.retain(|f| {
            !FOLDER_NAMES
                .iter()
                .any(|name| f.ends_with(&format!("`{name}`")))
        });
    }
    scan.found
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn group_files_are_written_only_by_the_store() {
    let mut files = vec![];
    for root in guard_support::source_roots() {
        rust_files(&root, &mut files);
    }
    files.sort();
    let mut found = vec![];
    let mut saw_store = false;
    for file in &files {
        let label = guard_support::source_label(file);
        saw_store |= label == STORE;
        let src = std::fs::read_to_string(file).unwrap();
        found.extend(violations(&label, &src));
    }
    assert!(saw_store, "{STORE} is where the guard expects the store");
    for (allowed, _) in ALLOWED {
        assert!(
            files
                .iter()
                .any(|f| guard_support::source_label(f) == *allowed),
            "allowed {allowed} is gone; drop its entry"
        );
    }
    assert!(
        found.is_empty(),
        "only {STORE} builds a path into a group folder; route these through the store:\n{}",
        found.join("\n")
    );
}

#[test]
fn planted_writers_are_caught() {
    let planted = [
        r#"fn f(p: &std::path::Path) { std::fs::write(p.join("config/groups/main.json"), b""); }"#,
        r#"fn f(p: &std::path::Path) { let _ = p.join("config").join("groups"); }"#,
        r#"fn f(p: &mut std::path::PathBuf) { p.push("groups"); }"#,
        r#"fn f(s: &S) { let _ = crate::groups::store::groups_dir(s); }"#,
        r#"use crate::groups::store::groups_dir;"#,
        r#"fn f() -> String { format!("{}/groups/{}", "a", "b") }"#,
        r#"fn f() { let _ = vec![groups_dir(&s)]; }"#,
        r#"const P: &str = "orgs/a/b/config/groups";"#,
        r#"const G: &str = "groups"; fn f(d: &std::path::Path) { let _ = d.join("config").join(G); }"#,
        r#"static G: &str = "groups";"#,
        r#"fn f() -> &'static str { concat!("config/", "groups") }"#,
        r#"fn f() -> &'static str { concat!("config", "/", "groups", "/x") }"#,
        r#"fn f() -> std::path::PathBuf { ["config", "groups"].iter().collect::<std::path::PathBuf>() }"#,
        r#"fn f() { let g = "groups"; let _ = [g, "x"]; let _ = ["groups"]; }"#,
    ];
    for src in planted {
        assert!(!violations("elsewhere.rs", src).is_empty(), "missed: {src}");
    }
}

#[test]
fn the_store_tests_and_allowed_uses_pass() {
    let writer =
        r#"fn f(p: &std::path::Path) { std::fs::write(p.join("config/groups/x.json"), b""); }"#;
    assert!(violations(STORE, writer).is_empty());
    assert!(violations("groups/store_tests.rs", writer).is_empty());
    let in_test = format!("#[cfg(test)] mod tests {{ {writer} }}");
    assert!(violations("elsewhere.rs", &in_test).is_empty());
    let in_test_fn = r#"#[test] fn t() { let _ = "config/groups/x.json"; }"#;
    assert!(violations("elsewhere.rs", in_test_fn).is_empty());
    let opener = "fn open(s: &S) { let _ = crate::groups::store::groups_dir(s); }";
    assert!(violations("context_repo/scratch_space.rs", opener).is_empty());
    assert!(
        !violations("context_repo/scratch_space.rs", writer).is_empty(),
        "an allowed file still may not name a group file"
    );
    let header =
        r#"const H: &str = "// Generated from src-tauri/src/groups/shape.rs. Do not edit.\n";"#;
    assert!(
        violations("groups/shape.rs", header).is_empty(),
        "a source path is no group path"
    );
    for still in [
        r#"const P: &str = "groups/shape.json";"#,
        r#"const P: &str = "src/groups/shape.rs and groups/main.json";"#,
        r#"const P: &str = "groups/";"#,
    ] {
        assert!(
            !violations("elsewhere.rs", still).is_empty(),
            "missed: {still}"
        );
    }
    let benign_concat = r#"fn f() -> &'static str { concat!("work", "spaces") }"#;
    assert!(violations("elsewhere.rs", benign_concat).is_empty());
    let documented = "/// Writes `config/groups/<id>.json`.\nfn f() {}";
    assert!(violations("elsewhere.rs", documented).is_empty());
    let unrelated =
        r#"fn f() { let _ = serde_json::json!({ "groups": [] }); let _ = "workspace groups"; }"#;
    assert!(violations("elsewhere.rs", unrelated).is_empty());
}
