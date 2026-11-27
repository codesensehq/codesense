// SPDX-License-Identifier: MIT
//! A hard bound for tests that could otherwise hang a CI run.
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

/// Run `body` on its own thread and fail the test, by name, if it runs past
/// `limit`. A panic in `body` fails the test with the body's own message.
pub(crate) fn within<T: Send + 'static>(
    name: &str,
    limit: Duration,
    body: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (done, finished) = std::sync::mpsc::channel();
    let worker = std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let _ = done.send(body());
        })
        .expect("spawn the test worker");
    match finished.recv_timeout(limit) {
        Ok(value) => value,
        Err(RecvTimeoutError::Disconnected) => match worker.join() {
            Err(panic) => std::panic::resume_unwind(panic),
            Ok(()) => panic!("{name} ended without a result"),
        },
        Err(RecvTimeoutError::Timeout) => panic!("{name} did not finish within {limit:?}"),
    }
}
