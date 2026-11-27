// SPDX-License-Identifier: MIT
//! No `"main"` window label outside `src/windows/`.
//!
//! The app names its first window through `windows::MAIN_LABEL`, `windows::main_window` and
//! `windows::is_main`, so a second window can never match a stray literal. This guard parses each
//! `.rs` file under `src/` and every `crates/*/src/` with `syn` and fails on a `"main"` string
//! literal in a window-label position:
//!
//! - the label argument of `get_webview_window`, `get_window`, `get_webview` or `emit_to`, as a
//!   method (`app.emit_to("main", ..)`) or a path call (`Emitter::emit_to(&app, "main", ..)`);
//! - the second argument of `WebviewWindowBuilder::new` or `WindowBuilder::new`;
//! - the argument of `EventTarget::labeled`, `window`, `webview` or `webview_window`, and the
//!   `label` field of an `EventTarget` variant;
//! - either side of `==` or `!=`, an `assert_eq!`/`assert_ne!` side, a `matches!` pattern or a
//!   `match` arm against a `.label()` call, a `.label` field, or an identifier ending in `label`
//!   (seen through `.as_str()`, `.as_deref()` and the like);
//! - the value of a `const` or `static` `&str` whose name contains `WINDOW` or `LABEL`.
//!
//! Macro bodies that parse as comma-separated expressions are scanned too. It matches positions,
//! not every literal: most of the app's `"main"` literals are branch names.
//!
//! - **Skipped:** `src/windows/`, test files (`tests.rs`, `*_tests.rs`, anything under a `tests/`
//!   directory), and files and items under `#[test]`, `#[cfg(test)]` or `#[cfg(all(test, ..))]`.
//!   `#[cfg(not(test))]` and `#[cfg(any(.., test))]` code builds into the app, so it is scanned.
//!
//! Std plus `syn`, like the other guards: point `CODESENSE_GUARD_ROOT` at another `src-tauri` to
//! run it on that tree.

use codesense_guards::guard_support::{app_root, source_roots};
use std::fs;
use std::path::{Path, PathBuf};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

/// The one module that may spell the label, relative to the app root.
const WINDOWS_DIR: &str = "src/windows/";

/// Methods whose first argument (second in a path call) is a window label.
const LABEL_METHODS: [&str; 4] = ["get_webview_window", "get_window", "get_webview", "emit_to"];

/// Builders whose second argument is a window label.
const LABEL_BUILDERS: [&str; 2] = ["WebviewWindowBuilder", "WindowBuilder"];

/// `EventTarget` constructors whose argument is a window label.
const TARGET_CONSTRUCTORS: [&str; 4] = ["labeled", "window", "webview", "webview_window"];

/// Calls that leave a string's value as it is.
const PASS_THROUGH: [&str; 7] = [
    "as_str",
    "as_ref",
    "as_deref",
    "to_string",
    "to_owned",
    "into",
    "clone",
];

/// Whether `file` (relative to the app root, `/`-separated) is outside the scan.
fn skipped(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    file.starts_with(WINDOWS_DIR)
        || name == "tests.rs"
        || name.ends_with("_tests.rs")
        || file.split('/').any(|part| part == "tests")
}

/// Whether the cfg predicate holds only in test builds: `test` alone, or an `all(..)` with a
/// test-only member. `not(test)` and `any(.., test)` also hold outside tests.
fn test_only_cfg(predicate: &syn::Meta) -> bool {
    match predicate {
        syn::Meta::Path(path) => path.is_ident("test"),
        syn::Meta::List(list) if list.path.is_ident("all") => list
            .parse_args_with(Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated)
            .is_ok_and(|members| members.iter().any(test_only_cfg)),
        _ => false,
    }
}

