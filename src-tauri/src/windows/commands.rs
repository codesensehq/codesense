// SPDX-License-Identifier: MIT
//! The window registry's Tauri commands: thin wrappers that name the calling window.
//! Every window may call them; the registry checks what each window may change.

use tauri::State;

use super::item_key::ItemKey;
use super::moves;
use super::registry::{SetLayoutOutcome, WindowRegistry, WindowSlice};

/// `label`'s slice. A window reads its own; `main` reads any.
#[tauri::command]
pub fn window_get_slice(
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    label: String,
) -> Result<WindowSlice, String> {
    registry.get_slice(window.label(), &label)
}

/// The calling window's listeners have mounted and it holds its slice. For a move's
/// target this starts the hand-off.
#[tauri::command]
pub fn window_ready(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
) -> Result<(), String> {
    moves::window_ready(&app, &registry, window.label())
}

/// Sets `label`'s Layout, or focuses the window that already holds it.
#[tauri::command]
pub fn window_set_layout(
    app: tauri::AppHandle,
    window: tauri::Window,
    registry: State<'_, WindowRegistry>,
    label: String,
    layout_ref: Option<String>,
) -> Result<SetLayoutOutcome, String> {
    registry.set_layout(&app, window.label(), &label, layout_ref)
}

/// Focuses the satellite that owns `key`; returns its label, or `None` when `main` owns it.
#[tauri::command]
pub fn window_focus_owner(
    app: tauri::AppHandle,
    registry: State<'_, WindowRegistry>,
    key: ItemKey,
) -> Option<String> {
    registry.focus_owner(&app, &key)
}
