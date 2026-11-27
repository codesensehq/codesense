// SPDX-License-Identifier: MIT
//! Release flags.

#[cfg(test)]
mod tests {
    use super::*;

    fn kill_cached(dir: &Path) {
        std::fs::write(dir.join(CACHE_FILE), r#"{"tilesKill":true}"#).unwrap();
    }

    fn local_tiles(dir: &Path, on: bool) {
        let state = serde_json::json!({ "viewer": { "settings": { "tiles": on } } });
        std::fs::write(dir.join(APP_STATE_FILE), state.to_string()).unwrap();
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

    /// A beta build honours a cached kill at boot.
    #[cfg(not(cs_channel = "internal"))]
    #[test]
    fn on_a_beta_channel_a_cached_kill_turns_tiles_off() {
        let dir = tempfile::tempdir().unwrap();
        local_tiles(dir.path(), true);
        kill_cached(dir.path());
        assert!(!tiles_at_boot(dir.path()));
    }
}
