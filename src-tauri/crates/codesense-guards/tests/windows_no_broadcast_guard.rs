// SPDX-License-Identifier: MIT
//! The window registry sends each change only to the windows it affects.
//!
//! - **No broadcast.** `src/windows/registry.rs` sends slices with `emit_to`, to the
//!   affected labels only. A broadcast (`emit`, `emit_str`, or `emit_filter`, which
//!   reaches every window a filter lets through) would hand one window's slice, and
//!   `main`'s owner map, to every window. The scan ignores comments.
//! - **Private items.** `WindowEntry::items` is private, so only `registry.rs` can
//!   change which window owns an item; the compiler refuses any other writer.
//!
//! Std-only, like the other guards: point `CODESENSE_GUARD_ROOT` at another
//! `src-tauri` to run it on that tree.

use codesense_guards::guard_support::locate;
use std::fs;

const REGISTRY: &str = "windows/registry.rs";

/// The broadcast calls of tauri's `Emitter`.
const BROADCASTS: [&str; 3] = ["emit", "emit_str", "emit_filter"];

/// `(line number, line)` for each broadcast call in `source`, outside comments.
fn broadcasts(source: &str) -> Vec<(usize, String)> {
    source
        .lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let code = line.split("//").next().unwrap_or("");
            let calls = BROADCASTS.iter().any(|name| {
                [format!(".{name}("), format!("::{name}(")]
                    .iter()
                    .any(|call| code.contains(call.as_str()))
            });
            calls.then(|| (i + 1, line.trim().to_owned()))
        })
        .collect()
}

/// The declaration of `field` inside `struct <name> { .. }`, trimmed.
fn field_decl(source: &str, name: &str, field: &str) -> Option<String> {
    let start = source.find(&format!("struct {name} {{"))?;
    let body = &source[start..];
    let body = &body[..body.find("\n}")?];
    body.lines()
        .map(str::trim)
        .find(|l| {
            let l = l.strip_prefix("pub(crate) ").unwrap_or(l);
            let l = l.strip_prefix("pub(super) ").unwrap_or(l);
            let l = l.strip_prefix("pub ").unwrap_or(l);
            l.starts_with(&format!("{field}:"))
        })
        .map(str::to_owned)
}

fn registry_source() -> String {
    fs::read_to_string(locate(REGISTRY)).expect("read the window registry")
}

#[test]
fn the_registry_never_broadcasts() {
    let found = broadcasts(&registry_source());
    assert!(
        found.is_empty(),
        "{REGISTRY} broadcasts; send to the affected labels with `emit_to`: {found:?}"
    );
}

#[test]
fn the_registry_sends_with_emit_to() {
    assert!(registry_source().contains(".emit_to("));
}

#[test]
fn window_entry_items_are_private() {
    let decl =
        field_decl(&registry_source(), "WindowEntry", "items").expect("WindowEntry declares items");
    assert!(
        !decl.starts_with("pub"),
        "WindowEntry::items must stay private to {REGISTRY}: {decl}"
    );
}

#[test]
fn self_test_a_planted_broadcast_fails() {
    for planted in [
        "app.emit(\"window:slice\", slice)",
        "app.emit_str(\"window:slice\", s)",
        "app.emit_filter(\"window:slice\", s, |_| true)",
        "Emitter::emit(&app, \"window:slice\", s)",
    ] {
        let source = format!("fn f() {{\n    {planted};\n}}\n");
        assert_eq!(broadcasts(&source).len(), 1, "missed {planted}");
    }
    let quiet = "fn f() {\n    app.emit_to(\"main\", E, s); // not .emit(\n}\n";
    assert!(broadcasts(quiet).is_empty());
}

#[test]
fn self_test_a_pub_items_field_is_seen() {
    for vis in ["pub ", "pub(crate) ", "pub(super) "] {
        let source = format!("pub struct WindowEntry {{\n    {vis}items: Set,\n}}\n");
        let decl = field_decl(&source, "WindowEntry", "items").unwrap();
        assert!(decl.starts_with("pub"), "{decl}");
    }
    let private = "pub struct WindowEntry {\n    items: Set,\n}\n";
    assert_eq!(
        field_decl(private, "WindowEntry", "items").as_deref(),
        Some("items: Set,")
    );
}
