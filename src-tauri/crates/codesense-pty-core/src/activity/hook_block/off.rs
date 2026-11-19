// SPDX-License-Identifier: MIT
//! A selected denial's input where its stdin poll is not ported: nothing is read, so the
//! denial fails closed.
use std::time::Instant;

pub(super) fn read_input(_deadline: Instant) -> (Vec<u8>, bool) {
    (Vec::new(), false)
}
