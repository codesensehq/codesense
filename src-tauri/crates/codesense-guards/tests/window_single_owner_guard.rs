// SPDX-License-Identifier: MIT
//! One router, one return path and one target resolver for the app's windows.
//!
//! - **One of each.** `route_path_event`, `return_by_kind` and `resolve_target` are each
//!   defined exactly once, under `src/windows/`. A same-named `fn` anywhere else in `src/` or a
//!   `crates/*/src/` fails, unless [`ALLOWED`] names it with its reason. The frontend under
//!   `../src` defines no function or binding in either spelling (`routePathEvent`, ...), past
//!   [`TS_ALLOWED`].
//! - **One sender.** No code outside `src/windows/router.rs` calls `emit`, `emit_to` or
//!   `emit_filter` (method or path call) with the literal `"context-file-change"`: it sends
//!   through `windows::router::emit_path_event`, which picks the windows. The call is parsed
//!   with `syn`, so spacing and line breaks do not hide it.
//! - **Skipped:** test files (`*tests.rs`, anything under a `tests/` directory, and frontend
//!   `*.test.*` / `*.spec.*` files and `src/test/`), and items under `#[test]` or `#[cfg(test)]`.
//!
//! Std plus `syn`, like the other guards: point `CODESENSE_GUARD_ROOT` at another `src-tauri` to
//! run it on that tree. The seeded cases live under `tests/fixtures/window_single_owner/`.

use codesense_guards::guard_support::{app_root, resolve, source_roots};
use std::fs;
use std::path::{Path, PathBuf};
use syn::punctuated::Punctuated;
use syn::visit::{self, Visit};

/// The functions the windows module defines once, and their frontend spellings.
const OWNED: [(&str, &str); 3] = [
    ("route_path_event", "routePathEvent"),
    ("return_by_kind", "returnByKind"),
    ("resolve_target", "resolveTarget"),
];

/// Where the one definition of each lives, relative to the app root.
const WINDOWS_DIR: &str = "src/windows/";

/// The one file that may send the event.
const ROUTER: &str = "src/windows/router.rs";

const EVENT: &str = "context-file-change";

/// The `Emitter` calls that send an event.
const EMITS: [&str; 3] = ["emit", "emit_to", "emit_filter"];

/// Same-named Rust functions that pick no window: `(file, name, why)`.
const ALLOWED: [(&str, &str, &str); 2] = [
    (
        "src/commands/remote_source.rs",
        "resolve_target",
        "resolves the SSH target of a remote source, not a window",
    ),
    (
        "src/dashboard_publish/create.rs",
        "resolve_target",
        "resolves the publish target of a dashboard folder, not a window",
    ),
];

/// Same-named frontend functions that pick no window: `(file under ../src, name, why)`.
const TS_ALLOWED: [(&str, &str, &str); 1] = [(
    "features/machines/components/quick-add-machine.tsx",
    "resolveTarget",
    "resolves a typed machine address, not a window",
)];

/// Whether a Rust file (relative to the app root, `/`-separated) is test code.
fn rust_test_file(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.ends_with("tests.rs") || file.split('/').any(|part| part == "tests")
}

/// Whether a frontend file (relative to `../src`) is test code.
fn ts_test_file(file: &str) -> bool {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.contains(".test.") || name.contains(".spec.") || file.starts_with("test/")
}

/// Whether the cfg predicate holds only in test builds: `test` alone, or an `all(..)` with a
/// test-only member.
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
        path.is_ident("test")
            || (path.is_ident("cfg")
                && attr
                    .parse_args::<syn::Meta>()
                    .is_ok_and(|predicate| test_only_cfg(&predicate)))
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

/// Whether `expr`, under references and parentheses, is the event's literal.
fn is_event_literal(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Paren(e) => is_event_literal(&e.expr),
        syn::Expr::Reference(e) => is_event_literal(&e.expr),
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Str(s),
            ..
        }) => s.value() == EVENT,
        _ => false,
    }
}

/// What one Rust file defines and sends, outside test code.
#[derive(Default)]
struct RustScan {
    /// Owned names defined here.
    defines: Vec<String>,
    /// Lines of the event's emit calls.
    emits: Vec<usize>,
}

impl RustScan {
    fn define(&mut self, ident: &syn::Ident) {
        let name = ident.to_string();
        if OWNED.iter().any(|(rust, _)| *rust == name) {
            self.defines.push(name);
        }
    }

    fn emit<'a>(
        &mut self,
        name: &syn::Ident,
        mut args: impl Iterator<Item = &'a syn::Expr>,
        line: usize,
    ) {
        if EMITS.contains(&name.to_string().as_str()) && args.any(is_event_literal) {
            self.emits.push(line);
        }
    }
}

