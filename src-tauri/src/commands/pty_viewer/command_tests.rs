// SPDX-License-Identifier: MIT
//! Each command that takes the calling window acts as that window's viewer, and a satellite
//! window's layout read stays out of the app-wide effects. The commands take the real
//! runtime's `AppHandle`, so a mock window cannot call them: these pin their source instead,
//! next to `windows_viewer_guard`, which refuses a `main_viewer` call in any function that
//! takes a window.

/// The function whose signature starts with `start`, from the signature to its closing brace.
fn body<'a>(src: &'a str, start: &str) -> &'a str {
    let at = src
        .find(start)
        .unwrap_or_else(|| panic!("{start} is present"));
    let open = at + src[at..].find('{').expect("a body");
    let mut depth = 0usize;
    for (i, c) in src[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[at..open + i + 1];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced body of {start}");
}

/// Where `needle` first appears in `haystack`.
fn at(haystack: &str, needle: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("`{needle}` is present in:\n{haystack}"))
}

const PTY: &str = include_str!("../pty.rs");
const LAYOUT: &str = include_str!("../pty_layout.rs");

/// (source, signature, the helper the command resolves its caller with).
const COMMANDS: [(&str, &str, &str); 7] = [
    (PTY, "pub async fn resize_pty(", "window_viewer(&window)"),
    (
        PTY,
        "pub async fn subscribe_terminal(",
        "window_viewport(&window)",
    ),
    (
        LAYOUT,
        "pub async fn terminal_layout_snapshot(",
        "window_viewer(&window)",
    ),
    (
        LAYOUT,
        "pub async fn terminal_open_tab(",
        "window_viewer(&window)",
    ),
    (
        LAYOUT,
        "pub async fn terminal_close_tab(",
        "window_viewer(&window)",
    ),
    (
        LAYOUT,
        "pub async fn terminal_set_active(",
        "window_viewer(&window)",
    ),
    (
        LAYOUT,
        "pub async fn terminal_set_view_hint(",
        "window_viewer(&window)",
    ),
];

#[test]
fn each_window_command_acts_as_its_calling_window() {
    for (src, signature, helper) in COMMANDS {
        let command = body(src, signature);
        let params = &command[..at(command, ") ->")];
        assert!(
            params.contains("window: tauri::WebviewWindow"),
            "{signature} takes the calling window"
        );
        assert!(
            at(command, helper) < at(command, ".await"),
            "{signature} resolves its caller before it acts"
        );
        for main in [
            "main_viewer",
            "main_boot",
            "MAIN_VIEWER",
            "viewport_for(&main",
        ] {
            assert!(
                !command.contains(main),
                "{signature} must not act as main through `{main}`"
            );
        }
    }
}

#[test]
fn a_satellite_layout_read_does_not_emit_restore_or_claim() {
    let command = body(LAYOUT, "pub async fn terminal_layout_snapshot(");
    let read = at(
        command,
        "layout_read(pty_viewer::boots(), &viewer, &client_boot_id)",
    );
    let emit = at(command, "app.emit(\"sessions-source-changed\"");
    let sync = at(command, "sync_connection_manager(");
    let snapshot = at(
        command,
        "admitted_layout_snapshots_for(&read_app, &viewer, &client_boot_id",
    );
    let early = at(command, "if !read.app_wide {\n        return Ok(replies);");
    let restore = at(command, "spawn_local_launch_restore(");
    let claim = at(command, "claim_held_sessions(");

    let gate = at(command, "if read.announces() {");
    assert!(
        read < gate && gate < emit,
        "the app-wide event is announced only by a read that announces"
    );
    assert!(read < emit && emit < sync && sync < snapshot);
    assert!(
        snapshot < early && early < restore && restore < claim,
        "a read that is not app-wide returns before it restores or claims"
    );
}
