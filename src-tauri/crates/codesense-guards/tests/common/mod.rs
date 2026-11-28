// SPDX-License-Identifier: MIT
//! Helpers the source guards share: walking the sources and skipping test code.
//!
//! Test code is items under `cfg(test)` or `cfg(all(test, ..))` (not `cfg(not(test))` or
//! `cfg(any(test, ..))`, which build in production), `#[test]` functions, and files that only
//! tests include (`*_tests.rs`, `tests.rs`, `tests/`).

use std::path::{Path, PathBuf};

/// Whether `label` (relative to a source root) is a file only tests include: `*_tests.rs`,
/// `tests.rs` or anything under `tests/`.
pub fn is_test_file(label: &str) -> bool {
    let name = label.rsplit('/').next().unwrap_or(label);
    name.ends_with("_tests.rs")
        || name == "tests.rs"
        || label.contains("/tests/")
        || label.starts_with("tests/")
}

/// Whether `meta` (a `cfg` predicate) holds only in a test build: `test`, or an `all(..)` with
/// one. `not(test)` and `any(test, ..)` build in production, so they are scanned.
pub fn test_only(meta: &syn::Meta) -> bool {
    match meta {
        syn::Meta::Path(path) => path.is_ident("test"),
        syn::Meta::List(list) if list.path.is_ident("all") => list
            .parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            )
            .is_ok_and(|args| args.iter().any(test_only)),
        _ => false,
    }
}

/// Whether `attrs` mark an item as test code: `#[test]`, or a `cfg` that [`test_only`] holds.
pub fn names_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        if path.is_ident("test") {
            return true;
        }
        path.is_ident("cfg")
            && attr
                .parse_args::<syn::Meta>()
                .is_ok_and(|meta| test_only(&meta))
    })
}

/// Every `.rs` file under `dir`, recursively, appended to `out` unsorted.
pub fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
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
