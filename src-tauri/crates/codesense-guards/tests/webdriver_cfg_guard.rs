// SPDX-License-Identifier: MIT
//! Test-only WebDriver code compiles only into `e2e-webdriver` builds.
//!
//! The two-window e2e driver adds app commands a release build must never hold: they open windows
//! and seed profiles on a test's say. This guard parses each `.rs` file under `src/` with `syn` and
//! fails on:
//!
//! - any item of a module file that is not declared under the gate: `windows/e2e.rs` is the one
//!   such module today, so its `mod` declaration must carry it;
//! - a `#[tauri::command]` fn whose name starts `e2e_`, or a `generate_handler!` entry naming one,
//!   outside the gate. The shipped `wv_e2e_*` commands (the weft ledger's and the terminal
//!   handler's) are gated at run time, not by the feature, and their prefix is allowed;
//! - a `use`, `extern crate` or path of `tauri_plugin_wdio` or `tauri_plugin_wdio_webdriver`
//!   outside the gate.
//!
//! The gate is a `#[cfg(..)]` that never holds in a release build: `feature = "e2e-webdriver"`,
//! `test`, an `all(..)` with such a member, or an `any(..)` of only such members. It may sit on the
//! item, on any enclosing item, statement, expression, arm or field, on a `generate_handler!`
//! entry, or on any `mod` declaration on the file's path from `lib.rs` (or as the file's own
//! `#![cfg(..)]`). `cfg_attr` and `cfg!` are not gates.
//!
//! `scripts/verify-wdio-plugin-release-absence.sh` checks the plugin's crates against the release
//! dependency graph; this guard checks the app's own code. Std plus `syn`, like the other guards:
//! point `CODESENSE_GUARD_ROOT` at another `src-tauri` to run it on that tree.

use codesense_guards::guard_support::app_root;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

const FEATURE: &str = "e2e-webdriver";

/// The WebDriver plugin's crates, as Rust names them.
const PLUGINS: [&str; 2] = ["tauri_plugin_wdio", "tauri_plugin_wdio_webdriver"];

/// Test-only commands start with this; `wv_e2e_` does not, so the shipped ones pass.
const COMMAND_PREFIX: &str = "e2e_";

/// Whether a cfg predicate never holds in a release build.
fn excluded(predicate: &syn::Meta) -> bool {
    let members = |list: &syn::MetaList| {
        list.parse_args_with(Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated)
            .map(|members| members.into_iter().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    match predicate {
        syn::Meta::Path(path) => path.is_ident("test"),
        syn::Meta::NameValue(pair) => {
            pair.path.is_ident("feature")
                && matches!(
                    &pair.value,
                    syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(s), .. }) if s.value() == FEATURE
                )
        }
        syn::Meta::List(list) if list.path.is_ident("all") => members(list).iter().any(excluded),
        syn::Meta::List(list) if list.path.is_ident("any") => {
            let members = members(list);
            !members.is_empty() && members.iter().all(excluded)
        }
        syn::Meta::List(_) => false,
    }
}

/// Whether `attrs` hold `#[test]` or a gating `#[cfg(..)]`.
fn gated_by(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path().is_ident("test")
            || (attr.path().is_ident("cfg")
                && attr
                    .parse_args::<syn::Meta>()
                    .is_ok_and(|predicate| excluded(&predicate)))
    })
}

fn item_attrs(item: &syn::Item) -> &[syn::Attribute] {
    match item {
        syn::Item::Const(i) => &i.attrs,
        syn::Item::Enum(i) => &i.attrs,
        syn::Item::ExternCrate(i) => &i.attrs,
        syn::Item::Fn(i) => &i.attrs,
        syn::Item::ForeignMod(i) => &i.attrs,
        syn::Item::Impl(i) => &i.attrs,
        syn::Item::Macro(i) => &i.attrs,
        syn::Item::Mod(i) => &i.attrs,
        syn::Item::Static(i) => &i.attrs,
        syn::Item::Struct(i) => &i.attrs,
        syn::Item::Trait(i) => &i.attrs,
        syn::Item::TraitAlias(i) => &i.attrs,
        syn::Item::Type(i) => &i.attrs,
        syn::Item::Union(i) => &i.attrs,
        syn::Item::Use(i) => &i.attrs,
        _ => &[],
    }
}

