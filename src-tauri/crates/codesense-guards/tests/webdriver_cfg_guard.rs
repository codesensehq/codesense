// SPDX-License-Identifier: MIT
//! Test-only WebDriver code compiles only into `e2e-webdriver` builds.
//!
//! The two-window e2e driver adds app commands a release build must never hold: they open windows
//! and seed profiles on a test's say. This guard parses each `.rs` file under `src/` with `syn` and
//! fails on:
//!
//! - a file of a webdriver-only module ([`WEBDRIVER_MODULES`]: `windows/e2e.rs` and anything
//!   under `windows/e2e/`) that the gate does not cover, whatever it holds, so the module's
//!   helpers, types and constants stay out of a release build with its commands;
//! - a `#[tauri::command]` fn whose name starts `e2e_`, or a `generate_handler!` entry naming one,
//!   outside the gate. The shipped `wv_e2e_*` commands (the weft ledger's and the terminal
//!   handler's) are gated at run time, not by the feature, and their prefix is allowed;
//! - a `use`, `extern crate` or path of `tauri_plugin_wdio` or `tauri_plugin_wdio_webdriver`
//!   outside the gate.
//!
//! The gate is a `#[cfg(..)]` that never holds in a release build: `feature = "e2e-webdriver"`,
//! `test`, an `all(..)` with such a member, or an `any(..)` of only such members. It may sit on the
//! item, on any enclosing item, statement, expression, arm or field, on a `generate_handler!`
//! entry, or as the file's own `#![cfg(..)]`. A file is also gated when every way the crate loads
//! it is: each `mod` declaration, `#[path]` module or `include!` that loads it is gated, or sits in
//! a file that is. `cfg_attr` and `cfg!` are not gates.
//!
//! The loads are followed as rustc follows them: `mod x;` from the declaring module's directory,
//! `#[path]` from the declaring file's directory plus any enclosing inline modules, and `include!`
//! from the invoking file's directory. A file a `#[path]` or `include!` loads owns its directory,
//! like a `mod.rs`. The guard fails closed on a load it cannot follow: one that names no file it
//! read, a path that is not a string literal, absolute or outside `src/` (bar [`OUT_OF_SRC`]), a
//! `cfg_attr` that sets `path`, a `#[path]` on an inline `mod x { .. }`, or an out-of-line `mod`
//! inside a block. A file no load reaches is not gated. Every file the webdriver-only modules load,
//! however, is webdriver-only too.
//!
//! The guard does not expand macros, so it never follows a load a macro makes. It fails on a
//! `mod <name>;`, a `#[path ..]`, a `cfg_attr` naming `path` or an `include!` in the body of a
//! `macro_rules!`, of an item or statement macro, or of any other macro whose body it cannot parse
//! (bar a file in [`MACRO_LOADS_ALLOWED`]), and on an `include` renamed by `use`.
//!
//! The crate roots are `lib.rs`, `main.rs`, `bin/<name>.rs` and `bin/<name>/main.rs`, and any
//! `[lib]` or `[[bin]]` path in `Cargo.toml`; a root is never gated by a load. Each path resolves to
//! the file it names, so a file read under a second name (a symlink, or a symlinked directory) is
//! the same file, webdriver-only if its real path is.
//!
//! `scripts/verify-wdio-plugin-release-absence.sh` checks the plugin's crates against the release
//! dependency graph; this guard checks the app's own code. Std plus `syn`, like the other guards:
//! point `CODESENSE_GUARD_ROOT` at another `src-tauri` to run it on that tree.

use codesense_guards::guard_support::app_root;
use proc_macro2::{Delimiter, TokenStream, TokenTree};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

const FEATURE: &str = "e2e-webdriver";

/// The WebDriver plugin's crates, as Rust names them.
const PLUGINS: [&str; 2] = ["tauri_plugin_wdio", "tauri_plugin_wdio_webdriver"];

/// The modules every item of which is test-only, as paths under `src/` without `.rs`: each
/// covers `<path>.rs`, `<path>/mod.rs` and every file under `<path>/`.
const WEBDRIVER_MODULES: [&str; 1] = ["windows/e2e"];

/// The files outside `src/` the app loads, relative to `src/`: the guard reads and scans them
/// like the files under `src/`, and fails any other path that leaves `src/`.
const OUT_OF_SRC: [&str; 1] = [
    // The capability table's parser, shared with build.rs; `platform_caps.rs` includes it.
    "../build_caps.rs",
];

/// The files whose macro bodies may hold a module load, each with the reason the load is safe
/// ungated. Every other file's fails the guard.
const MACRO_LOADS_ALLOWED: [(&str, &str); 0] = [];

/// Whether `file` belongs to a [`WEBDRIVER_MODULES`] module.
fn webdriver_only(file: &str) -> bool {
    WEBDRIVER_MODULES.iter().any(|module| {
        file.strip_suffix(".rs") == Some(*module)
            || file
                .strip_prefix(*module)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

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

/// How a declaration loads another file.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Load {
    /// `mod name;`
    Mod(String),
    /// `#[path = ".."] mod name;`
    Path(String),
    /// `include!("..")`
    Include(String),
}

impl std::fmt::Display for Load {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Load::Mod(name) => write!(f, "mod {name};"),
            Load::Path(path) => write!(f, "#[path = {path:?}]"),
            Load::Include(path) => write!(f, "include!({path:?})"),
        }
    }
}

/// One load of another file, as written in the declaring file.
struct Decl {
    load: Load,
    /// The inline `mod x { .. }` blocks around it, outermost first.
    inline: Vec<String>,
    line: usize,
    gated: bool,
}

