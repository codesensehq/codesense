// SPDX-License-Identifier: MIT
//! The app's windows: the registry of every window and the items they show (`registry`, `item_key`,
//! `commands`), the `main` label and the one window a reply goes to (`label`), and how long a new
//! window may take to paint before it counts as failed (`pending_timeout`).

pub mod commands;
pub mod item_key;
pub mod label;
pub mod pending_timeout;
pub mod registry;

pub use label::{emit_to_owner, is_main, main_window, MAIN_LABEL};
pub use pending_timeout::{pending_timeout_ms, PENDING_TIMEOUT_MS};
