// SPDX-License-Identifier: MIT
//! No `"main"` window label outside `src/windows/`.
//!
//! The app names its first window through `windows::MAIN_LABEL`, `windows::main_window` and
//! `windows::is_main`, so a second window can never match a stray literal. This guard parses each
//! `.rs` file under `src/` with `syn` and fails on a `"main"` string literal in a window-label
//! position:
//!
//! - the first argument of `get_webview_window`, `get_window`, `get_webview` or `emit_to`;
//! - the second argument of `WebviewWindowBuilder::new` or `WindowBuilder::new`;
//! - either side of `==` or `!=` against a `.label()` call, a `.label` field, or an identifier
//!   ending in `label`;
//! - the value of a `const` or `static` `&str` whose name contains `WINDOW` or `LABEL`.
//!
//! It matches positions, not every literal: most of the app's `"main"` literals are branch names.
//!
//! - **Skipped:** `src/windows/`, test files (`tests.rs`, `*_tests.rs`, anything under a `tests/`
//!   directory), and files and items under `#[cfg(test)]` or `#[test]`.
//!
//! Std plus `syn`, like the other guards: point `CODESENSE_GUARD_ROOT` at another `src-tauri` to
//! run it on that tree.

use codesense_guards::guard_support::app_root;
use std::fs;
use std::path::{Path, PathBuf};
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

/// The one module that may spell the label.
const WINDOWS_DIR: &str = "windows/";

/// Methods whose first argument is a window label.
const LABEL_METHODS: [&str; 4] = ["get_webview_window", "get_window", "get_webview", "emit_to"];

/// Builders whose second argument is a window label.
const LABEL_BUILDERS: [&str; 2] = ["WebviewWindowBuilder", "WindowBuilder"];

/// Whether `file` (relative to `src/`, `/`-separated) is outside the scan.
fn skipped(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    file.starts_with(WINDOWS_DIR)
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

/// The expression under any parentheses, references and derefs.
fn bare(expr: &syn::Expr) -> &syn::Expr {
    match expr {
        syn::Expr::Paren(e) => bare(&e.expr),
        syn::Expr::Reference(e) => bare(&e.expr),
        syn::Expr::Unary(e) if matches!(e.op, syn::UnOp::Deref(_)) => bare(&e.expr),
        _ => expr,
    }
}

fn is_main_literal(expr: &syn::Expr) -> bool {
    matches!(
        bare(expr),
        syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(s), .. }) if s.value() == "main"
    )
}

/// A `.label()` call, a `.label` field, or a path whose last segment ends in `label`.
fn is_label(expr: &syn::Expr) -> bool {
    match bare(expr) {
        syn::Expr::MethodCall(call) => call.method == "label",
        syn::Expr::Field(field) => {
            matches!(&field.member, syn::Member::Named(name) if name.to_string().ends_with("label"))
        }
        syn::Expr::Path(path) => path
            .path
            .segments
            .last()
            .is_some_and(|segment| segment.ident.to_string().to_lowercase().ends_with("label")),
        _ => false,
    }
}

fn is_label_const(ident: &syn::Ident, value: &syn::Expr) -> bool {
    let name = ident.to_string();
    (name.contains("WINDOW") || name.contains("LABEL")) && is_main_literal(value)
}

struct Scan<'a> {
    file: &'a str,
    hits: Vec<String>,
}

