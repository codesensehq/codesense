// SPDX-License-Identifier: MIT
// The router may send the event, in any layout.

fn send(app: &App, payload: Value) {
    Emitter::emit_filter(
        app,
        "context-file-change",
        payload,
        |_| true,
    );
}
