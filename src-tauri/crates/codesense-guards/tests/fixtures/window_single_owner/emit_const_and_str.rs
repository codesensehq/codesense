// SPDX-License-Identifier: MIT
// Six sends of the event outside the router, by its constant or a `str` emit; one of another.

fn send(app: &App, payload: Value, text: String) {
    let _ = app.emit(CONTEXT_FILE_CHANGE_EVENT, payload.clone());
    let _ = Emitter::emit_to(app, "main", windows::router::CONTEXT_FILE_CHANGE_EVENT, payload);
    let _ = app.emit_str("context-file-change", text.clone());
    let _ = Emitter::emit_str_to(app, "main", CONTEXT_FILE_CHANGE_EVENT, text.clone());
    let _ = app.emit_str_filter(&CONTEXT_FILE_CHANGE_EVENT, text.clone(), |_| true);
    let _ = app.emit_filter((CONTEXT_FILE_CHANGE_EVENT), text, |_| true);
    let _ = app.emit(WORKTREE_FILE_CHANGE_EVENT, payload);
}
