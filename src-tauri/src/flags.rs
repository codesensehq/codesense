// SPDX-License-Identifier: MIT
//! Release flags: a feature that ships off until its flag is on, and that a remote kill can
//! switch off again without a new build.
//!
//! There is one flag, `tiles`. It is on when both of its inputs say so:
//!
//! - the local setting `viewer.settings.tiles` in `app-state.json`, on only when it is the
//!   boolean `true` (missing or any other value is off);
//! - no remote kill. The beta and beta-staging builds read the static update manifest
//!   (`license::static_channel`), and each read that parses caches its override in
//!   [`CACHE_FILE`] in the app data folder. Only the literal JSON `false` at `flags.tiles`
//!   kills; the value is unsigned and kill-only, so the manifest can switch tiles off but never
//!   on. An unreachable or malformed manifest leaves the cache as it was. A cache that is
//!   missing, malformed or unreadable is no kill, so it can never stop the app starting.
//!   Internal builds read no manifest and use the local setting alone.
//!
//! The value is decided once at startup, before the update tick runs, and held for the session
//! ([`TilesFlag`]), so a kill takes effect from the next launch. The front end reads the same
//! boot value through the `tiles_enabled` command, so both sides agree for the whole session.
//!
//! With the flag off the app is today's app on untouched old state, and no tile code writes
//! any file: every tile-file writer and the tile host's mount check `tilesEnabled()` and are
//! listed in `src/shared/lib/tiles-flag-sites.json`, which a guard test checks.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The remote overrides the last manifest read carried, in the app data folder.
pub const CACHE_FILE: &str = "flags-cache.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    tiles_kill: bool,
}

/// Whether the cache holds a tiles kill. A missing, malformed or unreadable cache is no kill.
pub fn cached_kill(app_dir: &Path) -> bool {
    std::fs::read(app_dir.join(CACHE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cache>(&bytes).ok())
        .is_some_and(|cache| cache.tiles_kill)
}

/// Caches the override a manifest read carried. A failed write is logged and never returned,
/// so it can't fail the update check.
// Only the beta channels' update check writes the cache.
#[cfg_attr(all(cs_channel = "internal", not(test)), allow(dead_code))]
pub fn write_kill(app_dir: &Path, kill: bool) {
    // A manifest read about hourly repeats the value; skip the write when nothing changed.
    if cached_kill(app_dir) == kill && app_dir.join(CACHE_FILE).is_file() {
        return;
    }
    let written = serde_json::to_vec(&Cache { tiles_kill: kill })
        .map_err(std::io::Error::other)
        .and_then(|body| {
            std::fs::create_dir_all(app_dir)?;
            // Write beside the cache and rename into place, so a crash mid-write can't leave a
            // truncated cache that reads as no kill.
            let tmp = app_dir.join(format!("{CACHE_FILE}.tmp"));
            std::fs::write(&tmp, body)?;
            std::fs::rename(&tmp, app_dir.join(CACHE_FILE)).inspect_err(|_| {
                let _ = std::fs::remove_file(&tmp);
            })
        });
    if let Err(e) = written {
        log::warn!(target: "flags", "could not cache the release flag overrides: {e}");
    }
}

/// The flag from the local setting and, outside an internal build, the cached kill. An
/// internal build never reads the cache.
fn decide(local: bool, app_dir: &Path, internal: bool) -> bool {
    local && (internal || !cached_kill(app_dir))
}

/// The tiles flag for a launch from the app data folder: the local setting AND NOT a cached
/// kill (the local setting alone in an internal build).
pub fn tiles_at_boot(app_dir: &Path) -> bool {
    let local = std::fs::read_to_string(crate::commands::system::app_state_file_in(app_dir))
        .is_ok_and(|json| crate::commands::system::parse_tiles_setting(&json));
    decide(local, app_dir, cfg!(cs_channel = "internal"))
}

/// The tiles flag this session runs with, decided once at startup.
pub struct TilesFlag(bool);

impl TilesFlag {
    /// Reads the flag for this launch. With no app data folder, tiles are off.
    pub fn at_boot<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        let on = tauri::Manager::path(app)
            .app_data_dir()
            .is_ok_and(|dir| tiles_at_boot(&dir));
        log::info!(target: "flags", "tiles release flag: {}", if on { "on" } else { "off" });
        Self(on)
    }
}

