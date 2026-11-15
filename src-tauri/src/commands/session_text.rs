// SPDX-License-Identifier: MIT
//! The page's door to a session's assistant-prose stream (`crate::session_text`).

/// A page starts hearing `session_id`'s assistant prose. The bridge checks the page's grant
/// (`sessions:read`) and that the session is in the page's team before it calls this.
#[tauri::command]
pub async fn session_text_watch(session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::session_text::watch(&session_id))
        .await
        .map_err(|e| format!("session_text_watch failed: {e}"))?
}

/// A page stops hearing `session_id`'s prose.
#[tauri::command]
pub async fn session_text_unwatch(session_id: String) -> Result<(), String> {
    crate::session_text::unwatch(&session_id);
    Ok(())
}