struct Scan<'a> {
    file: &'a str,
    /// How many enclosing gates the visitor is inside.
    depth: usize,
    /// The inline modules the visitor is inside, outermost first.
    inline: Vec<String>,
    /// How many blocks (fn bodies, block expressions) the visitor is inside.
    blocks: usize,
    hits: Vec<String>,
    /// Each load of another file.
    loads: Vec<Decl>,
    /// The loads the guard cannot follow, each a failure.
    rejected: Vec<String>,
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

    fn reject(&mut self, line: usize, what: &str) {
        self.rejected.push(format!(
            "{}:{line}: {what}: the guard cannot follow it",
            self.file
        ));
    }

    /// Fails each module load in a macro's body, which the guard cannot expand.
    fn macro_body(&mut self, mac: &syn::Macro) {
        if MACRO_LOADS_ALLOWED
            .iter()
            .any(|(file, _)| *file == self.file)
        {
            return;
        }
        let mut found = Vec::new();
        macro_loads(mac.tokens.clone(), &mut found);
        for (line, what) in found {
            self.reject(line, &format!("{what} inside a macro body"));
        }
    }

    fn load(&mut self, load: Load, line: usize) {
        self.loads.push(Decl {
            load,
            inline: self.inline.clone(),
            line,
            gated: self.depth > 0,
        });
    }

    /// A module's `#[path]` value, rejecting one that is not a string literal and a `cfg_attr`
    /// that sets one.
    fn path_attr(&mut self, attrs: &[syn::Attribute]) -> Option<String> {
        let mut found = None;
        for attr in attrs {
            let line = attr.span().start().line;
            if attr.path().is_ident("path") {
                match &attr.meta {
                    syn::Meta::NameValue(syn::MetaNameValue {
                        value:
                            syn::Expr::Lit(syn::ExprLit {
                                lit: syn::Lit::Str(s),
                                ..
                            }),
                        ..
                    }) => found = Some(s.value()),
                    _ => self.reject(line, "a #[path] that is not a string literal"),
                }
            } else if attr.path().is_ident("cfg_attr") && cfg_attr_sets_path(&attr.meta) {
                self.reject(line, "a cfg_attr that sets a module's path");
            }
        }
        found
    }
}

/// Whether a `cfg_attr(..)` may set `path`, at any depth; one the guard cannot parse may.
fn cfg_attr_sets_path(meta: &syn::Meta) -> bool {
    let syn::Meta::List(list) = meta else {
        return true;
    };
    let Ok(members) =
        list.parse_args_with(Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated)
    else {
        return true;
    };
    members.iter().skip(1).any(|member| {
        member.path().is_ident("path")
            || (member.path().is_ident("cfg_attr") && cfg_attr_sets_path(member))
    })
}

/// The module loads in a macro body, each with its line: a `mod <name>;` (or `mod $name;`), a
/// `#[path ..]`, a `cfg_attr` naming `path`, and an `include!`, at any depth.
fn macro_loads(tokens: TokenStream, out: &mut Vec<(usize, &'static str)>) {
    let tokens: Vec<TokenTree> = tokens.into_iter().collect();
    let punct = |at: usize, c: char| matches!(tokens.get(at), Some(TokenTree::Punct(p)) if p.as_char() == c);
    for (at, token) in tokens.iter().enumerate() {
        let line = token.span().start().line;
        match token {
            TokenTree::Ident(ident) if ident == "mod" => {
                let name = if punct(at + 1, '$') { at + 2 } else { at + 1 };
                if matches!(tokens.get(name), Some(TokenTree::Ident(_))) && punct(name + 1, ';') {
                    out.push((line, "a mod declaration"));
                }
            }
            TokenTree::Ident(ident) if ident == "include" && punct(at + 1, '!') => {
                out.push((line, "an include!"));
            }
            TokenTree::Punct(p) if p.as_char() == '#' => {
                let attr = if punct(at + 1, '!') { at + 2 } else { at + 1 };
                if let Some(TokenTree::Group(group)) = tokens.get(attr) {
                    if group.delimiter() == Delimiter::Bracket {
                        match group.stream().into_iter().next() {
                            Some(TokenTree::Ident(ident)) if ident == "path" => {
                                out.push((line, "a #[path]"));
                            }
                            Some(TokenTree::Ident(ident))
                                if ident == "cfg_attr" && names_path(group.stream()) =>
                            {
                                out.push((line, "a cfg_attr that may set a module's path"));
                            }
                            _ => {}
                        }
                    }
                }
            }
            TokenTree::Group(group) => macro_loads(group.stream(), out),
            _ => {}
        }
    }
}

/// Whether `tokens` name `path` at any depth.
fn names_path(tokens: TokenStream) -> bool {
    tokens.into_iter().any(|token| match token {
        TokenTree::Ident(ident) => ident == "path",
        TokenTree::Group(group) => names_path(group.stream()),
        _ => false,
    })
}

/// Whether a `use` tree renames `include`, whose loads the guard would then not see.
fn renames_include(tree: &syn::UseTree) -> bool {
    match tree {
        syn::UseTree::Path(path) => renames_include(&path.tree),
        syn::UseTree::Rename(rename) => rename.ident == "include",
        syn::UseTree::Group(group) => group.items.iter().any(renames_include),
        syn::UseTree::Name(_) | syn::UseTree::Glob(_) => false,
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
        let line = item.mod_token.span.start().line;
        let path = self.path_attr(&item.attrs);
        match &item.content {
            None if self.blocks > 0 => self.reject(line, "an out-of-line mod inside a block"),
            None => {
                let load = match path {
                    Some(path) => Load::Path(path),
                    None => Load::Mod(item.ident.to_string()),
                };
                self.load(load, line);
            }
            Some(_) => {
                if path.is_some() {
                    self.reject(line, "a #[path] on an inline mod");
                }
                self.inline.push(item.ident.to_string());
                visit::visit_item_mod(self, item);
                self.inline.pop();
                return;
            }
        }
        visit::visit_item_mod(self, item);
    }

    fn visit_block(&mut self, block: &'ast syn::Block) {
        self.blocks += 1;
        visit::visit_block(self, block);
        self.blocks -= 1;
    }

    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        if renames_include(&item.tree) {
            self.reject(item.span().start().line, "an include renamed by use");
        }
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

    /// A statement macro may expand to items, modules among them.
    fn visit_stmt_macro(&mut self, stmt: &'ast syn::StmtMacro) {
        self.macro_body(&stmt.mac);
        self.gate(&stmt.attrs, |s| visit::visit_stmt_macro(s, stmt));
    }

    /// An item macro (a `macro_rules!` definition among them) may expand to modules.
    fn visit_item_macro(&mut self, item: &'ast syn::ItemMacro) {
        self.macro_body(&item.mac);
        visit::visit_item_macro(self, item);
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
    /// attributes and `include!`'s path, and scan any other body that parses as comma-separated
    /// expressions. Any other body may hide a module load, so each one in it fails.
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let name = mac.path.segments.last().map(|segment| &segment.ident);
        if name.is_some_and(|name| name == "include") {
            let line = mac.span().start().line;
            match mac.parse_body::<syn::LitStr>() {
                Ok(path) => self.load(Load::Include(path.value()), line),
                Err(_) => self.reject(line, "an include! whose path is not a string literal"),
            }
            return;
        }
        if name.is_some_and(|name| name == "generate_handler") {
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
        match mac.parse_body_with(Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated) {
            Ok(args) => {
                for arg in &args {
                    Visit::visit_expr(self, arg);
                }
            }
            Err(_) => self.macro_body(mac),
        }
    }
}

/// One file's scan: its hits, whether the file gates itself, the files it loads, the loads it
/// cannot follow, and the `e2e_` commands it names.
struct FileScan {
    hits: Vec<String>,
    gated: bool,
    loads: Vec<Decl>,
    rejected: Vec<String>,
    commands: Vec<String>,
}

fn scan_file(file: &str, source: &str) -> FileScan {
    let parsed = syn::parse_file(source).unwrap_or_else(|error| panic!("parse {file}: {error}"));
    let mut scan = Scan {
        file,
        depth: 0,
        inline: Vec::new(),
        blocks: 0,
        hits: Vec::new(),
        loads: Vec::new(),
        rejected: Vec::new(),
        commands: Vec::new(),
    };
    scan.visit_file(&parsed);
    FileScan {
        hits: scan.hits,
        gated: gated_by(&parsed.attrs),
        loads: scan.loads,
        rejected: scan.rejected,
        commands: scan.commands,
    }
}

/// `rel` joined to the directory `base`, both relative to `src/`, with `.` and `..` folded; a
/// path that leaves `src/` keeps its leading `..`. `None` for an absolute path.
fn join(base: &str, rel: &str) -> Option<String> {
    if rel.starts_with('/') || rel.starts_with('\\') || rel.get(1..2) == Some(":") {
        return None;
    }
    let mut up = 0;
    let mut parts: Vec<&str> = Vec::new();
    for part in base.split('/').chain(rel.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    up += 1;
                }
            }
            part => parts.push(part),
        }
    }
    let mut out = vec![".."; up];
    out.extend(parts);
    Some(out.join("/"))
}