impl Scan<'_> {
    fn hit(&mut self, node: &impl Spanned, position: &str) {
        let line = node.span().start().line;
        self.hits
            .push(format!("{}:{line}: \"main\" as {position}", self.file));
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

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        let method = call.method.to_string();
        if LABEL_METHODS.contains(&method.as_str())
            && call.args.first().is_some_and(is_main_literal)
        {
            self.hit(call, &format!("the label of {method}"));
        }
        visit::visit_expr_method_call(self, call);
    }

    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(func) = bare(&call.func) {
            let segments: Vec<String> = func
                .path
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect();
            let builder = match segments.as_slice() {
                [.., ty, new] if new == "new" => LABEL_BUILDERS.iter().find(|b| **b == ty.as_str()),
                _ => None,
            };
            if let Some(builder) = builder {
                if call.args.iter().nth(1).is_some_and(is_main_literal) {
                    self.hit(call, &format!("the label of {builder}::new"));
                }
            }
        }
        visit::visit_expr_call(self, call);
    }

    fn visit_expr_binary(&mut self, binary: &'ast syn::ExprBinary) {
        if matches!(binary.op, syn::BinOp::Eq(_) | syn::BinOp::Ne(_))
            && ((is_main_literal(&binary.left) && is_label(&binary.right))
                || (is_main_literal(&binary.right) && is_label(&binary.left)))
        {
            self.hit(binary, "a label comparison");
        }
        visit::visit_expr_binary(self, binary);
    }

    fn visit_item_const(&mut self, item: &'ast syn::ItemConst) {
        if is_label_const(&item.ident, &item.expr) {
            self.hit(item, &format!("the value of {}", item.ident));
        }
        visit::visit_item_const(self, item);
    }

    fn visit_item_static(&mut self, item: &'ast syn::ItemStatic) {
        if is_label_const(&item.ident, &item.expr) {
            self.hit(item, &format!("the value of {}", item.ident));
        }
        visit::visit_item_static(self, item);
    }

    fn visit_impl_item_const(&mut self, item: &'ast syn::ImplItemConst) {
        if is_label_const(&item.ident, &item.expr) {
            self.hit(item, &format!("the value of {}", item.ident));
        }
        visit::visit_impl_item_const(self, item);
    }
}

/// The label positions in one file's source. `file` is relative to `src/`.
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
fn no_main_window_label_outside_the_windows_module() {
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
        "name the main window through crate::windows (MAIN_LABEL, main_window, is_main):\n{}",
        hits.join("\n")
    );
}

#[test]
fn the_windows_module_holds_the_label() {
    let label = app_root().join("src/windows/label.rs");
    let source = fs::read_to_string(&label).unwrap();
    assert_eq!(
        scan("label.rs", &source).len(),
        1,
        "MAIN_LABEL is the one spelling"
    );
}

#[test]
fn fails_each_label_position() {
    let planted = [
        (
            "fn a(app: &AppHandle) { let _ = app.get_webview_window(\"main\"); }",
            "planted.rs:1: \"main\" as the label of get_webview_window",
        ),
        (
            "fn a(app: &AppHandle) { app.emit_to(\"main\", \"evt\", ()).ok(); }",
            "planted.rs:1: \"main\" as the label of emit_to",
        ),
        (
            "fn a(app: &App) { tauri::WebviewWindowBuilder::new(app, \"main\", url).build(); }",
            "planted.rs:1: \"main\" as the label of WebviewWindowBuilder::new",
        ),
        (
            "fn a(window: &Window) -> bool { window.label() == \"main\" }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "fn a(label: &str) -> bool { label != \"main\" }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "const PERSON_WINDOW: &str = \"main\";",
            "planted.rs:1: \"main\" as the value of PERSON_WINDOW",
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
fn passes_branch_names_test_code_and_the_windows_module() {
    let negatives = [
        "fn a(repo: &Repo) { repo.checkout(\"main\"); let _ = branch == \"main\"; }",
        "const DEFAULT_BRANCH: &str = \"main\";",
        "#[cfg(test)] mod tests { fn a(app: &AppHandle) { app.get_webview_window(\"main\"); } }",
        "#[test] fn a() { assert!(window.label() == \"main\"); }",
        "impl S { #[cfg(all(test, unix))] fn a(&self) { self.app.emit_to(\"main\", \"e\", ()); } }",
        "// app.get_webview_window(\"main\") in a comment is not a call",
        "#![cfg(test)]\nfn a(app: &AppHandle) { app.get_webview_window(\"main\"); }",
    ];
    for source in negatives {
        assert_eq!(scan("planted.rs", source), Vec::<String>::new(), "{source}");
    }
    assert!(skipped("windows/label.rs"));
    assert!(skipped("mcp/handler/caller_scope_tests.rs"));
    assert!(skipped("context_repo/caller_scope/tests.rs"));
    assert!(!skipped("mcp/handler.rs"));
    assert!(!skipped("commands/wake.rs"));
}