impl<'ast> Visit<'ast> for RustScan {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        if !test_only(item_attrs(item)) {
            visit::visit_item(self, item);
        }
    }

    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        self.define(&item.sig.ident);
        visit::visit_item_fn(self, item);
    }

    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        if test_only(&item.attrs) {
            return;
        }
        self.define(&item.sig.ident);
        visit::visit_impl_item_fn(self, item);
    }

    fn visit_trait_item_fn(&mut self, item: &'ast syn::TraitItemFn) {
        if test_only(&item.attrs) {
            return;
        }
        self.define(&item.sig.ident);
        visit::visit_trait_item_fn(self, item);
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        let line = call.method.span().start().line;
        self.emit(&call.method, call.args.iter(), line);
        visit::visit_expr_method_call(self, call);
    }

    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(path) = &*call.func {
            if let Some(last) = path.path.segments.last() {
                let line = last.ident.span().start().line;
                self.emit(&last.ident, call.args.iter(), line);
            }
        }
        visit::visit_expr_call(self, call);
    }
}

/// A file to scan: its path relative to its root, and its source.
struct Source {
    file: String,
    text: String,
}

fn source(file: &str, text: String) -> Source {
    Source {
        file: file.to_owned(),
        text,
    }
}

fn scan_rust(file: &str, text: &str) -> RustScan {
    let parsed = syn::parse_file(text).unwrap_or_else(|error| panic!("parse {file}: {error}"));
    let mut scan = RustScan::default();
    if !test_only(&parsed.attrs) {
        scan.visit_file(&parsed);
    }
    scan
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// The identifiers of `text` with their byte offsets.
fn identifiers(text: &str) -> Vec<(usize, &str)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if is_ident_byte(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_ident_byte(bytes[i]) {
                i += 1;
            }
            out.push((start, &text[start..i]));
        } else {
            i += 1;
        }
    }
    out
}

/// The owned names (either spelling) a frontend file defines: `function name`, or a
/// `const`/`let`/`var` binding of the name.
fn ts_defines(text: &str) -> Vec<String> {
    let names: Vec<&str> = OWNED.iter().flat_map(|(r, t)| [*r, *t]).collect();
    let ids = identifiers(text);
    let mut out = Vec::new();
    for pair in ids.windows(2) {
        let [(_, keyword), (at, name)] = pair else {
            continue;
        };
        if !names.contains(name) {
            continue;
        }
        let rest = text[at + name.len()..].trim_start();
        let binding = matches!(*keyword, "const" | "let" | "var")
            && (rest.starts_with('=') || rest.starts_with(':'));
        if *keyword == "function" || binding {
            out.push((*name).to_owned());
        }
    }
    out
}

/// Every rule broken by the Rust sources `rust` (relative to the app root) and the frontend
/// sources `ts` (relative to `../src`).
fn violations(rust: &[Source], ts: &[Source]) -> Vec<String> {
    let mut found = Vec::new();
    let mut owned: Vec<(String, String)> = Vec::new();
    for Source { file, text } in rust {
        if rust_test_file(file) {
            continue;
        }
        let scan = scan_rust(file, text);
        for name in scan.defines {
            owned.push((file.clone(), name));
        }
        if file != ROUTER {
            for line in scan.emits {
                found.push(format!(
                    "{file}:{line}: sends {EVENT:?}; send it through windows::router::emit_path_event"
                ));
            }
        }
    }
    for (rust_name, _) in OWNED {
        let mut inside = 0;
        for (file, name) in &owned {
            if name != rust_name {
                continue;
            }
            if file.starts_with(WINDOWS_DIR) {
                inside += 1;
            } else if !ALLOWED.iter().any(|(f, n, _)| f == file && n == name) {
                found.push(format!(
                    "{file}: defines `{name}`, which only {WINDOWS_DIR} defines"
                ));
            }
        }
        if inside != 1 {
            found.push(format!(
                "{WINDOWS_DIR} defines `{rust_name}` {inside} times; it defines it once"
            ));
        }
    }
    for Source { file, text } in ts {
        if ts_test_file(file) {
            continue;
        }
        for name in ts_defines(text) {
            if !TS_ALLOWED.iter().any(|(f, n, _)| f == file && *n == name) {
                found.push(format!(
                    "src/{file}: defines `{name}`; the windows module in Rust is the one owner"
                ));
            }
        }
    }
    found
}

fn files_under(dir: &Path, extensions: &[&str], out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| entry.expect("read entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "node_modules") {
                continue;
            }
            files_under(&path, extensions, out);
        } else if path
            .extension()
            .is_some_and(|ext| extensions.iter().any(|e| ext == *e))
        {
            out.push(path);
        }
    }
}

fn sources_under(root: &Path, dirs: &[PathBuf], extensions: &[&str]) -> Vec<Source> {
    let mut paths = Vec::new();
    for dir in dirs {
        files_under(dir, extensions, &mut paths);
    }
    paths
        .into_iter()
        .map(|path| {
            let file = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let text = fs::read_to_string(&path).unwrap();
            source(&file, text)
        })
        .collect()
}