/// The files `decl` in `file` may load, relative to `src/`. `owns_dir` says whether `file` was
/// loaded as a crate root, a `mod.rs`, or by `#[path]` or `include!`; any other `<dir>/<stem>.rs`
/// owns `<dir>/<stem>/` instead. `None` for an absolute path.
fn load_targets(file: &str, owns_dir: bool, decl: &Decl) -> Option<Vec<String>> {
    let dir = file.rsplit_once('/').map_or("", |(dir, _)| dir);
    let module_dir = || {
        let own = if owns_dir {
            dir.to_owned()
        } else {
            file.trim_end_matches(".rs").to_owned()
        };
        decl.inline.iter().fold(own, |at, inline| {
            join(&at, inline).expect("a module name is relative")
        })
    };
    match &decl.load {
        Load::Mod(name) => {
            let base = module_dir();
            Some(vec![
                join(&base, &format!("{name}.rs"))?,
                join(&base, &format!("{name}/mod.rs"))?,
            ])
        }
        Load::Path(path) if decl.inline.is_empty() => Some(vec![join(dir, path)?]),
        Load::Path(path) => Some(vec![join(&module_dir(), path)?]),
        Load::Include(path) => Some(vec![join(dir, path)?]),
    }
}

/// What a scan of a whole tree found.
struct TreeScan {
    hits: Vec<String>,
    /// The loads the guard cannot follow.
    unfollowed: Vec<String>,
    /// Every `e2e_` command named, gated or not.
    commands: Vec<String>,
    /// The webdriver-only files: the modules' own and every file they load.
    webdriver: Vec<String>,
}

/// The files a scan reads, each keyed by its real path relative to `src/` (`/`-separated).
struct Sources {
    files: BTreeMap<String, String>,
    /// Each other name a file was read under (a symlink, or one in a symlinked directory), mapped
    /// to its real path.
    aliases: BTreeMap<String, String>,
    /// The crate roots `Cargo.toml` names, beside the ones cargo finds by their place.
    roots: Vec<String>,
    /// What the reader could not follow: a link out of `src/`, a root outside it.
    unread: Vec<String>,
}

impl Sources {
    fn new(files: BTreeMap<String, String>) -> Self {
        Sources {
            files,
            aliases: BTreeMap::new(),
            roots: Vec::new(),
            unread: Vec::new(),
        }
    }

    /// The real path of `file`, or `file` when it has no other.
    fn resolve<'a>(&'a self, file: &'a str) -> &'a str {
        self.aliases.get(file).map_or(file, String::as_str)
    }
}

/// Whether cargo takes `file` (relative to `src/`) as a crate root by its place: the lib, the
/// main bin, and each `bin/<name>.rs` or `bin/<name>/main.rs`.
fn placed_root(file: &str) -> bool {
    matches!(file, "lib.rs" | "main.rs")
        || file.strip_prefix("bin/").is_some_and(|rest| {
            rest.ends_with(".rs") && !rest.contains('/')
                || rest
                    .strip_suffix("/main.rs")
                    .is_some_and(|name| !name.contains('/'))
        })
}

/// The `[lib]` and `[[bin]]` paths `manifest` sets, relative to `src/`, and a failure for each
/// one outside `src/`.
fn manifest_roots(manifest: &str) -> (Vec<String>, Vec<String>) {
    let mut roots = Vec::new();
    let mut outside = Vec::new();
    let mut section = "";
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
            continue;
        }
        if !matches!(section, "[lib]" | "[[bin]]") {
            continue;
        }
        let Some(value) = line
            .strip_prefix("path")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
        else {
            continue;
        };
        let path = value.trim().trim_matches('"');
        match path.strip_prefix("src/") {
            Some(root) => roots.push(root.to_owned()),
            None => outside.push(format!(
                "Cargo.toml: the {section} path {path}, outside src/: the guard cannot follow it"
            )),
        }
    }
    (roots, outside)
}

