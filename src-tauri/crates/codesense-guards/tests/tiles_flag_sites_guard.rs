// SPDX-License-Identifier: MIT
//! Every Rust site the tiles flag gates is listed, and each listed one returns before it does
//! anything when the flag is off.
//!
//! `src/shared/lib/tiles-flag-sites.json` lists the tiles flag's sites. `tiles-flag.guard.test.ts`
//! checks its TS entries; this guard checks its Rust entries, `{file, fn, what}`, one per gated
//! function: `Type::method` for a method of an inherent or trait impl (`Trait::method` for a
//! trait's default method), a bare name for a free or nested fn. Each listed file must exist,
//! hold the fn, and the fn body's first statement must be the flag-off early return:
//!
//! - an `if` with no `else`, whose condition is the negated flag: `!tiles`, `!<expr>.tiles`,
//!   `!<expr>.is_on()`, `!TilesFlag::is_on(..)` or `!tiles_enabled(..)`, parentheses allowed;
//! - whose block is one `return` statement: `return;`, `return <expr>;` or `return <expr>`.
//!
//! The reverse holds too: every production fn under `src/` whose own body holds such an `if`, at
//! any depth, is listed. A nested fn item is its own fn, and closures and async blocks are
//! skipped, since their `return` leaves only them. Comments and strings are never code.
//!
//! The check is syntactic and keyed on those names, so a flag threaded under another name gets
//! through, as does a flag-off branch that does other work before it returns. Test code is
//! skipped as `group_file_writer_guard.rs` skips it. Point `CODESENSE_GUARD_ROOT` at another
//! checkout's `src-tauri` to run it there; the planted self-tests show each form failing.

mod common;

use codesense_guards::guard_support;
use common::{is_test_file, names_test, rust_files};
use std::collections::HashSet;
use syn::visit::{self, Visit};

/// The list, relative to the app directory.
const SITES: &str = "../src/shared/lib/tiles-flag-sites.json";

/// How a Rust entry's `file` starts: the app's sources, from the repo root.
const PREFIX: &str = "src-tauri/src/";

/// The fix an unlisted site's failure names.
const FIX: &str = "add {file, fn, what} to src/shared/lib/tiles-flag-sites.json";

/// Whether `expr` reads the tiles flag: `tiles`, `<expr>.tiles`, `<expr>.is_on()`,
/// `TilesFlag::is_on(..)` or `tiles_enabled(..)`.
fn is_flag(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Paren(inner) => is_flag(&inner.expr),
        syn::Expr::Group(inner) => is_flag(&inner.expr),
        syn::Expr::Path(path) => path.qself.is_none() && path.path.is_ident("tiles"),
        syn::Expr::Field(field) => {
            matches!(&field.member, syn::Member::Named(name) if name == "tiles")
        }
        syn::Expr::MethodCall(call) => call.method == "is_on" && call.args.is_empty(),
        syn::Expr::Call(call) => match &*call.func {
            syn::Expr::Path(func) => {
                let names: Vec<String> = func
                    .path
                    .segments
                    .iter()
                    .map(|segment| segment.ident.to_string())
                    .collect();
                match names.as_slice() {
                    [.., last] if last == "tiles_enabled" => true,
                    [.., owner, last] => owner == "TilesFlag" && last == "is_on",
                    _ => false,
                }
            }
            _ => false,
        },
        _ => false,
    }
}

/// Whether `cond` is the negated flag, parentheses allowed.
fn is_negated_flag(cond: &syn::Expr) -> bool {
    match cond {
        syn::Expr::Paren(inner) => is_negated_flag(&inner.expr),
        syn::Expr::Group(inner) => is_negated_flag(&inner.expr),
        syn::Expr::Unary(unary) => matches!(unary.op, syn::UnOp::Not(_)) && is_flag(&unary.expr),
        _ => false,
    }
}

/// Whether `expr` is the flag-off early return: `if !tiles { return; }` with no `else`, its
/// block one `return` statement.
fn is_flag_off_if(expr: &syn::ExprIf) -> bool {
    expr.else_branch.is_none()
        && is_negated_flag(&expr.cond)
        && matches!(
            expr.then_branch.stmts.as_slice(),
            [syn::Stmt::Expr(syn::Expr::Return(_), _)]
        )
}

/// Whether `stmt` is the flag-off early return.
fn is_flag_off_return(stmt: &syn::Stmt) -> bool {
    matches!(stmt, syn::Stmt::Expr(syn::Expr::If(expr), _) if is_flag_off_if(expr))
}

/// Whether a fn body holds a flag-off early return of its own: nested fns, closures and async
/// blocks are not its own, since their `return` leaves only them.
#[derive(Default)]
struct OwnReturn(bool);

impl<'ast> Visit<'ast> for OwnReturn {
    fn visit_expr_if(&mut self, expr: &'ast syn::ExprIf) {
        self.0 |= is_flag_off_if(expr);
        visit::visit_expr_if(self, expr);
    }

