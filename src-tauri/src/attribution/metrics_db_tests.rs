// SPDX-License-Identifier: MIT
use super::metrics_db::{due, is_idle, prune, tick, Pruned, Tick, RETENTION_SECS};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::Duration;

const NOW: u64 = 2_000_000_000;
const DAY: u64 = 24 * 3600;
const KEEP: u64 = 3 * DAY;
const PAYLOAD: usize = 8 * 1024;
const NO_PAUSE: Duration = Duration::ZERO;

/// A db shaped like git-ai's metrics-db for the columns the prune reads, in WAL mode like the
/// daemon's, with `old` rows ten days old and `fresh` rows an hour old.
fn fixture(dir: &Path, old: usize, fresh: usize) -> PathBuf {
    let path = dir.join("metrics-db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE metrics (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             event_json TEXT NOT NULL,
             delivered_ts INTEGER,
             event_ts INTEGER DEFAULT NULL,
             event_kind INTEGER DEFAULT NULL);
         CREATE INDEX metrics_event_ts_kind ON metrics (event_ts, event_kind, id)
             WHERE event_ts IS NOT NULL AND event_kind IS NOT NULL;
         CREATE TABLE schema_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
    )
    .unwrap();
    insert(&path, old, NOW - 10 * DAY);
    insert(&path, fresh, NOW - 3600);
    path
}

fn insert(path: &Path, count: usize, ts: u64) {
    let conn = Connection::open(path).unwrap();
    let payload = "x".repeat(PAYLOAD);
    for _ in 0..count {
        conn.execute(
            "INSERT INTO metrics (event_json, event_ts, event_kind) VALUES (?1, ?2, 5)",
            rusqlite::params![payload, ts as i64],
        )
        .unwrap();
    }
}

fn rows(path: &Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM metrics", [], |r| r.get(0))
        .unwrap()
}

fn size(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().len()
}

fn auto_vacuum(path: &Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn rows_past_retention_are_deleted_once_and_the_file_shrinks() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 300, 5);
    let before = size(&path);

    let first = prune(&path, NOW, KEEP, NO_PAUSE).unwrap();

    assert_eq!(first.deleted, 300);
    assert!(first.compacted);
    assert_eq!(rows(&path), 5);
    assert!(size(&path) < before / 10, "{} -> {}", before, size(&path));

    let second = prune(&path, NOW, KEEP, NO_PAUSE).unwrap();
    assert_eq!(second, Pruned::default());
}

#[test]
fn a_second_cycle_shrinks_the_file_again_in_incremental_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 300, 5);
    prune(&path, NOW, KEEP, NO_PAUSE).unwrap();
    assert_eq!(auto_vacuum(&path), 2);

    // A usage spike that then ages out: the file grows, then the second prune must give it back.
    insert(&path, 400, NOW - 10 * DAY);
    let spiked = size(&path);
    assert!(spiked > PAYLOAD as u64 * 400);

    let second = prune(&path, NOW, KEEP, NO_PAUSE).unwrap();

    assert_eq!(second.deleted, 400);
    assert!(second.compacted);
    assert_eq!(auto_vacuum(&path), 2);
    assert_eq!(rows(&path), 5);
    assert!(size(&path) < spiked / 10, "{} -> {}", spiked, size(&path));
}

#[test]
fn the_db_still_takes_inserts_after_a_prune_and_ids_keep_counting() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 50, 2);
    prune(&path, NOW, KEEP, NO_PAUSE).unwrap();

    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO metrics (event_json, event_ts, event_kind) VALUES ('{}', ?1, 5)",
        [NOW as i64],
    )
    .unwrap();
    let newest: i64 = conn
        .query_row("SELECT MAX(id) FROM metrics", [], |r| r.get(0))
        .unwrap();

    assert_eq!(rows(&path), 3);
    assert_eq!(newest, 53);
}

#[test]
fn rows_inside_retention_and_rows_without_a_timestamp_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 0, 4);
    Connection::open(&path)
        .unwrap()
        .execute("INSERT INTO metrics (event_json) VALUES ('{}')", [])
        .unwrap();

    let pruned = prune(&path, NOW, KEEP, NO_PAUSE).unwrap();

    assert_eq!(pruned, Pruned::default());
    assert_eq!(rows(&path), 5);
}

#[test]
fn a_missing_db_is_nothing_to_prune() {
    let dir = tempfile::tempdir().unwrap();
    let pruned = prune(&dir.path().join("metrics-db"), NOW, KEEP, NO_PAUSE).unwrap();
    assert_eq!(pruned, Pruned::default());
    assert!(!dir.path().join("metrics-db").exists());
}

#[test]
fn a_write_locked_db_is_left_alone_and_the_run_says_it_was_cut_short() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 20, 1);
    let holder = Connection::open(&path).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();

    let pruned = prune(&path, NOW, KEEP, NO_PAUSE).unwrap();

    assert_eq!(
        pruned,
        Pruned {
            deleted: 0,
            compacted: false,
            stopped_busy: true
        }
    );
    holder.execute_batch("ROLLBACK").unwrap();
    assert_eq!(rows(&path), 21);
}

