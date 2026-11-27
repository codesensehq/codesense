// SPDX-License-Identifier: MIT
//! The app's windows: the `main` label and the one window a reply goes to (`label`).

pub mod label;

pub use label::{emit_to_owner, is_main, main_window, MAIN_LABEL};
