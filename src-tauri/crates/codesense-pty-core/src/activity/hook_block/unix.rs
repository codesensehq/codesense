// SPDX-License-Identifier: MIT
//! A selected denial's input on unix: stdin, polled so an inherited stdin that never
//! closes can't hold the hook. The Windows port replaces this file.
use std::time::Instant;

/// Stdin until it closes, `deadline` passes or it runs past 1 MiB: what arrived, and
/// whether it closed.
pub(super) fn read_input(deadline: Instant) -> (Vec<u8>, bool) {
    let mut input = Vec::new();
    let mut complete = false;
    while Instant::now() < deadline && input.len() <= 1024 * 1024 {
        let mut poll = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as i32;
        if unsafe { libc::poll(&mut poll, 1, remaining) } <= 0 {
            break;
        }
        let mut buffer = [0u8; 8192];
        let count = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if count == 0 {
            complete = true;
            break;
        }
        if count < 0 {
            break;
        }
        input.extend_from_slice(&buffer[..count as usize]);
    }
    (input, complete)
}