#[test]
fn the_db_is_idle_only_when_no_row_arrives_over_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 0, 3);
    assert!(is_idle(&path, Duration::ZERO, |_| {}));
    assert!(!is_idle(&path, Duration::ZERO, |_| insert(&path, 1, NOW)));
    assert!(!is_idle(
        &dir.path().join("no-such-db"),
        Duration::ZERO,
        |_| {}
    ));
}

#[test]
fn a_prune_is_due_with_no_stamp_after_the_interval_and_when_the_stamp_is_in_the_future() {
    assert!(due(None, NOW));
    assert!(!due(Some(NOW - 60), NOW));
    assert!(due(Some(NOW - 7 * 3600), NOW));
    assert!(due(Some(NOW + DAY), NOW));
}

/// A managed root holding a metrics-db where git-ai keeps it.
fn managed(dir: &Path, old: usize, fresh: usize) -> (PathBuf, PathBuf, PathBuf) {
    let root = dir.join("git-ai");
    let home = root.join("home");
    let internal = home.join(".git-ai").join("internal");
    std::fs::create_dir_all(&internal).unwrap();
    let staged = fixture(dir, old, fresh);
    let db = internal.join("metrics-db");
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", staged.display()));
        if from.exists() {
            std::fs::rename(&from, PathBuf::from(format!("{}{suffix}", db.display()))).unwrap();
        }
    }
    (root, home, db)
}

#[test]
fn a_tick_without_a_db_does_nothing_and_stamps_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("git-ai");
    std::fs::create_dir_all(&root).unwrap();
    let outcome = tick(&root, &root.join("home"), NOW, |_| true, NO_PAUSE);
    assert_eq!(outcome, Tick::NoDb);
    assert!(!root.join("metrics-prune-ts").exists());
}

#[test]
fn a_tick_prunes_stamps_and_is_not_due_again_until_the_interval_passes() {
    let dir = tempfile::tempdir().unwrap();
    let (root, home, db) = managed(dir.path(), 40, 2);

    let first = tick(&root, &home, NOW, |_| true, NO_PAUSE);
    assert!(
        matches!(&first, Tick::Ran(p) if p.deleted == 40),
        "{first:?}"
    );
    assert_eq!(rows(&db), 2);
    assert_eq!(
        std::fs::read_to_string(root.join("metrics-prune-ts")).unwrap(),
        NOW.to_string()
    );

    assert_eq!(
        tick(&root, &home, NOW + 60, |_| true, NO_PAUSE),
        Tick::NotDue
    );
    insert(&db, 3, NOW - 10 * DAY);
    let later = tick(&root, &home, NOW + 7 * 3600, |_| true, NO_PAUSE);
    assert!(
        matches!(&later, Tick::Ran(p) if p.deleted == 3),
        "{later:?}"
    );
}

#[test]
fn a_tick_that_finds_the_db_busy_runs_nothing_and_stamps_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (root, home, db) = managed(dir.path(), 40, 2);

    assert_eq!(tick(&root, &home, NOW, |_| false, NO_PAUSE), Tick::NotIdle);

    assert_eq!(rows(&db), 42);
    assert!(!root.join("metrics-prune-ts").exists());
}

#[test]
fn a_tick_the_daemons_lock_cut_short_is_not_stamped_so_the_next_tick_retries() {
    let dir = tempfile::tempdir().unwrap();
    let (root, home, db) = managed(dir.path(), 40, 2);
    let holder = Connection::open(&db).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();

    let outcome = tick(&root, &home, NOW, |_| true, NO_PAUSE);

    assert!(
        matches!(&outcome, Tick::Ran(p) if p.stopped_busy),
        "{outcome:?}"
    );
    assert!(!root.join("metrics-prune-ts").exists());
    holder.execute_batch("ROLLBACK").unwrap();
    assert!(matches!(
        tick(&root, &home, NOW, |_| true, NO_PAUSE),
        Tick::Ran(p) if p.deleted == 40
    ));
}

#[test]
fn a_failing_prune_is_reported_and_stamped_so_it_repeats_each_interval_not_each_tick() {
    let dir = tempfile::tempdir().unwrap();
    let (root, home, db) = managed(dir.path(), 0, 0);
    // A db with no `metrics` table: the delete fails with a schema error, not a lock.
    Connection::open(&db)
        .unwrap()
        .execute_batch("DROP TABLE metrics")
        .unwrap();

    let outcome = tick(&root, &home, NOW, |_| true, NO_PAUSE);

    assert!(matches!(outcome, Tick::Failed(_)), "{outcome:?}");
    assert!(root.join("metrics-prune-ts").exists());
    assert_eq!(
        tick(&root, &home, NOW + 60, |_| true, NO_PAUSE),
        Tick::NotDue
    );
}

#[test]
fn the_window_is_three_days() {
    assert_eq!(RETENTION_SECS, KEEP);
}
