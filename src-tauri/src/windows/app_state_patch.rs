// SPDX-License-Identifier: MIT
//! A satellite's app-state writes. A satellite persists only the top-level keys in
//! `app_state_patch_keys.json` (the frontend's `patchAppState` reads the same file), always as a
//! key patch through `write_app_state`, which merges under the profile I/O lock and pushes the
//! change to every window. `main` writes through `save_app_state`, which satellites may not call
//! (`command_acl`).

use std::sync::LazyLock;

use crate::commands::await_blocking;
use crate::commands::system::{app_state_path, write_app_state};

/// The top-level app-state keys a satellite may patch.
pub static APP_STATE_PATCH_KEYS: LazyLock<Vec<String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("app_state_patch_keys.json"))
        .expect("app_state_patch_keys.json parses")
});

/// Refuse a patch that is not an object or names a key outside [`APP_STATE_PATCH_KEYS`].
fn check_keys(state: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(state).map_err(|e| e.to_string())?;
    let object = value
        .as_object()
        .ok_or("an app-state patch must be an object")?;
    match object
        .keys()
        .find(|key| !APP_STATE_PATCH_KEYS.iter().any(|allowed| allowed == *key))
    {
        Some(key) => Err(format!("not a key a satellite may write: {key}")),
        None => Ok(()),
    }
}

/// Patch the allowed keys of the app-state file at `path`.
pub(crate) fn patch_keys<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &std::path::Path,
    expected: Option<&str>,
    state: &str,
) -> Result<(), String> {
    check_keys(state)?;
    write_app_state(app, path, expected, state, true)
}

/// Patch app-state keys from a satellite window.
#[tauri::command]
pub async fn patch_app_state_keys(
    app: tauri::AppHandle,
    state: String,
    expected_principal: Option<String>,
) -> Result<(), String> {
    await_blocking("patch_app_state_keys", move || {
        patch_keys(
            &app,
            &app_state_path(&app)?,
            expected_principal.as_deref(),
            &state,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::*;
    use crate::commands::system::{profile_test_app, retire_saved_workspace_rows_at};

    type App = tauri::App<tauri::test::MockRuntime>;

    fn app(home: &Path) -> (App, PathBuf) {
        let app = profile_test_app(home);
        let path = home.join("app-data").join("app-state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        (app, path)
    }

    fn seed(app: &App, path: &Path, state: Value) {
        write_app_state(app.handle(), path, Some("41"), &state.to_string(), false).unwrap();
    }

    fn file(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// The profile's own keys; `shortcuts` is global and stays at the file's top level.
    fn saved(path: &Path) -> Value {
        file(path)["localProfileWorkspacesV1"]["41"].clone()
    }

    #[test]
    fn the_key_list_parses_from_its_json() {
        assert_eq!(
            *APP_STATE_PATCH_KEYS,
            ["dashboardPrefs", "liveHubUi", "dashboardPolicy", "shortcuts"]
        );
    }

    #[test]
    fn a_key_outside_the_list_is_refused_with_nothing_written() {
        let home = tempfile::tempdir().unwrap();
        let (app, path) = app(home.path());
        seed(&app, &path, json!({"shortcuts": {"version": 2, "shortcuts": {}}}));
        let before = std::fs::read(&path).unwrap();
        for key in ["viewer", "org", "repos", "worktreeSetupApprovals", "unknownKey"] {
            let patch = json!({ "shortcuts": {"shortcuts": {"a": "b"}}, key: {"x": 1} });
            let error = patch_keys(app.handle(), &path, Some("41"), &patch.to_string());
            assert_eq!(
                error,
                Err(format!("not a key a satellite may write: {key}")),
                "{key}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), before, "{key} wrote");
        }
        assert!(patch_keys(app.handle(), &path, Some("41"), "[]").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn an_allowed_patch_and_a_main_patch_of_another_key_both_survive() {
        let home = tempfile::tempdir().unwrap();
        let (app, path) = app(home.path());
        seed(&app, &path, json!({"org": {"activeTeamName": "one"}}));
        patch_keys(
            app.handle(),
            &path,
            Some("41"),
            &json!({"dashboardPrefs": {"page": {"data": {"x": 1}, "at": 1}}}).to_string(),
        )
        .unwrap();
        write_app_state(
            app.handle(),
            &path,
            Some("41"),
            &json!({"org": {"activeTeamName": "two"}}).to_string(),
            true,
        )
        .unwrap();
        let state = saved(&path);
        assert_eq!(state["dashboardPrefs"]["page"]["data"]["x"], 1);
        assert_eq!(state["org"]["activeTeamName"], "two");
    }

    #[test]
    fn a_patch_sent_during_a_retire_waits_and_survives() {
        let home = tempfile::tempdir().unwrap();
        let (app, path) = app(home.path());
        seed(
            &app,
            &path,
            json!({
                "viewer": {
                    "workspaces": {"acme:dev": [{"id": "gone"}, {"id": "kept"}]},
                    "softClosedWorkspaces": {"acme:dev": {"gone": {"workspace": {"id": "gone"}}}},
                    "activeWorkspace": {"acme:dev": "gone"}
                },
                "shortcuts": {"version": 2, "shortcuts": {}}
            }),
        );

        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let retire = {
            let handle = app.handle().clone();
            let path = path.clone();
            std::thread::spawn(move || {
                let blocked = AtomicBool::new(false);
                let matches = |row: &Value| {
                    if !blocked.swap(true, Ordering::SeqCst) {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                    }
                    row["id"] == "gone"
                };
                retire_saved_workspace_rows_at(&handle, &path, "41", "acme:dev", &matches)
            })
        };
        entered_rx.recv().unwrap();

        let patch = {
            let handle = app.handle().clone();
            let path = path.clone();
            std::thread::spawn(move || {
                patch_keys(
                    &handle,
                    &path,
                    Some("41"),
                    &json!({"shortcuts": {"shortcuts": {"open": "Mod+O"}}}).to_string(),
                )
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !patch.is_finished(),
            "the patch ran while the retire held the profile I/O lock"
        );
        release_tx.send(()).unwrap();

        assert_eq!(retire.join().unwrap(), Ok(2));
        assert_eq!(patch.join().unwrap(), Ok(()));
        assert_eq!(file(&path)["shortcuts"]["shortcuts"]["open"], "Mod+O");
        let state = saved(&path);
        let viewer = &state["viewer"];
        assert_eq!(viewer["workspaces"]["acme:dev"], json!([{"id": "kept"}]));
        assert!(viewer["softClosedWorkspaces"]["acme:dev"].get("gone").is_none());
        assert!(viewer["activeWorkspace"].get("acme:dev").is_none());
    }
}