fn frontend_root() -> PathBuf {
    app_root()
        .join("../src")
        .canonicalize()
        .expect("frontend src")
}

#[test]
fn one_router_one_return_path_one_target_resolver() {
    let app = app_root();
    let rust = sources_under(&app, &source_roots(), &["rs"]);
    let frontend = frontend_root();
    let ts = sources_under(&frontend, &[frontend.clone()], &["ts", "tsx"]);
    assert!(rust.len() > 100, "scanned only {} Rust files", rust.len());
    assert!(ts.len() > 100, "scanned only {} frontend files", ts.len());
    let found = violations(&rust, &ts);
    assert!(found.is_empty(), "{}", found.join("\n"));
}

#[test]
fn every_allowed_definition_is_still_there() {
    let app = app_root();
    for (file, name, why) in ALLOWED {
        let text = fs::read_to_string(app.join(file)).unwrap_or_default();
        assert!(
            scan_rust(file, &text).defines.iter().any(|n| n == name),
            "{file} no longer defines `{name}` ({why}): drop its row"
        );
    }
    for (file, name, why) in TS_ALLOWED {
        let text = fs::read_to_string(frontend_root().join(file)).unwrap_or_default();
        assert!(
            ts_defines(&text).iter().any(|n| n == name),
            "src/{file} no longer defines `{name}` ({why}): drop its row"
        );
    }
}

// --- the seeded cases ---------------------------------------------------------------------------

fn fixture(name: &str) -> String {
    let path = resolve(&format!("tests/fixtures/window_single_owner/{name}"));
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// The one definition of each, and the router's own emit.
fn base() -> Vec<Source> {
    vec![
        source("src/windows/one_of_each.rs", fixture("one_of_each.rs")),
        source("src/windows/router.rs", fixture("router_emit.rs")),
    ]
}

/// The violations of [`base`] plus `extra`, as `(file it is scanned as, fixture)`.
fn seeded(extra: &[(&str, &str)]) -> Vec<String> {
    let mut rust = base();
    let mut ts = Vec::new();
    for (file, name) in extra {
        let seed = source(file, fixture(name));
        if file.ends_with(".rs") {
            rust.push(seed);
        } else {
            ts.push(seed);
        }
    }
    violations(&rust, &ts)
}

#[test]
fn the_base_fixture_passes() {
    assert_eq!(seeded(&[]), Vec::<String>::new());
}

#[test]
fn a_multi_line_emit_of_the_event_fails_outside_the_router() {
    let found = seeded(&[("src/commands/sender.rs", "emit_multiline.rs")]);
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found
        .iter()
        .all(|v| v.starts_with("src/commands/sender.rs:")));
}

#[test]
fn the_same_emit_in_a_test_file_or_a_test_module_passes() {
    assert_eq!(
        seeded(&[
            ("src/commands/sender_tests.rs", "emit_multiline.rs"),
            ("src/commands/sender.rs", "emit_in_cfg_test.rs"),
        ]),
        Vec::<String>::new()
    );
}

#[test]
fn a_frontend_function_in_either_spelling_fails() {
    let found = seeded(&[("features/demo/pick.ts", "resolve_target.ts")]);
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found[0].contains("`resolveTarget`"), "{found:?}");
    assert!(found[1].contains("`return_by_kind`"), "{found:?}");
    assert_eq!(
        seeded(&[("features/demo/pick.test.ts", "resolve_target.ts")]),
        Vec::<String>::new()
    );
}

#[test]
fn a_second_definition_under_windows_fails() {
    let found = seeded(&[("src/windows/other.rs", "second_definition.rs")]);
    assert_eq!(
        found,
        vec!["src/windows/ defines `return_by_kind` 2 times; it defines it once".to_owned()]
    );
}

#[test]
fn a_definition_outside_windows_fails_and_the_allowed_two_pass() {
    let allowed = seeded(&[
        ("src/commands/remote_source.rs", "outside_definition.rs"),
        ("src/dashboard_publish/create.rs", "outside_definition.rs"),
    ]);
    assert_eq!(allowed, Vec::<String>::new());
    let third = seeded(&[("src/commands/elsewhere.rs", "outside_definition.rs")]);
    assert_eq!(
        third,
        vec![
            "src/commands/elsewhere.rs: defines `resolve_target`, which only src/windows/ defines"
                .to_owned()
        ]
    );
}

#[test]
fn a_same_named_test_helper_passes() {
    assert_eq!(
        seeded(&[
            ("src/windows/helper.rs", "test_helper.rs"),
            ("src/windows/helper_tests.rs", "second_definition.rs"),
        ]),
        Vec::<String>::new()
    );
}

#[test]
fn a_missing_definition_fails() {
    let found = violations(
        &[source("src/windows/router.rs", fixture("router_emit.rs"))],
        &[],
    );
    assert_eq!(found.len(), 3, "{found:?}");
    assert!(found
        .iter()
        .all(|v| v.ends_with("0 times; it defines it once")));
}
