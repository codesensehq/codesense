// SPDX-License-Identifier: MIT
//! Saved arrangements: workspaces, groups and starters, one file each in the person's private
//! layer, written only through [`store`].
// The store's writers arrive in a later change; until then only its tests and the Scratch
// space's exclude call it.
#![cfg_attr(not(test), allow(dead_code))]

pub mod commands;
pub mod file_id;
pub mod leaf_id;
pub mod ops;
pub mod shape;
pub mod store;
pub mod tile_key;