fn impl_item_attrs(item: &syn::ImplItem) -> &[syn::Attribute] {
    match item {
        syn::ImplItem::Const(i) => &i.attrs,
        syn::ImplItem::Fn(i) => &i.attrs,
        syn::ImplItem::Macro(i) => &i.attrs,
        syn::ImplItem::Type(i) => &i.attrs,
        _ => &[],
    }
}

fn expr_attrs(expr: &syn::Expr) -> &[syn::Attribute] {
    match expr {
        syn::Expr::Array(e) => &e.attrs,
        syn::Expr::Assign(e) => &e.attrs,
        syn::Expr::Async(e) => &e.attrs,
        syn::Expr::Await(e) => &e.attrs,
        syn::Expr::Binary(e) => &e.attrs,
        syn::Expr::Block(e) => &e.attrs,
        syn::Expr::Call(e) => &e.attrs,
        syn::Expr::Closure(e) => &e.attrs,
        syn::Expr::Field(e) => &e.attrs,
        syn::Expr::ForLoop(e) => &e.attrs,
        syn::Expr::If(e) => &e.attrs,
        syn::Expr::Loop(e) => &e.attrs,
        syn::Expr::Macro(e) => &e.attrs,
        syn::Expr::Match(e) => &e.attrs,
        syn::Expr::MethodCall(e) => &e.attrs,
        syn::Expr::Paren(e) => &e.attrs,
        syn::Expr::Path(e) => &e.attrs,
        syn::Expr::Reference(e) => &e.attrs,
        syn::Expr::Return(e) => &e.attrs,
        syn::Expr::Struct(e) => &e.attrs,
        syn::Expr::Try(e) => &e.attrs,
        syn::Expr::Tuple(e) => &e.attrs,
        syn::Expr::Unary(e) => &e.attrs,
        syn::Expr::Unsafe(e) => &e.attrs,
        syn::Expr::While(e) => &e.attrs,
        _ => &[],
    }
}

fn is_command(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path()
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "command")
    })
}

/// One `generate_handler!` entry: its attributes and its path.
struct HandlerEntry {
    attrs: Vec<syn::Attribute>,
    path: syn::Path,
}

impl Parse for HandlerEntry {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        Ok(HandlerEntry {
            attrs: input.call(syn::Attribute::parse_outer)?,
            path: input.parse()?,
        })
    }
}

struct Scan<'a> {
    file: &'a str,
    /// How many enclosing gates the visitor is inside.
    depth: usize,
    hits: Vec<String>,
    /// Each out-of-line `mod name;` and whether it is gated.
    mods: Vec<(String, bool)>,
    /// Every `e2e_` command fn and handler entry seen, gated or not.
    commands: Vec<String>,
}

impl Scan<'_> {
    fn gate<F: FnOnce(&mut Self)>(&mut self, attrs: &[syn::Attribute], f: F) {
        let gated = gated_by(attrs);
        self.depth += usize::from(gated);
        f(self);
        self.depth -= usize::from(gated);
    }

    fn hit(&mut self, node: &impl Spanned, what: String) {
        if self.depth == 0 {
            let line = node.span().start().line;
            self.hits.push(format!(
                "{}:{line}: {what} outside #[cfg(feature = \"{FEATURE}\")]",
                self.file
            ));
        }
    }

    fn command(&mut self, node: &impl Spanned, name: String) {
        if name.starts_with(COMMAND_PREFIX) {
            self.commands.push(name.clone());
            self.hit(node, format!("the command {name}"));
        }
    }

    fn plugin(&mut self, node: &impl Spanned, ident: &syn::Ident) {
        if PLUGINS.iter().any(|plugin| ident == plugin) {
            self.hit(node, format!("{ident}"));
        }
    }
}