/// Scan `sources`. From the crate roots it follows every load to the real file it names; a file
/// is gated when it gates itself, or when it is no root, has at least one load and each is gated
/// or sits in a gated file. Each ungated file's hits count, and a webdriver-only file (one a
/// [`WEBDRIVER_MODULES`] module holds or loads) that is not gated is itself a hit.
fn scan_tree(sources: &Sources) -> TreeScan {
    let scans: BTreeMap<&str, FileScan> = sources
        .files
        .iter()
        .map(|(file, source)| (file.as_str(), scan_file(file, source)))
        .collect();
    let mut unfollowed: Vec<String> = scans
        .values()
        .flat_map(|scan| scan.rejected.iter().cloned())
        .chain(sources.unread.iter().cloned())
        .collect();
    let mut roots: BTreeSet<&str> = scans
        .keys()
        .copied()
        .filter(|file| placed_root(file))
        .collect();
    for root in &sources.roots {
        match scans.get_key_value(sources.resolve(root)) {
            Some((file, _)) => {
                roots.insert(file);
            }
            None => unfollowed.push(format!(
                "Cargo.toml: the crate root {root}, a file the guard did not read"
            )),
        }
    }
    // Every load of each file: (loading file, whether the load is gated).
    let mut parents: BTreeMap<&str, BTreeSet<(&str, bool)>> = BTreeMap::new();
    let mut children: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    // Each file as the crate loads it, and whether that load lets it own its directory.
    let mut seen: BTreeSet<(&str, bool)> = BTreeSet::new();
    let mut queue: Vec<(&str, bool)> = roots.iter().map(|root| (*root, true)).collect();
    while let Some((file, owns_dir)) = queue.pop() {
        if !seen.insert((file, owns_dir)) {
            continue;
        }
        for decl in &scans[file].loads {
            let at = format!("{file}:{}", decl.line);
            let Some(targets) = load_targets(file, owns_dir, decl) else {
                unfollowed.push(format!(
                    "{at}: an absolute path: the guard cannot follow it"
                ));
                continue;
            };
            if let Some(out) = targets
                .iter()
                .find(|t| t.starts_with("../") && !OUT_OF_SRC.contains(&t.as_str()))
            {
                unfollowed.push(format!(
                    "{at}: {out}, a path outside src/: the guard cannot follow it"
                ));
                continue;
            }
            let found: BTreeSet<&str> = targets
                .iter()
                .filter_map(|t| scans.get_key_value(sources.resolve(t)).map(|(k, _)| *k))
                .collect();
            if found.is_empty() {
                unfollowed.push(format!(
                    "{at}: {} loads {}, a file the guard did not read",
                    decl.load,
                    targets.join(" or ")
                ));
            }
            for child in found {
                parents.entry(child).or_default().insert((file, decl.gated));
                children.entry(file).or_default().insert(child);
                let child_owns_dir = match decl.load {
                    Load::Mod(_) => child.ends_with("/mod.rs"),
                    Load::Path(_) | Load::Include(_) => true,
                };
                queue.push((child, child_owns_dir));
            }
        }
    }
    struct Graph<'a, 'b> {
        scans: &'b BTreeMap<&'a str, FileScan>,
        parents: &'b BTreeMap<&'a str, BTreeSet<(&'a str, bool)>>,
        roots: &'b BTreeSet<&'a str>,
    }
    fn gated<'a>(
        file: &'a str,
        graph: &Graph<'a, '_>,
        memo: &mut BTreeMap<&'a str, Option<bool>>,
    ) -> bool {
        match memo.get(file) {
            Some(Some(known)) => return *known,
            Some(None) => panic!("the module loads through {file} loop"),
            None => {}
        }
        memo.insert(file, None);
        // A crate root is loaded by cargo, ungated, whatever else loads it.
        let root = graph.roots.contains(file);
        let loads = graph.parents.get(file);
        let answer = graph.scans[file].gated
            || !root
                && loads.is_some_and(|loads| {
                    !loads.is_empty()
                        && loads
                            .iter()
                            .all(|(up, load_gated)| *load_gated || gated(up, graph, memo))
                });
        memo.insert(file, Some(answer));
        answer
    }
    // The webdriver-only files: the modules' own, and every file they load.
    let mut webdriver: BTreeSet<&str> = scans
        .keys()
        .copied()
        .filter(|file| webdriver_only(file))
        .collect();
    let mut pending: Vec<&str> = webdriver.iter().copied().collect();
    while let Some(file) = pending.pop() {
        for child in children.get(file).into_iter().flatten() {
            if webdriver.insert(child) {
                pending.push(child);
            }
        }
    }
    // A file loaded both as a mod.rs and not is followed twice; report each load once.
    unfollowed.sort();
    unfollowed.dedup();
    let graph = Graph {
        scans: &scans,
        parents: &parents,
        roots: &roots,
    };
    let mut memo = BTreeMap::new();
    let mut hits = Vec::new();
    let mut commands = Vec::new();
    for (file, scan) in &scans {
        commands.extend(scan.commands.iter().cloned());
        if !gated(file, &graph, &mut memo) {
            if webdriver.contains(file) {
                hits.push(format!(
                    "{file}:1: the webdriver-only module {file} outside #[cfg(feature = \"{FEATURE}\")]"
                ));
            }
            hits.extend(scan.hits.iter().cloned());
        }
    }
    TreeScan {
        hits,
        unfollowed,
        commands,
        webdriver: webdriver.into_iter().map(str::to_owned).collect(),
    }
}

/// `path` relative to `base`, `/`-separated, or `None` when it is not under `base`.
fn relative(path: &Path, base: &Path) -> Option<String> {
    let rest = path.strip_prefix(base).ok()?;
    Some(rest.to_string_lossy().replace('\\', "/"))
}

/// The real path of `path` relative to the real `src`: under it, or one of [`OUT_OF_SRC`].
fn real_name(path: &Path, src: &Path) -> Option<String> {
    let real = fs::canonicalize(path).ok()?;
    if let Some(name) = relative(&real, src) {
        return Some(name);
    }
    let up = format!("../{}", relative(&real, src.parent()?)?);
    OUT_OF_SRC.contains(&up.as_str()).then_some(up)
}

/// Read each `.rs` file under `dir` (a directory under `root`, the `src/` walked; `src` is its
/// real path) by its real path, recording any other name it was read under. A link to a
/// directory is walked under its own name too, unless it leads back into `walking` (the real
/// directories being walked), so a link loop ends.
fn read_tree(dir: &Path, root: &Path, src: &Path, out: &mut Sources, walking: &mut Vec<PathBuf>) {
    let real =
        fs::canonicalize(dir).unwrap_or_else(|error| panic!("read {}: {error}", dir.display()));
    if walking.contains(&real) {
        return;
    }
    walking.push(real);
    for entry in fs::read_dir(dir).unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
    {
        let path = entry.expect("read entry").path();
        if path.is_dir() {
            read_tree(&path, root, src, out, walking);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let name = relative(&path, root).expect("a walked file is under src/");
            let Some(file) = real_name(&path, src) else {
                out.unread.push(format!(
                    "{name}: a link to a file outside src/: the guard cannot follow it"
                ));
                continue;
            };
            if file != name {
                out.aliases.insert(name, file.clone());
            }
            out.files.insert(file, fs::read_to_string(&path).unwrap());
        }
    }
    walking.pop();
}

