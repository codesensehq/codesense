// SPDX-License-Identifier: MIT
//! A hard bound for tests that could otherwise hang a CI run.
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

/// How long a bounded test may run; well under nextest's terminate-after.
pub(crate) const TEST_LIMIT: Duration = Duration::from_secs(30);

/// Run `body` on its own thread and fail the test if it runs past
/// [`TEST_LIMIT`]. The test is named from its libtest thread. A panic in
/// `body` fails the test with the body's own message.
pub(crate) fn within<T: Send + 'static>(body: impl FnOnce() -> T + Send + 'static) -> T {
    let name = std::thread::current()
        .name()
        .unwrap_or("bounded test")
        .to_owned();
    let (done, finished) = std::sync::mpsc::channel();
    let worker = std::thread::Builder::new()
        .name(name.clone())
        .spawn(move || {
            let _ = done.send(body());
        })
        .expect("spawn the test worker");
    match finished.recv_timeout(TEST_LIMIT) {
        Ok(value) => value,
        Err(RecvTimeoutError::Disconnected) => match worker.join() {
            Err(panic) => std::panic::resume_unwind(panic),
            Ok(()) => panic!("{name} ended without a result"),
        },
        Err(RecvTimeoutError::Timeout) => panic!("{name} did not finish within {TEST_LIMIT:?}"),
    }
}