impl<'ast> Visit<'ast> for Scan<'_> {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        self.gate(item_attrs(item), |s| visit::visit_item(s, item));
    }

    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        if is_command(&item.attrs) {
            self.command(&item.sig.ident, item.sig.ident.to_string());
        }
        visit::visit_item_fn(self, item);
    }

    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        if item.content.is_none() {
            self.mods.push((item.ident.to_string(), self.depth > 0));
        }
        visit::visit_item_mod(self, item);
    }

    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        let mut tree = &item.tree;
        while let syn::UseTree::Group(group) = tree {
            match group.items.first() {
                Some(first) if group.items.len() == 1 => tree = first,
                _ => break,
            }
        }
        match tree {
            syn::UseTree::Path(path) => self.plugin(item, &path.ident),
            syn::UseTree::Name(name) => self.plugin(item, &name.ident),
            syn::UseTree::Rename(rename) => self.plugin(item, &rename.ident),
            syn::UseTree::Group(group) => {
                for tree in &group.items {
                    if let syn::UseTree::Path(syn::UsePath { ident, .. })
                    | syn::UseTree::Name(syn::UseName { ident })
                    | syn::UseTree::Rename(syn::UseRename { ident, .. }) = tree
                    {
                        self.plugin(item, ident);
                    }
                }
            }
            syn::UseTree::Glob(_) => {}
        }
        visit::visit_item_use(self, item);
    }

    fn visit_item_extern_crate(&mut self, item: &'ast syn::ItemExternCrate) {
        self.plugin(item, &item.ident);
        visit::visit_item_extern_crate(self, item);
    }

    fn visit_impl_item(&mut self, item: &'ast syn::ImplItem) {
        self.gate(impl_item_attrs(item), |s| visit::visit_impl_item(s, item));
    }

    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        if is_command(&item.attrs) {
            self.command(&item.sig.ident, item.sig.ident.to_string());
        }
        visit::visit_impl_item_fn(self, item);
    }

    fn visit_local(&mut self, local: &'ast syn::Local) {
        self.gate(&local.attrs, |s| visit::visit_local(s, local));
    }

    fn visit_stmt_macro(&mut self, stmt: &'ast syn::StmtMacro) {
        self.gate(&stmt.attrs, |s| visit::visit_stmt_macro(s, stmt));
    }

    fn visit_expr(&mut self, expr: &'ast syn::Expr) {
        self.gate(expr_attrs(expr), |s| visit::visit_expr(s, expr));
    }

    fn visit_arm(&mut self, arm: &'ast syn::Arm) {
        self.gate(&arm.attrs, |s| visit::visit_arm(s, arm));
    }

    fn visit_field(&mut self, field: &'ast syn::Field) {
        self.gate(&field.attrs, |s| visit::visit_field(s, field));
    }

    fn visit_field_value(&mut self, field: &'ast syn::FieldValue) {
        self.gate(&field.attrs, |s| visit::visit_field_value(s, field));
    }

    fn visit_path(&mut self, path: &'ast syn::Path) {
        if let Some(first) = path.segments.first() {
            self.plugin(path, &first.ident);
        }
        visit::visit_path(self, path);
    }

    /// `syn` leaves macro tokens unparsed: read `generate_handler!`'s entries with their
    /// attributes, and scan any other body that parses as comma-separated expressions.
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let handler = mac
            .path
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "generate_handler");
        if handler {
            let entries = mac
                .parse_body_with(Punctuated::<HandlerEntry, syn::Token![,]>::parse_terminated)
                .unwrap_or_else(|error| {
                    panic!("parse generate_handler! in {}: {error}", self.file)
                });
            for entry in &entries {
                self.gate(&entry.attrs, |s| {
                    if let Some(last) = entry.path.segments.last() {
                        s.command(&entry.path, last.ident.to_string());
                    }
                    Visit::visit_path(s, &entry.path);
                });
            }
            return;
        }
        if let Ok(args) =
            mac.parse_body_with(Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated)
        {
            for arg in &args {
                Visit::visit_expr(self, arg);
            }
        }
    }
}

/// One file's scan: its hits, whether the file gates itself, its out-of-line modules, and the
/// `e2e_` commands it names.
struct FileScan {
    hits: Vec<String>,
    gated: bool,
    mods: Vec<(String, bool)>,
    commands: Vec<String>,
}

