// SPDX-License-Identifier: MIT
// Two sends of the event outside the router, split over lines.

fn send(app: &App, payload: Value) {
    let _ = app
        .emit(
            "context-file-change",
            payload.clone(),
        );
    let _ = Emitter::emit_to(
        app, "main",
        &"context-file-change", payload,
    );
}
