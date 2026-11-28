// SPDX-License-Identifier: MIT
// A send of the event inside a test module.

fn other(app: &App) {
    let _ = app.emit("context-index-changed", ());
}

#[cfg(test)]
mod tests {
    fn send(app: &App) {
        let _ = app.emit(
            "context-file-change",
            (),
        );
    }
}