fn scan_file(file: &str, source: &str) -> FileScan {
    let parsed = syn::parse_file(source).unwrap_or_else(|error| panic!("parse {file}: {error}"));
    let mut scan = Scan {
        file,
        depth: 0,
        hits: Vec::new(),
        mods: Vec::new(),
        commands: Vec::new(),
    };
    scan.visit_file(&parsed);
    FileScan {
        hits: scan.hits,
        gated: gated_by(&parsed.attrs),
        mods: scan.mods,
        commands: scan.commands,
    }
}

/// The files a `mod name;` in `file` may load, relative to `src/`.
fn module_files(file: &str, name: &str) -> [String; 2] {
    let (dir, stem) = file.rsplit_once('/').unwrap_or(("", file));
    let base = if matches!(stem, "mod.rs" | "lib.rs" | "main.rs") {
        dir.to_owned()
    } else {
        file.trim_end_matches(".rs").to_owned()
    };
    let join = |rest: String| {
        if base.is_empty() {
            rest
        } else {
            format!("{base}/{rest}")
        }
    };
    [join(format!("{name}.rs")), join(format!("{name}/mod.rs"))]
}

/// What a scan of a whole tree found.
struct TreeScan {
    hits: Vec<String>,
    /// Every `e2e_` command named, gated or not.
    commands: Vec<String>,
}

/// Scan `files` (paths relative to `src/`, `/`-separated): each file's hits count only when no
/// `mod` declaration on its path from the crate root, and not the file itself, carries the gate.
fn scan_tree(files: &BTreeMap<String, String>) -> TreeScan {
    let scans: BTreeMap<&str, FileScan> = files
        .iter()
        .map(|(file, source)| (file.as_str(), scan_file(file, source)))
        .collect();
    // Each module file and the declaration that loads it: (declaring file, declared gated).
    let mut parent: BTreeMap<String, (&str, bool)> = BTreeMap::new();
    for (file, scan) in &scans {
        for (name, gated) in &scan.mods {
            for child in module_files(file, name) {
                if files.contains_key(&child) {
                    parent.insert(child, (*file, *gated));
                }
            }
        }
    }
    let gated = |file: &str| {
        let mut at = file.to_owned();
        for _ in 0..64 {
            if scans[at.as_str()].gated {
                return true;
            }
            match parent.get(&at) {
                Some((_, true)) => return true,
                Some((up, false)) => at = (*up).to_owned(),
                None => return false,
            }
        }
        panic!("module declarations under {file} loop")
    };
    let mut hits = Vec::new();
    let mut commands = Vec::new();
    for (file, scan) in &scans {
        commands.extend(scan.commands.iter().cloned());
        if !gated(*file) {
            hits.extend(scan.hits.iter().cloned());
        }
    }
    TreeScan { hits, commands }
}

