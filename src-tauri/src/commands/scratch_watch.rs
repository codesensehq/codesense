// SPDX-License-Identifier: MIT
//! Watch the scratch repo: one recursive watch on `users/<profile>/scratch/`.
//! A change to a private pane (`orgs/<owner>/<repo>/panes/…`) reaches the pane
//! coalescer, and every scratch path feeds the footprint index. Editor and OS
//! noise (`.DS_Store`, swap and backup files, …) is recognized by [`is_noise`].

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub(crate) fn segments(path: &Path) -> Option<Vec<String>> {
    path.components()
        .map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

/// Files editors and the OS write next to the real ones: Finder metadata,
/// AppleDouble files, vim swap files and its `4913` write probe, Emacs lock
/// files and `~` backups. None of them is content a user means to apply.
pub(crate) fn is_noise(name: &str) -> bool {
    name == ".DS_Store"
        || name.starts_with("._")
        || name.starts_with(".#")
        || name.ends_with('~')
        || [".swp", ".swo", ".swx"]
            .iter()
            .any(|ext| name.ends_with(ext))
        || (!name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()))
}

/// The same private-file nudge for native watcher events and suppressed app writes.
pub(crate) fn content_change_payload(path: &Path) -> Option<serde_json::Value> {
    use crate::context_repo::scratch_space::{scratch_location, ScratchLocation};
    let root = path.ancestors().find(|ancestor| {
        ancestor.file_name().is_some_and(|name| name == "scratch")
            && scratch_location(ancestor) == Some(ScratchLocation::Repo)
    })?;
    let parts = path.strip_prefix(root).ok().and_then(segments)?;
    if parts.len() < 4
        || parts[0] != "orgs"
        || parts[3] != "content"
        || parts.last().is_some_and(|name| is_noise(name))
    {
        return None;
    }
    let content = parts[..4]
        .iter()
        .fold(root.to_path_buf(), |root, part| root.join(part));
    Some(serde_json::json!({"repo_path": content, "file_path": path}))
}

/// Shared ingress for the scratch tree and the single home-root configuration file.
pub(crate) fn configuration_path_changed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    home: &Path,
    principal: &crate::domain::Principal,
    path: &Path,
) {
    let root = crate::context_repo::scratch_space::scratch_root(home, principal);
    let is_profile = path
        .strip_prefix(&root)
        .ok()
        .and_then(segments)
        .is_some_and(|parts| {
            parts.len() == 5
                && parts[0] == "orgs"
                && parts[3] == "config"
                && parts[4] == "profile.json"
        });
    if path != home.join("workspace-config.json") && !is_profile {
        return;
    }
    if let Err(error) = crate::live_hub::configuration::path_changed(app, path) {
        log::warn!(target: "scratch_watch", "configuration ingress: {error}");
    }
}

/// Whether `path` is in a space's group folder under the scratch repo `root`.
pub(crate) fn is_group_file(root: &Path, path: &Path) -> bool {
    std::result::Result::ok(path.strip_prefix(root))
        .and_then(segments)
        .is_some_and(|parts| crate::groups::store::is_group_path(&parts))
}

/// Keep group files out of the scratch repo's status, when this launch has the tiles flag on.
/// An app with no flag managed counts as off.
fn exclude_group_files_for_launch<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) {
    let tiles = tauri::Manager::try_state::<crate::flags::TilesFlag>(app)
        .is_some_and(|flag| crate::flags::TilesFlag::is_on(&flag));
    crate::context_repo::scratch_space::exclude_group_files(root, tiles);
}

/// The path the scratch handler ingests: `path` as registered under `pane_root`, or `None` for
/// a group file, which is dropped before any content, footprint or pane ingestion.
fn ingestible_path(
    pane_root: &Path,
    canonical_root: Option<&PathBuf>,
    path: &Path,
) -> Option<PathBuf> {
    let registered = canonical_root
        .and_then(|root| path.strip_prefix(root).ok())
        .map(|relative| pane_root.join(relative))
        .unwrap_or_else(|| path.to_path_buf());
    (!is_group_file(pane_root, &registered)).then_some(registered)
}