/// The sources of the crate at `crate_dir`: every `.rs` file under `src/`, [`OUT_OF_SRC`], and
/// the roots its `Cargo.toml` names.
fn crate_sources(crate_dir: &Path) -> Sources {
    let root = crate_dir.join("src");
    let src =
        fs::canonicalize(&root).unwrap_or_else(|error| panic!("read {}: {error}", root.display()));
    let mut sources = Sources::new(BTreeMap::new());
    read_tree(&root, &root, &src, &mut sources, &mut Vec::new());
    for file in OUT_OF_SRC {
        let path = root.join(file);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        sources.files.insert(file.to_owned(), source);
    }
    let manifest = crate_dir.join("Cargo.toml");
    let manifest = fs::read_to_string(&manifest)
        .unwrap_or_else(|error| panic!("read {}: {error}", manifest.display()));
    let (roots, outside) = manifest_roots(&manifest);
    sources.roots = roots;
    sources.unread.extend(outside);
    sources
}

fn app_tree() -> Sources {
    crate_sources(&app_root())
}

fn sources(files: &[(&str, &str)]) -> Sources {
    Sources::new(
        files
            .iter()
            .map(|(file, source)| ((*file).to_owned(), (*source).to_owned()))
            .collect(),
    )
}

/// A scan's hits, then the loads it cannot follow.
fn findings(sources: &Sources) -> Vec<String> {
    let scan = scan_tree(sources);
    scan.hits.into_iter().chain(scan.unfollowed).collect()
}

fn tree(files: &[(&str, &str)]) -> Vec<String> {
    findings(&sources(files))
}

fn one(source: &str) -> Vec<String> {
    tree(&[("lib.rs", source)])
}

#[test]
fn no_webdriver_code_outside_the_feature_gate() {
    let sources = app_tree();
    let files = &sources.files;
    assert!(files.len() > 100, "scanned only {} files", files.len());
    let scan = scan_tree(&sources);
    assert!(
        scan.unfollowed.is_empty(),
        "the guard must follow every module load to a file it read:\n{}",
        scan.unfollowed.join("\n")
    );
    assert!(
        scan.hits.is_empty(),
        "put test-only WebDriver code under #[cfg(feature = \"{FEATURE}\")]:\n{}",
        scan.hits.join("\n")
    );
    // The module the gate must cover is still where WEBDRIVER_MODULES says.
    assert!(
        files.keys().any(|file| webdriver_only(file)),
        "no file under {WEBDRIVER_MODULES:?}: update the list"
    );
    // scripts/clippy-webdriver-module.mjs lints the modules' own files, so the modules load
    // nothing from outside them.
    let outside: Vec<&String> = scan
        .webdriver
        .iter()
        .filter(|file| !webdriver_only(file))
        .collect();
    assert!(
        outside.is_empty(),
        "the webdriver-only modules load {outside:?} from outside {WEBDRIVER_MODULES:?}, which the \
         clippy judge does not lint: move them in, or widen both lists"
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
    let sources = app_tree();
    let lib = &sources.files["lib.rs"];
    assert!(
        lib.contains("wv_e2e_seed_dispatch") && lib.contains("wv_e2e_terminal_read"),
        "the run-time-gated wv_e2e_* commands this allowance names are still registered"
    );
    assert!(
        scan_tree(&sources)
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
            vec![
                format!("windows/e2e.rs:1: the webdriver-only module windows/e2e.rs outside #[cfg(feature = \"{FEATURE}\")]"),
                format!("windows/e2e.rs:2: the command e2e_open_window outside #[cfg(feature = \"{FEATURE}\")]"),
            ],
            "{declaration}"
        );
    }
    // A file no declaration reaches is scanned on its own.
    assert_eq!(tree(&[("lib.rs", ""), ("windows/e2e.rs", e2e)]).len(), 2);
}

#[test]
fn fails_a_webdriver_only_module_that_holds_no_command() {
    // Helpers, types and constants only: nothing a per-item rule would name.
    let helpers = "pub(crate) fn seed_at() {}\npub struct Seeded;\nconst PROBE: &[u8] = b\"\";";
    let gate = format!("outside #[cfg(feature = \"{FEATURE}\")]");
    for (layout, child) in [
        (["windows/mod.rs", "windows/e2e.rs"], "pub mod e2e;"),
        (["windows/mod.rs", "windows/e2e/mod.rs"], "pub mod e2e;"),
    ] {
        let hits = tree(&[
            ("lib.rs", "mod windows;"),
            (layout[0], child),
            (layout[1], helpers),
        ]);
        assert_eq!(
            hits,
            vec![format!(
                "{}:1: the webdriver-only module {} {gate}",
                layout[1], layout[1]
            )],
            "{layout:?}"
        );
    }
    // A file deeper in the module is a hit of its own.
    let hits = tree(&[
        ("lib.rs", "mod windows;"),
        ("windows/mod.rs", "pub mod e2e;"),
        ("windows/e2e.rs", "mod seed;"),
        ("windows/e2e/seed.rs", helpers),
    ]);
    assert_eq!(
        hits,
        ["windows/e2e.rs", "windows/e2e/seed.rs"]
            .map(|file| format!("{file}:1: the webdriver-only module {file} {gate}"))
            .to_vec()
    );
    // Gated, the same module passes, and a like-named module elsewhere is not webdriver-only.
    assert!(tree(&[
        ("lib.rs", "mod windows;"),
        (
            "windows/mod.rs",
            "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;"
        ),
        ("windows/e2e.rs", helpers),
    ])
    .is_empty());
    assert!(!webdriver_only("windows/e2e_names.rs"));
    assert!(!webdriver_only("other/windows/e2e.rs"));
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
        ("windows/e2e/seed.rs", seed),
    ]);
    assert_eq!(hits, Vec::<String>::new());
}

fn module_hit(file: &str) -> String {
    format!("{file}:1: the webdriver-only module {file} outside #[cfg(feature = \"{FEATURE}\")]")
}