fn read_tree(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
    {
        let path = entry.expect("read entry").path();
        if path.is_dir() {
            read_tree(&path, root, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let file = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(file, fs::read_to_string(&path).unwrap());
        }
    }
}

fn app_tree() -> BTreeMap<String, String> {
    let src = app_root().join("src");
    let mut files = BTreeMap::new();
    read_tree(&src, &src, &mut files);
    files
}

fn one(source: &str) -> Vec<String> {
    scan_tree(&BTreeMap::from([("lib.rs".to_owned(), source.to_owned())])).hits
}

fn tree(files: &[(&str, &str)]) -> Vec<String> {
    scan_tree(
        &files
            .iter()
            .map(|(file, source)| ((*file).to_owned(), (*source).to_owned()))
            .collect(),
    )
    .hits
}

#[test]
fn no_webdriver_code_outside_the_feature_gate() {
    let files = app_tree();
    assert!(files.len() > 100, "scanned only {} files", files.len());
    let scan = scan_tree(&files);
    assert!(
        scan.hits.is_empty(),
        "put test-only WebDriver code under #[cfg(feature = \"{FEATURE}\")]:\n{}",
        scan.hits.join("\n")
    );
    // The scan sees the driver's commands, each defined once and registered once, so a scan
    // that stopped reaching them would fail here rather than pass on nothing.
    for name in ["e2e_open_window", "e2e_seed"] {
        let seen = scan.commands.iter().filter(|c| *c == name).count();
        assert_eq!(
            seen, 2,
            "{name}: seen {seen} times, not as one fn and one handler entry"
        );
    }
}

#[test]
fn the_shipped_wv_e2e_commands_are_allowed() {
    let files = app_tree();
    let lib = &files["lib.rs"];
    assert!(
        lib.contains("wv_e2e_seed_dispatch") && lib.contains("wv_e2e_terminal_read"),
        "the run-time-gated wv_e2e_* commands this allowance names are still registered"
    );
    assert!(
        scan_tree(&files)
            .commands
            .iter()
            .all(|name| name.starts_with(COMMAND_PREFIX)),
        "the scan names only e2e_ commands, never the wv_e2e_ ones"
    );
}

#[test]
fn fails_each_ungated_use() {
    let gate = "outside #[cfg(feature = \"e2e-webdriver\")]";
    let planted = [
        (
            "#[tauri::command]\nfn e2e_open_window() {}",
            "lib.rs:2: the command e2e_open_window",
        ),
        (
            "#[cfg(feature = \"dashboard-publish\")]\n#[tauri::command]\nfn e2e_seed() {}",
            "lib.rs:3: the command e2e_seed",
        ),
        (
            "#[cfg(any(feature = \"e2e-webdriver\", unix))]\n#[command]\nfn e2e_seed() {}",
            "lib.rs:3: the command e2e_seed",
        ),
        (
            "#[cfg(not(feature = \"e2e-webdriver\"))]\n#[tauri::command]\nfn e2e_seed() {}",
            "lib.rs:3: the command e2e_seed",
        ),
        (
            "#[cfg_attr(feature = \"e2e-webdriver\", allow(dead_code))]\n#[tauri::command]\nfn e2e_seed() {}",
            "lib.rs:3: the command e2e_seed",
        ),
        (
            "impl S {\n    #[tauri::command]\n    fn e2e_seed() {}\n}",
            "lib.rs:3: the command e2e_seed",
        ),
        (
            "fn run(b: B) {\n    b.invoke_handler(counted(tauri::generate_handler![\n        a::ok,\n        windows::e2e::e2e_open_window,\n    ]));\n}",
            "lib.rs:4: the command e2e_open_window",
        ),
        (
            "fn run(b: B) {\n    b.invoke_handler(tauri::generate_handler![\n        #[cfg(feature = \"dashboard-publish\")]\n        e2e_seed,\n    ]);\n}",
            "lib.rs:4: the command e2e_seed",
        ),
        (
            "use tauri_plugin_wdio_webdriver::init;",
            "lib.rs:1: tauri_plugin_wdio_webdriver",
        ),
        (
            "use {tauri_plugin_wdio as wdio, std::fs};",
            "lib.rs:1: tauri_plugin_wdio",
        ),
        ("extern crate tauri_plugin_wdio;", "lib.rs:1: tauri_plugin_wdio"),
        (
            "fn run(b: B) {\n    let b = b.plugin(tauri_plugin_wdio::init());\n}",
            "lib.rs:2: tauri_plugin_wdio",
        ),
        (
            "fn run(b: B) {\n    if cfg!(feature = \"e2e-webdriver\") {\n        b.plugin(::tauri_plugin_wdio_webdriver::init());\n    }\n}",
            "lib.rs:3: tauri_plugin_wdio_webdriver",
        ),
        (
            "fn run() {\n    log!(\"{:?}\", tauri_plugin_wdio::init());\n}",
            "lib.rs:2: tauri_plugin_wdio",
        ),
    ];
    for (source, expected) in planted {
        assert_eq!(one(source), vec![format!("{expected} {gate}")], "{source}");
    }
}

#[test]
fn fails_an_e2e_module_its_declaration_does_not_gate() {
    let e2e = "#[tauri::command]\npub fn e2e_open_window() {}";
    for declaration in [
        "pub mod e2e;",
        "#[cfg_attr(feature = \"e2e-webdriver\", allow(dead_code))]\npub mod e2e;",
        "#[cfg(feature = \"dashboard-publish\")]\npub mod e2e;",
    ] {
        let hits = tree(&[
            ("lib.rs", "mod windows;"),
            ("windows/mod.rs", declaration),
            ("windows/e2e.rs", e2e),
        ]);
        assert_eq!(
            hits,
            vec![format!(
                "windows/e2e.rs:2: the command e2e_open_window outside #[cfg(feature = \"{FEATURE}\")]"
            )],
            "{declaration}"
        );
    }
    // A file no declaration reaches is scanned on its own.
    assert_eq!(tree(&[("lib.rs", ""), ("windows/e2e.rs", e2e)]).len(), 1);
}

#[test]
fn passes_gated_code_test_code_and_the_shipped_commands() {
    let negatives = [
        "#[cfg(feature = \"e2e-webdriver\")]\n#[tauri::command]\nfn e2e_open_window() {}",
        "#[cfg(all(feature = \"e2e-webdriver\", unix))]\n#[tauri::command]\nfn e2e_seed() {}",
        "#[cfg(any(feature = \"e2e-webdriver\", test))]\nmod guard { #[tauri::command] fn e2e_x() {} }",
        "#[cfg(test)]\nmod tests { #[tauri::command] fn e2e_x() {} use tauri_plugin_wdio::init; }",
        "#[test]\nfn e2e_drives() { let _ = tauri_plugin_wdio::init(); }",
        "#[tauri::command]\nfn wv_e2e_seed_dispatch() {}",
        "fn e2e_helper() {}",
        "fn run(b: B) {\n    b.invoke_handler(tauri::generate_handler![\n        a::wv_e2e_terminal_read,\n        #[cfg(feature = \"e2e-webdriver\")]\n        windows::e2e::e2e_open_window,\n        #[cfg(feature = \"e2e-webdriver\")]\n        windows::e2e::e2e_seed\n    ]);\n}",
        "fn run(b: B) {\n    #[cfg(feature = \"e2e-webdriver\")]\n    let b = b.plugin(tauri_plugin_wdio::init()).plugin(tauri_plugin_wdio_webdriver::init());\n}",
        "fn run(b: B) {\n    #[cfg(feature = \"e2e-webdriver\")]\n    {\n        b.plugin(tauri_plugin_wdio::init());\n    }\n}",
        "struct S {\n    #[cfg(feature = \"e2e-webdriver\")]\n    plugin: tauri_plugin_wdio::State,\n}",
        "// tauri_plugin_wdio::init() and e2e_seed in a comment",
        "#![cfg(feature = \"e2e-webdriver\")]\n#[tauri::command]\nfn e2e_seed() {}",
    ];
    for source in negatives {
        assert_eq!(one(source), Vec::<String>::new(), "{source}");
    }
    let e2e = "#[tauri::command]\npub fn e2e_open_window() {}\nmod seed;";
    let seed = "#[tauri::command]\npub fn e2e_seed() {}";
    for (layout, declaration) in [
        (
            ["windows/e2e.rs", "windows/e2e/seed.rs"],
            "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;",
        ),
        (
            ["windows/e2e/mod.rs", "windows/e2e/seed.rs"],
            "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;",
        ),
    ] {
        let hits = tree(&[
            ("lib.rs", "mod windows;"),
            ("windows/mod.rs", declaration),
            (layout[0], e2e),
            (layout[1], seed),
        ]);
        assert_eq!(hits, Vec::<String>::new(), "{layout:?}");
    }
    // A gate on an ancestor module covers the whole subtree.
    let hits = tree(&[
        (
            "lib.rs",
            "#[cfg(feature = \"e2e-webdriver\")]\nmod windows;",
        ),
        ("windows/mod.rs", "pub mod e2e;"),
        ("windows/e2e.rs", e2e),
    ]);
    assert_eq!(hits, Vec::<String>::new());
}

#[test]
fn module_files_follow_rust_s_layout() {
    assert_eq!(
        module_files("lib.rs", "windows"),
        ["windows.rs", "windows/mod.rs"]
    );
    assert_eq!(
        module_files("windows/mod.rs", "e2e"),
        ["windows/e2e.rs", "windows/e2e/mod.rs"]
    );
    assert_eq!(
        module_files("windows/e2e.rs", "seed"),
        ["windows/e2e/seed.rs", "windows/e2e/seed/mod.rs"]
    );
}
