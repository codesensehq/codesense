// SPDX-License-Identifier: MIT
//! The two-window e2e driver's commands (`tests/windows/`), compiled only with the
//! `e2e-webdriver` feature (`windows/mod.rs` gates the module; `codesense-guards`'
//! `webdriver_cfg_guard` fails a release build that would hold them). `main`'s
//! `window.__CODESENSE_WINDOWS_E2E__` (`src/app/e2e-windows-control.ts`) calls them.
//!
//! - `e2e_open_window {id, probe?}` opens `pane-<id>`, registered first as a pending
//!   satellite with no items and no Layout, the way a real satellite is created. `pane-*` is
//!   the only label `capabilities/pane.json` grants a non-`main` window, so no other label
//!   could boot. With `probe`, the window boots into the probe route
//!   (`src/app/e2e-satellite-probe.tsx`) on that file.
//! - `e2e_seed` gives a fresh home a local org and team holding the probe dashboard and the
//!   file it reads, and returns the dashboard's path. It grants nothing: the dashboard
//!   declares its own `files:read`. A second call returns the same path. It takes
//!   [`SeedOptions`], which a spec that needs more seeded extends with fields of its own.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};

use super::registry::WindowRegistry;

const PANE_PREFIX: &str = "pane-";

/// The local org and team `e2e_seed` creates, and where in the home's parent it puts the org.
const SEED_ORG: &str = "Windows E2E";
const SEED_TEAM: &str = "windows";
const SEED_DIR: &str = "codesense-windows-e2e";

/// The probe dashboard and the file it reads, written into the team's content.
const PROBE_HTML: &[u8] = include_bytes!("../../../tests/windows/fixtures/probe.html");
const PROBE_FILE: &str = "probe.html";
const READ_FILE: &str = "probe-read.txt";
const READ_TEXT: &str = "read through the satellite's bridge\n";

/// `pane-<id>`. Refuses an empty id, a path separator or any character a window label or a
/// URL query would need escaping for, and an id that already carries the prefix.
pub(crate) fn pane_label(id: &str) -> Result<String, String> {
    let plain = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if id.is_empty() || !plain || id.starts_with(PANE_PREFIX) {
        return Err(format!(
            "window id {id:?}: use letters, digits, '-' and '_', with no {PANE_PREFIX:?} prefix"
        ));
    }
    Ok(format!("{PANE_PREFIX}{id}"))
}

/// The page `label` boots: the satellite root, or the probe route on `probe`.
fn window_path(label: &str, probe: Option<&str>) -> String {
    let mut path = format!("index.html?window={label}");
    if let Some(probe) = probe {
        path.push_str("&probe=");
        path.extend(url::form_urlencoded::byte_serialize(probe.as_bytes()));
    }
    path
}

/// Registers `pane-<id>` as a pending satellite, then builds its window with no size or
/// position (the placement path sets those). Returns the label.
pub(crate) fn open<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    probe: Option<&str>,
) -> Result<String, String> {
    let label = pane_label(id)?;
    app.state::<WindowRegistry>().add_satellite(app, &label)?;
    let url = tauri::WebviewUrl::App(window_path(&label, probe).into());
    tauri::WebviewWindowBuilder::new(app, &label, url)
        .build()
        .map_err(|e| format!("open {label}: {e}"))?;
    Ok(label)
}