#[test]
fn follows_path_and_include_loads_of_the_module() {
    let helpers = "pub(crate) fn seed_at() {}";
    let gated_e2e = "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;";
    // An ungated `#[path]` load of windows/e2e.rs, beside its gated `mod e2e;`.
    let hits = tree(&[
        (
            "lib.rs",
            "mod windows;\n#[path = \"windows/e2e.rs\"]\nmod again;",
        ),
        ("windows/mod.rs", gated_e2e),
        ("windows/e2e.rs", helpers),
    ]);
    assert_eq!(hits, vec![module_hit("windows/e2e.rs")]);
    // An ungated `include!` of a file under windows/e2e/.
    let hits = tree(&[
        ("lib.rs", "mod windows;\nmod other;"),
        ("windows/mod.rs", gated_e2e),
        ("windows/e2e.rs", "mod part;"),
        ("windows/e2e/part.rs", helpers),
        ("other.rs", "include!(\"windows/e2e/part.rs\");"),
    ]);
    assert_eq!(hits, vec![module_hit("windows/e2e/part.rs")]);
    // Gated, the same `#[path]` and `include!` pass. A file `#[path]` loads owns its directory,
    // as rustc has it, so this e2e.rs declares no `mod part;`: that would load windows/part.rs.
    assert_eq!(
        tree(&[
            (
                "lib.rs",
                "mod windows;\n#[cfg(feature = \"e2e-webdriver\")]\n#[path = \"windows/e2e.rs\"]\nmod again;\n#[cfg(test)]\nmod t {\n    include!(\"windows/e2e/part.rs\");\n}"
            ),
            ("windows/mod.rs", gated_e2e),
            ("windows/e2e.rs", helpers),
            ("windows/e2e/part.rs", helpers),
        ]),
        Vec::<String>::new()
    );
    // A `#[path]` inside inline modules resolves from the file's directory, its stem (not a
    // mod.rs) and the inline modules: here back to windows/e2e.rs, ungated.
    let hits = tree(&[
        ("lib.rs", "mod windows;"),
        (
            "windows/mod.rs",
            "mod host;\n#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;",
        ),
        (
            "windows/host.rs",
            "mod a {\n    mod b {\n        #[path = \"../../../e2e.rs\"]\n        mod x;\n    }\n}",
        ),
        ("windows/e2e.rs", helpers),
    ]);
    assert_eq!(hits, vec![module_hit("windows/e2e.rs")]);
}

#[test]
fn a_file_the_module_loads_is_webdriver_only() {
    let helpers = "pub(crate) fn seed_at() {}";
    let base = [
        ("lib.rs", "mod windows;\nmod util;"),
        (
            "windows/mod.rs",
            "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;",
        ),
        (
            "windows/e2e.rs",
            "#[path = \"../util/seed_helper.rs\"]\nmod seed_helper;",
        ),
        ("util/seed_helper.rs", helpers),
    ];
    // Reached from e2e.rs and also loaded ungated: a hit.
    let mut files = base.to_vec();
    files.push(("util/mod.rs", "pub mod seed_helper;"));
    assert_eq!(tree(&files), vec![module_hit("util/seed_helper.rs")]);
    // Reached only from e2e.rs, it is gated with it.
    let mut files = base.to_vec();
    files.push(("util/mod.rs", ""));
    assert_eq!(tree(&files), Vec::<String>::new());
    // A file the module does not load is not webdriver-only, gated or not.
    let files = [
        ("lib.rs", "mod util;"),
        ("util/mod.rs", "pub mod seed_helper;"),
        ("util/seed_helper.rs", helpers),
    ];
    assert_eq!(tree(&files), Vec::<String>::new());
}

#[test]
fn a_file_no_load_reaches_is_not_gated() {
    // No load, so no vacuous "every load is gated".
    let helpers = "pub(crate) fn seed_at() {}";
    assert_eq!(
        tree(&[("lib.rs", ""), ("windows/e2e/seed.rs", helpers)]),
        vec![module_hit("windows/e2e/seed.rs")]
    );
    assert_eq!(
        tree(&[("lib.rs", ""), ("stray.rs", "use tauri_plugin_wdio::init;")]),
        vec![format!(
            "stray.rs:1: tauri_plugin_wdio outside #[cfg(feature = \"{FEATURE}\")]"
        )]
    );
    // A crate root another file loads gated is still a root, and ungated.
    assert_eq!(
        tree(&[
            ("lib.rs", "#[cfg(test)]\n#[path = \"main.rs\"]\nmod again;"),
            ("main.rs", "use tauri_plugin_wdio::init;"),
        ]),
        vec![format!(
            "main.rs:1: tauri_plugin_wdio outside #[cfg(feature = \"{FEATURE}\")]"
        )]
    );
}

#[test]
fn fails_each_load_it_cannot_follow() {
    let cannot = "the guard cannot follow it";
    let planted = [
        (
            "#[path = concat!(\"a\", \".rs\")]\nmod a;",
            format!("lib.rs:1: a #[path] that is not a string literal: {cannot}"),
        ),
        (
            "include!(concat!(env!(\"OUT_DIR\"), \"/a.rs\"));",
            format!("lib.rs:1: an include! whose path is not a string literal: {cannot}"),
        ),
        (
            "#[path = \"/src/a.rs\"]\nmod b;",
            format!("lib.rs:2: an absolute path: {cannot}"),
        ),
        (
            "include!(\"/src/a.rs\");",
            format!("lib.rs:1: an absolute path: {cannot}"),
        ),
        (
            "#[path = \"../a.rs\"]\nmod b;",
            format!("lib.rs:2: ../a.rs, a path outside src/: {cannot}"),
        ),
        (
            "mod m {\n    include!(\"x/../../../a.rs\");\n}",
            format!("lib.rs:2: ../../a.rs, a path outside src/: {cannot}"),
        ),
        (
            "#[cfg_attr(unix, path = \"a.rs\")]\nmod a;",
            format!("lib.rs:1: a cfg_attr that sets a module's path: {cannot}"),
        ),
        (
            "#[cfg_attr(unix, cfg_attr(test, path = \"a.rs\"))]\nmod a;",
            format!("lib.rs:1: a cfg_attr that sets a module's path: {cannot}"),
        ),
        (
            "#[path = \"x\"]\nmod inline {}",
            format!("lib.rs:2: a #[path] on an inline mod: {cannot}"),
        ),
        (
            "fn f() {\n    #[path = \"a.rs\"]\n    mod a;\n}",
            format!("lib.rs:3: an out-of-line mod inside a block: {cannot}"),
        ),
        // A load that names no file the guard read fails, gated or not.
        (
            "#[path = \"missing.rs\"]\nmod b;",
            "lib.rs:2: #[path = \"missing.rs\"] loads missing.rs, a file the guard did not read"
                .to_owned(),
        ),
        (
            "#[cfg(feature = \"e2e-webdriver\")]\ninclude!(\"missing.rs\");",
            "lib.rs:2: include!(\"missing.rs\") loads missing.rs, a file the guard did not read"
                .to_owned(),
        ),
        (
            "#[cfg(test)]\nmod missing;",
            "lib.rs:2: mod missing; loads missing.rs or missing/mod.rs, a file the guard did not read"
                .to_owned(),
        ),
    ];
    for (source, expected) in planted {
        // `a.rs` is there for the forms that name it, so only the rejection fails.
        assert_eq!(
            tree(&[("lib.rs", source), ("a.rs", "")]),
            vec![expected],
            "{source}"
        );
    }
}