    fn visit_item(&mut self, _: &'ast syn::Item) {}

    fn visit_expr_closure(&mut self, _: &'ast syn::ExprClosure) {}

    fn visit_expr_async(&mut self, _: &'ast syn::ExprAsync) {}
}

/// A production fn: its key in the list, whether its first statement is the flag-off early
/// return, and whether its own body holds one anywhere.
struct FnSite {
    key: String,
    starts_gated: bool,
    gated: bool,
}

/// Collects a source's production fns. `owner` is the impl's self type or the trait the visit
/// is in.
#[derive(Default)]
struct Fns {
    owner: Option<String>,
    found: Vec<FnSite>,
}

impl Fns {
    fn record(&mut self, name: &syn::Ident, block: &syn::Block) {
        let key = match &self.owner {
            Some(owner) => format!("{owner}::{name}"),
            None => name.to_string(),
        };
        let mut own = OwnReturn::default();
        own.visit_block(block);
        self.found.push(FnSite {
            key,
            starts_gated: block.stmts.first().is_some_and(is_flag_off_return),
            gated: own.0,
        });
    }

    /// Visit a fn body for the fns nested in it, which are free fns even inside a method.
    fn nested(&mut self, block: &syn::Block) {
        let owner = self.owner.take();
        self.visit_block(block);
        self.owner = owner;
    }
}

/// The last segment of an impl's self type: `GroupStore` for `impl<T> crate::GroupStore<T>`.
fn type_name(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(path) => path
            .path
            .segments
            .last()
            .map_or_else(String::new, |segment| segment.ident.to_string()),
        syn::Type::Reference(reference) => type_name(&reference.elem),
        syn::Type::Paren(inner) => type_name(&inner.elem),
        syn::Type::Group(inner) => type_name(&inner.elem),
        _ => "_".to_owned(),
    }
}

fn is_test_item(item: &syn::Item) -> bool {
    let attrs = match item {
        syn::Item::Fn(f) => &f.attrs,
        syn::Item::Mod(m) => &m.attrs,
        syn::Item::Impl(i) => &i.attrs,
        syn::Item::Trait(t) => &t.attrs,
        _ => return false,
    };
    names_test(attrs)
}

impl<'ast> Visit<'ast> for Fns {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        if !is_test_item(item) {
            visit::visit_item(self, item);
        }
    }

    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        self.record(&f.sig.ident, &f.block);
        self.nested(&f.block);
    }

    fn visit_item_impl(&mut self, item: &'ast syn::ItemImpl) {
        let owner = self.owner.replace(type_name(&item.self_ty));
        visit::visit_item_impl(self, item);
        self.owner = owner;
    }

    fn visit_item_trait(&mut self, item: &'ast syn::ItemTrait) {
        let owner = self.owner.replace(item.ident.to_string());
        visit::visit_item_trait(self, item);
        self.owner = owner;
    }

    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        if !names_test(&f.attrs) {
            self.record(&f.sig.ident, &f.block);
            self.nested(&f.block);
        }
    }

    fn visit_trait_item_fn(&mut self, f: &'ast syn::TraitItemFn) {
        if let (Some(block), false) = (&f.default, names_test(&f.attrs)) {
            self.record(&f.sig.ident, block);
            self.nested(block);
        }
    }
}

/// A Rust entry of the list: its `file`, from the repo root, and its `fn`.
struct Site {
    file: String,
    func: String,
}

/// The list's Rust entries, those whose `file` ends `.rs`. The TS guard checks their shape.
fn rust_sites(list: &serde_json::Value) -> Vec<Site> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let file = entry.get("file")?.as_str()?;
            let func = entry.get("fn").and_then(serde_json::Value::as_str);
            file.ends_with(".rs").then(|| Site {
                file: file.to_owned(),
                func: func.unwrap_or_default().to_owned(),
            })
        })
        .collect()
}

/// What is wrong with the list's Rust entries against `sources`, the `.rs` files under `src/` as
/// `(file from the repo root, text)`: each listed fn missing or not returning first, each entry
/// listed twice, then each production fn that returns with the flag off but isn't listed.
fn problems(list: &serde_json::Value, sources: &[(String, String)]) -> Vec<String> {
    let mut fns: Vec<(&str, FnSite)> = vec![];
    for (file, text) in sources {
        let label = file.strip_prefix(PREFIX).unwrap_or(file.as_str());
        if is_test_file(label) {
            continue;
        }
        let parsed = syn::parse_file(text).unwrap_or_else(|e| panic!("parse {file}: {e}"));
        if names_test(&parsed.attrs) {
            continue;
        }
        let mut scan = Fns::default();
        scan.visit_file(&parsed);
        fns.extend(scan.found.into_iter().map(|site| (file.as_str(), site)));
    }
    let mut found = vec![];
    let mut listed = HashSet::new();
    for site in rust_sites(list) {
        let at = format!("{} {}", site.file, site.func);
        if !listed.insert(at.clone()) {
            found.push(format!("{at}: listed twice"));
        } else if !sources.iter().any(|(file, _)| *file == site.file) {
            found.push(format!("{}: listed but missing", site.file));
        } else {
            let matching: Vec<&FnSite> = fns
                .iter()
                .filter(|(file, f)| *file == site.file && f.key == site.func)
                .map(|(_, f)| f)
                .collect();
            if matching.is_empty() {
                found.push(format!("{at}: not found"));
            } else if !matching.iter().all(|f| f.starts_gated) {
                found.push(format!(
                    "{at}: its first statement isn't the flag-off early return \
                     (`if !tiles {{ return; }}`)"
                ));
            }
        }
    }
    for (file, f) in &fns {
        let at = format!("{file} {}", f.key);
        if f.gated && !listed.contains(&at) {
            found.push(format!(
                "{at}: returns when the tiles flag is off but isn't listed; {FIX}"
            ));
        }
    }
    found
}

#[test]
fn every_gated_rust_site_is_listed_and_returns_first() {
    let app = guard_support::app_root();
    let path = app.join(SITES);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let list: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    let mut files = vec![];
    rust_files(&app.join("src"), &mut files);
    files.sort();
    let sources: Vec<(String, String)> = files
        .iter()
        .map(|file| {
            let label = guard_support::source_label(file);
            let text = std::fs::read_to_string(file)
                .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
            (format!("{PREFIX}{label}"), text)
        })
        .collect();
    let found = problems(&list, &sources);
    assert!(
        found.is_empty(),
        "every Rust site the tiles flag gates is listed and returns first with the flag off:\n{}",
        found.join("\n")
    );
}