#[tauri::command]
pub async fn e2e_open_window(
    app: tauri::AppHandle,
    id: String,
    probe: Option<String>,
) -> Result<String, String> {
    open(&app, &id, probe.as_deref())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seeded {
    /// The probe dashboard's absolute path, in the seeded team's content.
    pub probe_html: PathBuf,
}

/// What a spec asks `e2e_seed` for beyond the probe org and team. None yet: a spec that needs
/// more seeded adds an optional field here, so no caller's arguments change. An unknown field
/// is refused rather than ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedOptions {}

/// Creates the org at `root` and its team, unless `root` already exists, then writes the
/// probe dashboard and the file it reads into the team's content. Uses the active profile,
/// which a fresh home already has (the local guest).
pub(crate) async fn seed_at<R: Runtime>(
    app: &tauri::AppHandle<R>,
    home: &Path,
    root: &Path,
) -> Result<Seeded, String> {
    use crate::mcp::local_setup::dispatch;
    if !root.exists() {
        let created = dispatch(
            app,
            home,
            "create_local_organization",
            serde_json::json!({"displayName": SEED_ORG, "destinationPath": root}),
        )
        .await?;
        let org_slug = created["org_slug"]
            .as_str()
            .ok_or("the new org has no slug")?
            .to_owned();
        dispatch(
            app,
            home,
            "commit_registry_edit_local",
            serde_json::json!({
                "orgSlug": org_slug,
                "edit": {"type": "CreateTeam", "team_name": SEED_TEAM},
            }),
        )
        .await?;
    }
    let content = root.join(SEED_TEAM).join("content");
    std::fs::create_dir_all(&content).map_err(|e| format!("{}: {e}", content.display()))?;
    let probe_html = content.join(PROBE_FILE);
    for (path, bytes) in [
        (probe_html.clone(), PROBE_HTML),
        (content.join(READ_FILE), READ_TEXT.as_bytes()),
    ] {
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(Seeded { probe_html })
}

#[tauri::command]
pub async fn e2e_seed(
    app: tauri::AppHandle,
    options: Option<SeedOptions>,
) -> Result<Seeded, String> {
    let SeedOptions {} = options.unwrap_or_default();
    let home = crate::commands::paths::codesense_home_dir().ok_or("cannot resolve home")?;
    let root = home
        .parent()
        .ok_or("the home has no parent directory")?
        .join(SEED_DIR);
    seed_at(&app, &home, &root).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::registry::WindowKind;
    use crate::windows::MAIN_LABEL;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(WindowRegistry::new());
        app
    }

    #[test]
    fn any_plain_id_gives_a_pane_label() {
        for (id, label) in [
            ("x", "pane-x"),
            ("4f1c-9a_b", "pane-4f1c-9a_b"),
            ("main", "pane-main"),
        ] {
            assert_eq!(pane_label(id).as_deref(), Ok(label));
        }
    }

    #[test]
    fn a_separator_another_prefix_or_an_empty_id_is_refused() {
        for id in [
            "", "a/b", "a\\b", "../x", "pane-x", "pane-", "team:x", "a b", "a?b", "a&b",
        ] {
            assert!(pane_label(id).is_err(), "{id:?} was accepted");
        }
    }

    #[test]
    fn the_probe_path_is_escaped_into_the_query() {
        assert_eq!(window_path("pane-x", None), "index.html?window=pane-x");
        assert_eq!(
            window_path("pane-x", Some("/h/a b/p&q.html")),
            "index.html?window=pane-x&probe=%2Fh%2Fa+b%2Fp%26q.html"
        );
    }

    #[test]
    fn the_opened_window_is_a_pending_satellite_until_it_is_ready() {
        let app = app();
        let label = open(app.handle(), "one", Some("/h/probe.html")).unwrap();
        assert_eq!(label, "pane-one");
        assert!(app.get_webview_window("pane-one").is_some());
        let registry = app.state::<WindowRegistry>();
        let slice = registry.get_slice(MAIN_LABEL, "pane-one").unwrap();
        assert_eq!(slice.kind, WindowKind::Satellite);
        assert!(slice.items.is_empty());
        assert_eq!(slice.layout_ref, None);
        assert!(slice.pending);
        registry.ready(app.handle(), "pane-one").unwrap();
        assert!(!registry.get_slice(MAIN_LABEL, "pane-one").unwrap().pending);
    }

    #[test]
    fn a_refused_id_opens_and_registers_nothing() {
        let app = app();
        assert!(open(app.handle(), "pane-one", None).is_err());
        assert!(app.webview_windows().is_empty());
        assert!(app
            .state::<WindowRegistry>()
            .get_slice(MAIN_LABEL, "pane-pane-one")
            .is_err());
    }

    #[test]
    fn a_second_open_of_the_same_id_is_refused() {
        let app = app();
        open(app.handle(), "one", None).unwrap();
        assert!(open(app.handle(), "one", None)
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(app.webview_windows().len(), 1);
    }

    #[tokio::test]
    async fn the_seed_on_a_fresh_home_writes_the_probe_and_twice_gives_the_same_path() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("state");
        let app = crate::mcp::local_setup::tests::app(&home);
        let root = temp.path().join(SEED_DIR);
        let first = seed_at(app.handle(), &home, &root).await.unwrap();
        assert_eq!(
            first.probe_html,
            root.join(SEED_TEAM).join("content").join(PROBE_FILE)
        );
        assert_eq!(std::fs::read(&first.probe_html).unwrap(), PROBE_HTML);
        let read = first.probe_html.with_file_name(READ_FILE);
        assert_eq!(std::fs::read_to_string(&read).unwrap(), READ_TEXT);
        let loaded = crate::domain::load_org("windows-e2e", &root, None);
        assert!(loaded.file_errors.is_empty(), "{:?}", loaded.file_errors);
        let teams = loaded.org.unwrap().teams;
        assert_eq!(teams.len(), 1);
        let second = seed_at(app.handle(), &home, &root).await.unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn the_seed_takes_empty_or_absent_options_and_refuses_an_unknown_one() {
        let parse = |json| serde_json::from_value::<Option<SeedOptions>>(json);
        assert!(parse(serde_json::json!(null)).unwrap().is_none());
        assert!(parse(serde_json::json!({})).unwrap().is_some());
        let error = parse(serde_json::json!({"teams": 2})).unwrap_err();
        assert!(
            error.to_string().contains("unknown field `teams`"),
            "{error}"
        );
    }

    #[test]
    fn the_probe_fixture_declares_its_own_read_grant() {
        let html = std::str::from_utf8(PROBE_HTML).unwrap();
        // Prettier writes the tag self-closed, so the check stops before its end.
        assert!(html.contains(r#"<meta name="codesense:capabilities" content="files:read""#));
        assert!(html.contains(READ_FILE));
    }
}