/// Whether `attrs` hold `#[test]` or a test-only `#[cfg(..)]`.
fn test_only(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        if path.is_ident("test") {
            return true;
        }
        path.is_ident("cfg")
            && attr
                .parse_args::<syn::Meta>()
                .is_ok_and(|predicate| test_only_cfg(&predicate))
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

/// The expression under any parentheses, references, derefs and [`PASS_THROUGH`] calls.
fn bare(expr: &syn::Expr) -> &syn::Expr {
    match expr {
        syn::Expr::Paren(e) => bare(&e.expr),
        syn::Expr::Reference(e) => bare(&e.expr),
        syn::Expr::Unary(e) if matches!(e.op, syn::UnOp::Deref(_)) => bare(&e.expr),
        syn::Expr::MethodCall(call)
            if call.args.is_empty() && PASS_THROUGH.contains(&call.method.to_string().as_str()) =>
        {
            bare(&call.receiver)
        }
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

/// Whether a `matches!` pattern, parsed as an expression, can match `"main"`.
fn pattern_expr_has_main(expr: &syn::Expr) -> bool {
    match bare(expr) {
        syn::Expr::Binary(e) if matches!(e.op, syn::BinOp::BitOr(_)) => {
            pattern_expr_has_main(&e.left) || pattern_expr_has_main(&e.right)
        }
        syn::Expr::Call(e) => e.args.iter().any(pattern_expr_has_main),
        syn::Expr::Tuple(e) => e.elems.iter().any(pattern_expr_has_main),
        other => is_main_literal(other),
    }
}

/// Whether a `match` arm's pattern can match `"main"`.
fn pattern_has_main(pat: &syn::Pat) -> bool {
    match pat {
        syn::Pat::Lit(lit) => matches!(&lit.lit, syn::Lit::Str(s) if s.value() == "main"),
        syn::Pat::Or(or) => or.cases.iter().any(pattern_has_main),
        syn::Pat::Paren(p) => pattern_has_main(&p.pat),
        syn::Pat::Reference(r) => pattern_has_main(&r.pat),
        syn::Pat::Tuple(t) => t.elems.iter().any(pattern_has_main),
        syn::Pat::TupleStruct(t) => t.elems.iter().any(pattern_has_main),
        syn::Pat::Ident(i) => i
            .subpat
            .as_ref()
            .is_some_and(|(_, sub)| pattern_has_main(sub)),
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
            if let [.., ty, constructor] = segments.as_slice() {
                if ty == "EventTarget"
                    && TARGET_CONSTRUCTORS.contains(&constructor.as_str())
                    && call.args.first().is_some_and(is_main_literal)
                {
                    self.hit(call, &format!("the label of EventTarget::{constructor}"));
                }
            }
            if let [_, .., method] = segments.as_slice() {
                if LABEL_METHODS.contains(&method.as_str())
                    && call.args.iter().nth(1).is_some_and(is_main_literal)
                {
                    self.hit(call, &format!("the label of {method}"));
                }
            }
        }
        visit::visit_expr_call(self, call);
    }

    fn visit_expr_struct(&mut self, expr: &'ast syn::ExprStruct) {
        let target = expr
            .path
            .segments
            .iter()
            .any(|segment| segment.ident == "EventTarget");
        if target {
            for field in &expr.fields {
                if matches!(&field.member, syn::Member::Named(name) if name == "label")
                    && is_main_literal(&field.expr)
                {
                    self.hit(field, "the label of an EventTarget");
                }
            }
        }
        visit::visit_expr_struct(self, expr);
    }

    fn visit_expr_match(&mut self, expr: &'ast syn::ExprMatch) {
        if is_label(&expr.expr) {
            for arm in &expr.arms {
                if pattern_has_main(&arm.pat) {
                    self.hit(&arm.pat, "a label match arm");
                }
            }
        }
        visit::visit_expr_match(self, expr);
    }

    /// `syn` leaves macro tokens unparsed: scan a body that parses as comma-separated
    /// expressions, and the sides of `assert_eq!`, `assert_ne!` and `matches!`.
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let Ok(args) =
            mac.parse_body_with(Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated)
        else {
            return;
        };
        let name = mac
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string())
            .unwrap_or_default();
        let mut sides = args.iter();
        if let (Some(left), Some(right)) = (sides.next(), sides.next()) {
            let compared = match name.as_str() {
                "assert_eq" | "assert_ne" | "debug_assert_eq" | "debug_assert_ne" => {
                    (is_main_literal(left) && is_label(right))
                        || (is_main_literal(right) && is_label(left))
                }
                "matches" => is_label(left) && pattern_expr_has_main(right),
                _ => false,
            };
            if compared {
                self.hit(mac, "a label comparison");
            }
        }
        for arg in &args {
            Visit::visit_expr(self, arg);
        }
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
    let app = app_root();
    let mut files = Vec::new();
    for root in source_roots() {
        rust_files(&root, &mut files);
    }
    let mut scanned = 0;
    let mut hits = Vec::new();
    for path in files {
        let file = path
            .strip_prefix(&app)
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
        app.display()
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
        (
            "fn a(app: &AppHandle) { let _ = app.get_window(\"main\"); }",
            "planted.rs:1: \"main\" as the label of get_window",
        ),
        (
            "fn a(app: &AppHandle) { let _ = app.get_webview(\"main\"); }",
            "planted.rs:1: \"main\" as the label of get_webview",
        ),
        (
            "fn a(app: &App) { tauri::WindowBuilder::new(app, \"main\").build(); }",
            "planted.rs:1: \"main\" as the label of WindowBuilder::new",
        ),
        (
            "fn a(app: &AppHandle) { Emitter::emit_to(app, \"main\", \"evt\", ()).ok(); }",
            "planted.rs:1: \"main\" as the label of emit_to",
        ),
        (
            "fn a(app: &AppHandle) { app.emit_to(EventTarget::labeled(\"main\"), \"e\", ()); }",
            "planted.rs:1: \"main\" as the label of EventTarget::labeled",
        ),
        (
            "fn a() -> EventTarget { EventTarget::webview_window(\"main\") }",
            "planted.rs:1: \"main\" as the label of EventTarget::webview_window",
        ),
        (
            "fn a() -> EventTarget { EventTarget::Window { label: \"main\".into() } }",
            "planted.rs:1: \"main\" as the label of an EventTarget",
        ),
        (
            "fn a(window: &Window) -> bool { \"main\" == window.label() }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "fn a(w: &W) -> bool { w.label == \"main\" }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "fn a(label: String) -> bool { label.as_str() == \"main\" }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "fn a(label: &str) -> u8 { match label { \"main\" => 1, _ => 0 } }",
            "planted.rs:1: \"main\" as a label match arm",
        ),
        (
            "fn a(w: &Window) { assert_eq!(w.label(), \"main\"); }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "fn a(label: &str) -> bool { matches!(label, \"main\" | \"other\") }",
            "planted.rs:1: \"main\" as a label comparison",
        ),
        (
            "fn a(app: &AppHandle) { log!(\"{:?}\", app.get_webview_window(\"main\")); }",
            "planted.rs:1: \"main\" as the label of get_webview_window",
        ),
        (
            "static MAIN_LABEL: &str = \"main\";",
            "planted.rs:1: \"main\" as the value of MAIN_LABEL",
        ),
        (
            "impl Shell { const WINDOW: &'static str = \"main\"; }",
            "planted.rs:1: \"main\" as the value of WINDOW",
        ),
        (
            "#[cfg(not(test))] fn a(app: &AppHandle) { app.get_webview_window(\"main\"); }",
            "planted.rs:1: \"main\" as the label of get_webview_window",
        ),
        (
            "#[cfg(any(target_os = \"macos\", test))] fn a(app: &AppHandle) { app.emit_to(\"main\", \"e\", ()); }",
            "planted.rs:1: \"main\" as the label of emit_to",
        ),
        (
            "#![cfg(not(test))]\nfn a(app: &AppHandle) { app.get_webview_window(\"main\"); }",
            "planted.rs:2: \"main\" as the label of get_webview_window",
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
        "#[cfg(all(unix, test))] fn a(app: &AppHandle) { app.get_webview_window(\"main\"); }",
        "fn a(branch: &str) -> u8 { match branch { \"main\" => 1, _ => 0 } }",
        "fn a(branch: &str) { assert_eq!(branch, \"main\"); git!(\"checkout\", \"main\"); }",
        "// app.get_webview_window(\"main\") in a comment is not a call",
        "#![cfg(test)]\nfn a(app: &AppHandle) { app.get_webview_window(\"main\"); }",
    ];
    for source in negatives {
        assert_eq!(scan("planted.rs", source), Vec::<String>::new(), "{source}");
    }
    assert!(skipped("src/windows/label.rs"));
    assert!(skipped("src/mcp/handler/caller_scope_tests.rs"));
    assert!(skipped("src/context_repo/caller_scope/tests.rs"));
    assert!(!skipped("src/mcp/handler.rs"));
    assert!(!skipped("src/commands/wake.rs"));
    assert!(!skipped("crates/codesense-platform/src/lib.rs"));
}