/// The tiles flag's boot value, the same for the whole session.
#[tauri::command]
pub fn tiles_enabled(flag: tauri::State<'_, TilesFlag>) -> bool {
    flag.0
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn kill_cached(dir: &Path) {
        std::fs::write(dir.join(CACHE_FILE), r#"{"tilesKill":true}"#).unwrap();
    }

    pub(crate) fn local_tiles(dir: &Path, on: bool) {
        let state = serde_json::json!({ "viewer": { "settings": { "tiles": on } } });
        std::fs::write(crate::commands::system::app_state_file_in(dir), state.to_string()).unwrap();
    }

    #[test]
    fn a_missing_cache_is_no_kill() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!cached_kill(dir.path()));
    }

    #[test]
    fn a_malformed_cache_is_no_kill() {
        let dir = tempfile::tempdir().unwrap();
        for body in [
            "{not json",
            "[]",
            r#"{"tilesKill":"yes"}"#,
            r#"{"other":true}"#,
            "",
        ] {
            std::fs::write(dir.path().join(CACHE_FILE), body).unwrap();
            assert!(!cached_kill(dir.path()), "{body:?}");
        }
    }

    #[test]
    fn an_unreadable_cache_is_no_kill() {
        let dir = tempfile::tempdir().unwrap();
        // A folder where the file should be: the read fails.
        std::fs::create_dir(dir.path().join(CACHE_FILE)).unwrap();
        assert!(!cached_kill(dir.path()));
    }

    #[test]
    fn a_written_override_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        write_kill(dir.path(), true);
        assert!(cached_kill(dir.path()));
        write_kill(dir.path(), false);
        assert!(!cached_kill(dir.path()));
    }

    #[test]
    fn an_unchanged_override_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join(CACHE_FILE);
        write_kill(dir.path(), true);
        // Marker bytes that still parse as a kill: a rewrite would replace them.
        let marker = r#"{ "tilesKill": true }"#;
        std::fs::write(&cache, marker).unwrap();
        write_kill(dir.path(), true);
        assert_eq!(std::fs::read_to_string(&cache).unwrap(), marker);
        write_kill(dir.path(), false);
        assert!(!cached_kill(dir.path()), "a changed value is written");
        assert!(!dir.path().join(format!("{CACHE_FILE}.tmp")).exists());
    }

    #[test]
    fn a_failed_cache_write_is_only_logged() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, "").unwrap();
        write_kill(&blocked, true);
        assert!(!cached_kill(&blocked));
    }

    #[test]
    fn a_cached_kill_turns_tiles_off_with_the_local_setting_on() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            decide(true, dir.path(), false),
            "no kill: the local setting"
        );
        assert!(!decide(false, dir.path(), false));
        kill_cached(dir.path());
        assert!(!decide(true, dir.path(), false), "the kill wins");
        assert!(!decide(false, dir.path(), false));
    }

    #[test]
    fn an_internal_build_reads_only_the_local_setting() {
        let dir = tempfile::tempdir().unwrap();
        kill_cached(dir.path());
        assert!(decide(true, dir.path(), true));
        assert!(!decide(false, dir.path(), true));
    }

    #[test]
    fn the_boot_value_reads_the_local_setting_from_app_state() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!tiles_at_boot(dir.path()), "no app state: off");
        local_tiles(dir.path(), false);
        assert!(!tiles_at_boot(dir.path()));
        local_tiles(dir.path(), true);
        assert!(tiles_at_boot(dir.path()));
    }

    /// The flag is read before the update tick starts, so a manifest read in this session
    /// can't change it, and it is managed before any command can ask for it.
    #[test]
    fn the_flag_is_read_at_setup_before_the_update_tick() {
        let shipped = include_str!("lib.rs");
        let read = shipped
            .find("flags::TilesFlag::at_boot(")
            .expect("setup reads the flag");
        let tick = shipped
            .find("license::install(app.handle())")
            .expect("setup starts the update tick");
        assert!(read < tick, "the flag is read before the update tick");
        assert!(
            shipped.contains("flags::tiles_enabled,"),
            "the command is registered"
        );
    }

    /// An internal build ignores a cached kill: it reads no manifest, so nothing it holds is
    /// a remote override.
    #[cfg(cs_channel = "internal")]
    #[test]
    fn on_the_internal_channel_a_cached_kill_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        local_tiles(dir.path(), true);
        kill_cached(dir.path());
        assert!(tiles_at_boot(dir.path()));
    }

    // A beta build honouring a cached kill at boot is tested under
    // `license::static_channel::tests`, the module CI runs on a beta channel.
}