#[test]
fn fails_each_module_load_in_a_macro_body() {
    let cannot = "inside a macro body: the guard cannot follow it";
    let planted = [
        // A `macro_rules!` arm that loads windows/e2e.rs a second time.
        (
            "macro_rules! load {\n    () => {\n        #[path = \"windows/e2e.rs\"]\n        mod again;\n    };\n}\nload!();",
            vec![
                format!("lib.rs:3: a #[path] {cannot}"),
                format!("lib.rs:4: a mod declaration {cannot}"),
            ],
        ),
        (
            "macro_rules! load {\n    ($name:ident) => {\n        mod $name;\n    };\n}",
            vec![format!("lib.rs:3: a mod declaration {cannot}")],
        ),
        (
            "macro_rules! load {\n    () => {\n        include!(\"windows/e2e.rs\");\n    };\n}",
            vec![format!("lib.rs:3: an include! {cannot}")],
        ),
        // A cfg_if!-style item macro.
        (
            "cfg_if! {\n    if #[cfg(unix)] {\n        mod windows;\n    }\n}",
            vec![format!("lib.rs:3: a mod declaration {cannot}")],
        ),
        (
            "wrap! { #[cfg_attr(unix, path = \"a.rs\")] mod a; }",
            vec![
                format!("lib.rs:1: a cfg_attr that may set a module's path {cannot}"),
                format!("lib.rs:1: a mod declaration {cannot}"),
            ],
        ),
        // A statement macro, and an expression macro whose body is no expression list.
        (
            "fn f() {\n    wrap! { mod a; }\n}",
            vec![format!("lib.rs:2: a mod declaration {cannot}")],
        ),
        (
            "fn f() {\n    let _ = wrap!(#[path = \"a.rs\"] mod a;);\n}",
            vec![
                format!("lib.rs:2: a #[path] {cannot}"),
                format!("lib.rs:2: a mod declaration {cannot}"),
            ],
        ),
        // A renamed include.
        (
            "use std::include as load;\nload!(\"windows/e2e.rs\");",
            vec!["lib.rs:1: an include renamed by use: the guard cannot follow it".to_owned()],
        ),
        (
            "use core::{include as load, panic};",
            vec!["lib.rs:1: an include renamed by use: the guard cannot follow it".to_owned()],
        ),
    ];
    for (source, expected) in planted {
        assert_eq!(one(source), expected, "{source}");
    }
    // The words in a string, an include! the guard follows, and an expression list pass.
    assert_eq!(
        tree(&[
            (
                "lib.rs",
                "include!(\"a.rs\");\nfn f() {\n    assert_eq!(1, 1, \"mod a; include!\");\n    let _ = format!(\"{}\", include!(\"a.rs\"));\n}"
            ),
            ("a.rs", ""),
        ]),
        Vec::<String>::new()
    );
}

#[test]
fn every_crate_root_is_followed_ungated() {
    let helpers = "pub(crate) fn seed_at() {}";
    let gated_e2e = "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;";
    let base = [
        ("lib.rs", "mod windows;"),
        ("windows/mod.rs", gated_e2e),
        ("windows/e2e.rs", helpers),
    ];
    // A bin root cargo finds by its place loads the module ungated.
    for (root, source) in [
        ("bin/tool.rs", "#[path = \"../windows/e2e.rs\"]\nmod e2e;"),
        (
            "bin/tool/main.rs",
            "#[path = \"../../windows/e2e.rs\"]\nmod e2e;",
        ),
    ] {
        let mut files = base.to_vec();
        files.push((root, source));
        assert_eq!(tree(&files), vec![module_hit("windows/e2e.rs")], "{root}");
    }
    // A root Cargo.toml names: unread, the file is no root and its load is not followed.
    let mut files = base.to_vec();
    files.push((
        "tools/driver.rs",
        "#[path = \"../windows/e2e.rs\"]\nmod e2e;",
    ));
    assert_eq!(tree(&files), Vec::<String>::new());
    let mut named = sources(&files);
    named.roots = vec!["tools/driver.rs".to_owned()];
    assert_eq!(findings(&named), vec![module_hit("windows/e2e.rs")]);
    named.roots = vec!["missing.rs".to_owned()];
    assert_eq!(
        findings(&named),
        vec!["Cargo.toml: the crate root missing.rs, a file the guard did not read".to_owned()]
    );
    // Where cargo finds roots, and which manifest paths name them.
    for (file, root) in [
        ("lib.rs", true),
        ("main.rs", true),
        ("bin/a.rs", true),
        ("bin/a/main.rs", true),
        ("bin/a/b.rs", false),
        ("x/bin/a.rs", false),
        ("x/main.rs", false),
    ] {
        assert_eq!(placed_root(file), root, "{file}");
    }
    let manifest = "[package]\nname = \"x\"\npath = \"src/no.rs\"\n\n[lib]\nname = \"l\"\npath = \"src/l.rs\"\n\n[[bin]]\nname = \"b\"\npath=\"src/bin/b.rs\"\n\n[[bin]]\npath = \"tools/c.rs\"\n\n[[test]]\npath = \"tests/t.rs\"\n";
    assert_eq!(
        manifest_roots(manifest),
        (
            vec!["l.rs".to_owned(), "bin/b.rs".to_owned()],
            vec![
                "Cargo.toml: the [[bin]] path tools/c.rs, outside src/: the guard cannot follow it"
                    .to_owned()
            ]
        )
    );
}

#[test]
fn a_file_read_under_a_second_name_is_the_same_file() {
    let helpers = "pub(crate) fn seed_at() {}";
    let gated_e2e = "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;";
    // A second relative spelling folds to the same path.
    assert_eq!(
        tree(&[
            (
                "lib.rs",
                "mod windows;\n#[path = \"windows/./e2e/../e2e.rs\"]\nmod again;"
            ),
            ("windows/mod.rs", gated_e2e),
            ("windows/e2e.rs", helpers),
        ]),
        vec![module_hit("windows/e2e.rs")]
    );
    // A name the reader found to be a link resolves to the real file.
    let mut linked = sources(&[
        ("lib.rs", "mod windows;\nmod util;"),
        ("windows/mod.rs", gated_e2e),
        ("windows/e2e.rs", helpers),
    ]);
    linked
        .aliases
        .insert("util.rs".to_owned(), "windows/e2e.rs".to_owned());
    assert_eq!(findings(&linked), vec![module_hit("windows/e2e.rs")]);
}

