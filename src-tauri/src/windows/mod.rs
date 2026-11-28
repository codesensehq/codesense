// SPDX-License-Identifier: MIT
//! The app's windows: the registry of every window and the items they show (`registry`,
//! `item_key`, `commands`), the `main` label and the one window a reply goes to (`label`), how
//! long a new window may take to paint before it counts as failed (`pending_timeout`), moving an
//! item from one window to another (`moves`), which terminals may move (`terminal_refusal`), the
//! commands only `main` may call (`command_acl`), the app-state keys a satellite may patch
//! (`app_state_patch`), the one sender of file changes, to the windows that show them
//! (`router`), and the one way items come back to `main` from a window that is going away
//! (`returns`).

pub mod app_state_patch;
pub mod command_acl;
pub mod commands;
pub mod item_key;
pub mod label;
pub mod moves;
pub mod pending_timeout;
pub mod registry;
pub mod returns;
pub mod router;
#[allow(dead_code)] // called by the up-front move check once terminal tiles move
pub mod terminal_refusal;

pub use label::{emit_to_owner, is_main, main_window, MAIN_LABEL};
pub use pending_timeout::{pending_timeout_ms, PENDING_TIMEOUT_MS};
