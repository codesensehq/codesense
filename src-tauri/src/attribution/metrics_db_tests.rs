// SPDX-License-Identifier: MIT
use super::metrics_db::{prune, Pruned};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

const NOW: u64 = 2_000_000_000;
const DAY: u64 = 24 * 3600;
const KEEP: u64 = 3 * DAY;
const PAYLOAD: usize = 8 * 1024;

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
    let payload = "x".repeat(PAYLOAD);
    let insert = |count: usize, ts: u64| {
        for _ in 0..count {
            conn.execute(
                "INSERT INTO metrics (event_json, event_ts, event_kind) VALUES (?1, ?2, 5)",
                rusqlite::params![payload, ts as i64],
            )
            .unwrap();
        }
    };
    insert(old, NOW - 10 * DAY);
    insert(fresh, NOW - 3600);
    path
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

#[test]
fn rows_past_retention_are_deleted_once_and_the_file_shrinks() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 300, 5);
    let before = size(&path);

    let first = prune(&path, NOW, KEEP).unwrap();

    assert_eq!(first.deleted, 300);
    assert!(first.compacted);
    assert_eq!(rows(&path), 5);
    assert!(size(&path) < before / 10, "{} -> {}", before, size(&path));

    let second = prune(&path, NOW, KEEP).unwrap();
    assert_eq!(second, Pruned::default());
}

#[test]
fn the_db_still_takes_inserts_after_a_prune_and_ids_keep_counting() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 50, 2);
    prune(&path, NOW, KEEP).unwrap();

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

    let pruned = prune(&path, NOW, KEEP).unwrap();

    assert_eq!(pruned, Pruned::default());
    assert_eq!(rows(&path), 5);
}

#[test]
fn a_missing_db_is_nothing_to_prune() {
    let dir = tempfile::tempdir().unwrap();
    let pruned = prune(&dir.path().join("metrics-db"), NOW, KEEP).unwrap();
    assert_eq!(pruned, Pruned::default());
    assert!(!dir.path().join("metrics-db").exists());
}

#[test]
fn a_write_locked_db_is_left_alone_and_nothing_is_lost() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture(dir.path(), 20, 1);
    let holder = Connection::open(&path).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();

    let pruned = prune(&path, NOW, KEEP).unwrap();

    assert_eq!(pruned, Pruned::default());
    holder.execute_batch("ROLLBACK").unwrap();
    assert_eq!(rows(&path), 21);
}
