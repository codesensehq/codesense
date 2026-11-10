// SPDX-License-Identifier: MIT
use super::*;
use std::sync::{Mutex, OnceLock};
use tauri::State;
#[derive(Default)]
pub struct VerbState(pub Mutex<Dispatcher>);
fn now() -> u64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}
pub(crate) async fn read_policy<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    principal: &str,
) -> Result<Policy, String> {
    let path = crate::commands::system::app_state_file(&app)?;
    read_policy_at(app, path, principal).await
}
async fn read_policy_at<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: std::path::PathBuf,
    principal: &str,
) -> Result<Policy, String> {
    let policy = crate::commands::system::dashboard_policy(app, path, principal.into()).await?;
    serde_json::from_value(policy).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn verb_dispatch(
    app: tauri::AppHandle,
    state: State<'_, VerbState>,
    caller: Caller,
    expected_principal: String,
    verb: String,
    args: serde_json::Value,
    flushing: Option<bool>,
) -> Result<Decision, String> {
    // A frame's actor can be a stored message sender. Policy belongs to the
    // renderer's immutable local profile; the published profile fences changes.
    let policy = read_policy(app.clone(), &expected_principal).await?;
    use tauri::Manager;
    let frame = app
        .state::<std::sync::Arc<crate::dashboard_stream::frame::FrameStore>>()
        .by_id(&caller.frame_id);
    let mut dispatcher = state.0.lock().map_err(|e| e.to_string())?;
    dispatcher.set_flushing(&caller.frame_id, flushing.unwrap_or(false));
    let decision =
        dispatch_registered_frame(&mut dispatcher, frame.as_ref(), &verb, args, &policy, now());
    dispatcher.set_flushing(&caller.frame_id, false);
    Ok(decision)
}

fn dispatch_registered_frame(
    dispatcher: &mut Dispatcher,
    frame: Option<&crate::dashboard_stream::frame::FrameRecord>,
    verb: &str,
    args: serde_json::Value,
    policy: &Policy,
    at: u64,
) -> Decision {
    match frame {
        Some(frame) => dispatcher.dispatch_frame(frame, verb, args, policy, at),
        None => Decision::Deny {
            reason: "denied: frame released".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard_stream::frame::{FrameGrant, FramePolicy, FrameStore};
    use serde_json::json;

    fn saving_app(
        home: &std::path::Path,
    ) -> (tauri::App<tauri::test::MockRuntime>, std::path::PathBuf) {
        let app = crate::commands::system::profile_test_app(home);
        let path = home.join("app-data").join("app-state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        (app, path)
    }

    fn save(
        app: &tauri::App<tauri::test::MockRuntime>,
        path: &std::path::Path,
        state: serde_json::Value,
    ) {
        crate::commands::system::write_app_state(
            app.handle(),
            path,
            Some("41"),
            &state.to_string(),
            true,
        )
        .unwrap();
    }

    fn read(app: &tauri::App<tauri::test::MockRuntime>, path: &std::path::Path) -> Policy {
        tauri::async_runtime::block_on(read_policy_at(
            app.handle().clone(),
            path.to_path_buf(),
            "41",
        ))
        .unwrap()
    }

    #[test]
    fn a_stricter_policy_saved_through_app_state_denies_the_next_verb() {
        let home = tempfile::tempdir().unwrap();
        let (app, path) = saving_app(home.path());
        let stop_from_a_message = |policy: &Policy| {
            let caller = Caller {
                records_binding: None,
                kind: serde_json::from_value(json!("message")).unwrap(),
                frame_id: "frame".into(),
                principal: "41".into(),
                dashboard: "Board".into(),
                slot: "center".into(),
                team: None,
                scope: "message".into(),
            };
            Dispatcher::default().dispatch(caller, "stopSession", json!({}), policy, 0)
        };
        save(&app, &path, json!({"viewer": {}}));
        assert!(matches!(
            stop_from_a_message(&read(&app, &path)),
            Decision::Admit { .. }
        ));
        save(
            &app,
            &path,
            json!({"dashboardPolicy": {"preset": "team-safe"}}),
        );
        assert_eq!(
            stop_from_a_message(&read(&app, &path)),
            Decision::Deny {
                reason: "denied: message frame".into()
            }
        );
    }

    #[test]
    fn the_verb_policy_read_does_not_wait_for_profile_io() {
        use std::sync::mpsc;
        use std::time::Duration;
        use tauri::Manager;
        let home = tempfile::tempdir().unwrap();
        let (app, path) = saving_app(home.path());
        save(
            &app,
            &path,
            json!({"dashboardPolicy": {"preset": "team-safe"}}),
        );
        let (entered, held) = mpsc::channel();
        let (read_done, released) = mpsc::channel::<()>();
        let handle = app.handle().clone();
        let holder = std::thread::spawn(move || {
            handle
                .state::<crate::commands::local_profile::LocalProfileState>()
                .with_expected(Some("41"), || {
                    entered.send(()).unwrap();
                    Ok(released.recv_timeout(Duration::from_secs(2)).is_ok())
                })
        });
        held.recv_timeout(Duration::from_secs(5)).unwrap();
        let policy = read(&app, &path);
        let _ = read_done.send(());
        assert!(
            holder.join().unwrap().unwrap(),
            "the verb's policy read waited for the profile I/O lock"
        );
        assert!(policy.preset == Preset::TeamSafe);
    }
    #[test]
    fn releasing_a_frame_between_resolution_and_admission_never_grants_full_access() {
        let frames = FrameStore::default();
        let frame = frames.mint(
            9321,
            FrameGrant {
                frame_id: String::new(),
                principal: "human".into(),
                dashboard: "board".into(),
                slot: "right-pane".into(),
                team: None,
                scope: "private".into(),
            },
            "/ctx".into(),
            "/ctx/board.html".into(),
            "/ctx".into(),
            FramePolicy::default(),
            None,
        );
        let caller = Caller::from(&frame);
        frames.release(&frame.frame_id);
        assert_eq!(
            dispatch_registered_frame(
                &mut Dispatcher::default(),
                frames.by_id(&caller.frame_id).as_ref(),
                "sessions",
                serde_json::json!({}),
                &Policy::default(),
                0
            ),
            Decision::Deny {
                reason: "denied: frame released".into()
            }
        );
    }
}

#[tauri::command]
pub fn verb_answer(
    state: State<'_, VerbState>,
    confirm_id: String,
    allow: bool,
) -> Result<Call, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .answer(&confirm_id, allow)
}
#[tauri::command]
pub fn verb_settle(
    state: State<'_, VerbState>,
    call_id: String,
    landed: bool,
    reason: String,
) -> Result<(), String> {
    Dispatcher::settle(
        &mut *state.0.lock().map_err(|e| e.to_string())?,
        &call_id,
        landed,
        &reason,
    )
}