/// The scratch repo currently watched (one profile at a time).
static WATCHED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Attach a configuration file to the existing native watcher. Hot siblings never enter debounce.
pub(crate) fn register_configuration_file_watch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &super::watch::WatcherState,
    path: &Path,
) {
    let Some(watcher) = state.watcher_handle() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    state.dispatcher.filter_direct_file(parent, name);
    let registered = path.to_path_buf();
    let canonical = path
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .map(|parent| parent.join(name));
    let app = app.clone();
    state.dispatcher.register_handler(
        parent,
        Arc::new(move |path| {
            if path != registered && canonical.as_deref() != Some(path) {
                return;
            }
            if let Err(error) = crate::live_hub::configuration::path_changed(&app, &registered) {
                log::warn!(target: "scratch_watch", "configuration ingress: {error}");
            }
        }),
    );
    if let Err(error) = watcher.watch(crate::content_engine::WatchDir {
        path: parent.to_path_buf(),
        recursive: false,
    }) {
        log::warn!(target: "scratch_watch", "configuration watch: {error}");
    }
}

/// Watch the scratch repo of `user_id` under `codesense_home`, feeding private
/// pane changes and the footprint index. Idempotent; a profile switch moves the
/// watch to the new profile's repo. Records recovery intent before watcher startup;
/// the next team activation re-attempts native attachment.
pub fn register_scratch_watch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &super::watch::WatcherState,
    codesense_home: &Path,
    user_id: u64,
) {
    let principal = crate::domain::Principal::from(user_id);
    let root = crate::context_repo::scratch_space::scratch_root(codesense_home, &principal);
    *state.scratch_root.lock().unwrap() = Some(root.clone());
    let Some(watcher) = state.watcher_handle() else {
        log::debug!(target: "scratch_watch", "watcher not started yet; deferring");
        return;
    };
    register_configuration_file_watch(app, state, &codesense_home.join("workspace-config.json"));
    let config_home = codesense_home.to_path_buf();
    if let Ok(mut watched) = WATCHED.lock() {
        if let Some(previous) = watched.take().filter(|p| *p != root) {
            state.dispatcher.unregister_handler(&previous);
            let _ = watcher.unwatch(&previous);
        }
        *watched = Some(root.clone());
    }
    let on_pane: Arc<dyn Fn(crate::panes::watch::PaneChange) + Send + Sync> = {
        let coalescer = crate::panes::watch::app_coalescer(app);
        Arc::new(move |change| coalescer.note(change))
    };
    // Group files are private-layer state, never in the repo's status.
    exclude_group_files_for_launch(app, &root);
    super::context_git_watch::register_private_git_watch(app, state, &root);
    let canonical_root = root.canonicalize().ok();
    let pane_root = root.clone();
    // SW-OC-26: every scratch path (private space + all-orgs) also feeds the
    // footprint index.
    let index_app = app.clone();
    let handler: crate::content_engine::DispatchHandler = Arc::new(move |path: &Path| {
        // Configuration paths share the scratch watch but bypass content ingestion. The group
        // store writes its files and keeps them out of the repo's status; a move or a resize is
        // no content change, footprint or pane edit.
        let Some(registered) = ingestible_path(&pane_root, canonical_root.as_ref(), path) else {
            return;
        };
        // A coalesced scratch/org root can hide both content and pane changes.
        if Result::ok(registered.strip_prefix(&pane_root))
            .and_then(segments)
            .is_some_and(|parts| {
                Vec::is_empty(&parts)
                    || (parts.first().is_some_and(|part| part == "orgs") && parts.len() <= 3)
            })
        {
            super::watch::recover_context_sources(&index_app, Some(&registered));
        }
        configuration_path_changed(&index_app, &config_home, &principal, &registered);
        crate::context_query::note_path(&index_app, path);
        if let Some(payload) = content_change_payload(path) {
            let _ = index_app.emit("context-file-change", payload);
        }

        if let Some(parts) = registered.strip_prefix(&pane_root).ok().and_then(segments) {
            if parts.len() >= 6 && parts[0] == "orgs" {
                let org = format!("{}/{}", parts[1], parts[2]);
                let space = pane_root.join("orgs").join(&parts[1]).join(&parts[2]);
                crate::live_hub::agent_definitions::note_path(
                    &index_app,
                    &principal,
                    &space,
                    &org,
                    crate::context_repo::scratch_space::SCRATCH_TEAM,
                    &registered,
                );
            }
        }

        if let Some(pane) =
            crate::panes::watch::scratch_pane_change(&pane_root, canonical_root.as_deref(), path)
        {
            on_pane(pane);
        }
    });
    super::watch::attach_recursive_watch(
        &watcher,
        &state.dispatcher,
        &root,
        handler,
        "register_scratch_watch",
    );
    crate::live_hub::configuration::watch_prefs(app, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_content_edits_under_numeric_folders_emit_the_content_root() {
        let root = Path::new("/home/users/42/scratch/orgs/acme/plans/content");
        let file = root.join("2026/plan.md");
        let payload = content_change_payload(&file).unwrap();
        assert_eq!(payload["repo_path"], root.to_string_lossy().as_ref());
        assert_eq!(payload["file_path"], file.to_string_lossy().as_ref());
        assert!(content_change_payload(&root.join("2026/4913")).is_none());
        assert!(content_change_payload(&root.join("2026/.plan.md.swp")).is_none());
    }

    /// Editor and OS noise is recognized; real file names are not.
    #[test]
    fn noise_names_are_recognized() {
        for noise in [
            ".DS_Store",
            "._guide.md",
            ".guide.md.swp",
            ".guide.md.swo",
            "guide.md~",
            ".#guide.md",
            "4913",
            "5036",
        ] {
            assert!(is_noise(noise), "{noise} is noise");
        }
        for real in ["guide.md", "teams.yml", "v2.md", ""] {
            assert!(!is_noise(real), "{real} is not noise");
        }
    }

    /// A group write under the scratch repo is dropped before any ingestion: no content change,
    /// footprint or pane edit.
    #[test]
    fn the_handler_drops_group_files_before_ingesting_them() {
        let root = Path::new("/home/users/42/scratch");
        let group = root.join("orgs/acme/plans/config/groups/main.json");
        assert!(is_group_file(root, &group));
        assert!(is_group_file(
            root,
            &root.join("orgs/acme/plans/config/groups/.gitignore")
        ));
        assert!(is_group_file(
            root,
            &root.join("orgs/acme/plans/config/groups")
        ));
        assert!(content_change_payload(&group).is_none());
        // A one-segment org keeps its group folder at orgs/<name>/config/groups.
        assert!(is_group_file(
            root,
            &root.join("orgs/solo/config/groups/main.json")
        ));
        for other in [
            "orgs/solo/content/groups/main.json",
            "orgs/acme/plans/config/profile.json",
            "orgs/acme/plans/content/groups/main.json",
            "orgs/acme/plans/config/groupsx/main.json",
            "all-orgs/config/groups/main.json",
        ] {
            assert!(!is_group_file(root, &root.join(other)), "{other}");
        }
        assert!(!is_group_file(
            root,
            Path::new("/elsewhere/orgs/a/b/config/groups/x.json")
        ));
    }

    /// The handler's early return: a group file is dropped, other scratch paths are ingested,
    /// also when the watcher reports them under the canonical root.
    #[test]
    fn the_handler_returns_early_for_a_group_file_only() {
        let root = PathBuf::from("/home/users/42/scratch");
        let group = root.join("orgs/acme/plans/config/groups/main.json");
        assert_eq!(ingestible_path(&root, None, &group), None);
        let note = root.join("orgs/acme/plans/content/note.md");
        assert_eq!(ingestible_path(&root, None, &note), Some(note.clone()));

        let canonical = PathBuf::from("/private/home/users/42/scratch");
        let reported = canonical.join("orgs/acme/plans/config/groups/main.json");
        assert_eq!(ingestible_path(&root, Some(&canonical), &reported), None);
        let reported = canonical.join("orgs/acme/plans/content/note.md");
        assert_eq!(
            ingestible_path(&root, Some(&canonical), &reported),
            Some(note)
        );
    }

    /// The flag read the scratch watch registers with: the exclude is written with the flag on,
    /// and not with it off or unmanaged.
    #[test]
    fn the_scratch_watch_excludes_group_files_only_with_the_flag_on() {
        use tauri::Manager;
        let exclude_has_groups = |managed: Option<bool>| {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(tmp.path().join(".git/info")).unwrap();
            let app = crate::commands::source_repo_add::tests::mock_app();
            if let Some(on) = managed {
                app.manage(crate::flags::TilesFlag::fixed(on));
            }
            exclude_group_files_for_launch(app.handle(), tmp.path());
            let exclude = tmp.path().join(".git/info/exclude");
            std::fs::read_to_string(exclude).is_ok_and(|text| {
                crate::groups::store::GROUPS_EXCLUDES
                    .iter()
                    .all(|line| text.contains(line))
            })
        };
        assert!(!exclude_has_groups(None), "no flag managed: off");
        assert!(!exclude_has_groups(Some(false)));
        assert!(exclude_has_groups(Some(true)));
    }

    #[test]
    fn segments_reject_non_normal_components() {
        assert_eq!(
            segments(Path::new("orgs/alpha/ctx")),
            Some(vec!["orgs".into(), "alpha".into(), "ctx".into()])
        );
        assert_eq!(segments(Path::new("../escape")), None);
    }
}