#[cfg(unix)]
#[test]
fn the_reader_resolves_links_to_their_real_files() {
    use std::os::unix::fs::symlink;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "webdriver-cfg-guard-{}-{nanos}",
        std::process::id()
    ));
    let write = |file: &str, text: &str| {
        let path = dir.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    };
    write("Cargo.toml", "[package]\nname = \"t\"\n");
    write("build_caps.rs", "");
    write("outside.rs", "");
    write(
        "src/lib.rs",
        "mod windows;\nmod util;\n#[path = \"linked/e2e.rs\"]\nmod again;",
    );
    write(
        "src/windows/mod.rs",
        "#[cfg(feature = \"e2e-webdriver\")]\npub mod e2e;",
    );
    write("src/windows/e2e.rs", "pub(crate) fn seed_at() {}");
    // A file link, a directory link and a link back up (a loop).
    symlink("windows/e2e.rs", dir.join("src/util.rs")).unwrap();
    symlink("windows", dir.join("src/linked")).unwrap();
    symlink("..", dir.join("src/windows/up")).unwrap();
    let read = crate_sources(&dir);
    assert_eq!(
        read.aliases,
        BTreeMap::from([
            ("linked/e2e.rs".to_owned(), "windows/e2e.rs".to_owned()),
            ("linked/mod.rs".to_owned(), "windows/mod.rs".to_owned()),
            ("util.rs".to_owned(), "windows/e2e.rs".to_owned()),
        ])
    );
    assert_eq!(findings(&read), vec![module_hit("windows/e2e.rs")]);
    // A link out of src/ fails.
    symlink("../outside.rs", dir.join("src/out.rs")).unwrap();
    let read = crate_sources(&dir);
    fs::remove_dir_all(&dir).unwrap();
    assert!(
        findings(&read).contains(
            &"out.rs: a link to a file outside src/: the guard cannot follow it".to_owned()
        ),
        "{:?}",
        findings(&read)
    );
}

#[test]
fn the_clippy_judge_lints_the_webdriver_modules() {
    let path = app_root()
        .parent()
        .expect("src-tauri has a parent")
        .join("scripts/clippy-webdriver-module.mjs");
    let judge = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let modules: Vec<String> = WEBDRIVER_MODULES
        .iter()
        .map(|module| module.replace('/', "\\/"))
        .collect();
    let modules = match modules.as_slice() {
        [one] => one.clone(),
        many => format!("(?:{})", many.join("|")),
    };
    let expected = format!("const MODULE = /(?:^|\\/)src-tauri\\/src\\/{modules}(?:\\.rs$|\\/)/;");
    assert!(
        judge.lines().any(|line| line == expected),
        "the clippy judge must lint exactly {WEBDRIVER_MODULES:?}: {expected}"
    );
}

#[test]
fn reads_and_scans_the_one_file_outside_src() {
    let caps = "mod caps_table {\n    include!(\"../build_caps.rs\");\n}";
    assert_eq!(
        tree(&[
            ("lib.rs", "mod platform_caps;"),
            ("platform_caps.rs", caps),
            ("../build_caps.rs", "pub enum Support { On }"),
        ]),
        Vec::<String>::new()
    );
    assert_eq!(
        tree(&[
            ("lib.rs", "mod platform_caps;"),
            ("platform_caps.rs", caps),
            ("../build_caps.rs", "use tauri_plugin_wdio::init;"),
        ]),
        vec![format!(
            "../build_caps.rs:1: tauri_plugin_wdio outside #[cfg(feature = \"{FEATURE}\")]"
        )]
    );
}

#[test]
fn loads_resolve_as_rustc_resolves_them() {
    let at = |file: &str, owns_dir: bool, load: Load, inline: &[&str]| {
        let decl = Decl {
            load,
            inline: inline.iter().map(|m| (*m).to_owned()).collect(),
            line: 1,
            gated: false,
        };
        load_targets(file, owns_dir, &decl)
    };
    let module = |name: &str| Load::Mod(name.to_owned());
    let path = |p: &str| Load::Path(p.to_owned());
    let include = |p: &str| Load::Include(p.to_owned());
    let files = |list: &[&str]| Some(list.iter().map(|f| (*f).to_owned()).collect::<Vec<_>>());
    assert_eq!(
        at("lib.rs", true, module("windows"), &[]),
        files(&["windows.rs", "windows/mod.rs"])
    );
    assert_eq!(
        at("windows/mod.rs", true, module("e2e"), &[]),
        files(&["windows/e2e.rs", "windows/e2e/mod.rs"])
    );
    assert_eq!(
        at("windows/e2e.rs", false, module("seed"), &[]),
        files(&["windows/e2e/seed.rs", "windows/e2e/seed/mod.rs"])
    );
    // A file a `#[path]` or `include!` loads owns its directory, like a mod.rs.
    assert_eq!(
        at("windows/e2e.rs", true, module("seed"), &[]),
        files(&["windows/seed.rs", "windows/seed/mod.rs"])
    );
    assert_eq!(
        at("mcp/identity_tools.rs", false, module("x"), &["tests"]),
        files(&[
            "mcp/identity_tools/tests/x.rs",
            "mcp/identity_tools/tests/x/mod.rs"
        ])
    );
    // `#[path]` outside inline modules: from the file's directory, for either kind of file.
    assert_eq!(
        at(
            "agents/guardrails.rs",
            false,
            path("guardrails_tests.rs"),
            &[]
        ),
        files(&["agents/guardrails_tests.rs"])
    );
    // Inside them: plus the stem of a file that is not a mod.rs, plus the inline modules.
    assert_eq!(
        at(
            "mcp/identity_tools.rs",
            false,
            path("engine.rs"),
            &["tests"]
        ),
        files(&["mcp/identity_tools/tests/engine.rs"])
    );
    assert_eq!(
        at("mcp/mod.rs", true, path("engine.rs"), &["tests", "inner"]),
        files(&["mcp/tests/inner/engine.rs"])
    );
    // `include!`: from the file's directory, never the inline modules.
    assert_eq!(
        at(
            "commands/launch.rs",
            false,
            include("launch/story_tests.rs"),
            &["tests"]
        ),
        files(&["commands/launch/story_tests.rs"])
    );
    // `..` folds; a path out of src/ keeps its `..`; an absolute path resolves to nothing.
    assert_eq!(
        at(
            "platform_caps.rs",
            false,
            include("../build_caps.rs"),
            &["caps_table"]
        ),
        files(&["../build_caps.rs"])
    );
    assert_eq!(
        at("a/b.rs", false, path("./c/../d.rs"), &[]),
        files(&["a/d.rs"])
    );
    assert_eq!(at("lib.rs", true, path("/etc/a.rs"), &[]), None);
    assert_eq!(at("lib.rs", true, include("C:\\a.rs"), &[]), None);
}
