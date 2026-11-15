// SPDX-License-Identifier: MIT
//! A retention for git-ai's metrics-db.
//!
//! The daemon records every agent session event in `metrics-db` and only ever deletes rows older
//! than a year, and it never shrinks the file. CodeSense never uploads those rows (git-ai
//! telemetry is off), so nothing marks them delivered and the file grows by about a gigabyte a
//! day. [`prune`] drops rows past a short window and returns the freed pages to the filesystem.
//!
//! It works beside the running daemon rather than around it: rows go in small batches, each its
//! own transaction, and every wait for the daemon's lock is short. A lock it cannot get ends the
//! run without error, and the next run picks up where this one stopped.

use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// How long a metric row is kept.
pub(crate) const KEEP_SECS: u64 = 3 * 24 * 3600;
/// How often a launch may start a prune.
const INTERVAL_SECS: u64 = 6 * 3600;
const BATCH: i64 = 5_000;
const LOCK_WAIT: Duration = Duration::from_millis(100);
/// Below this many free pages (1 MiB) the file is left as it is.
const MIN_FREE_PAGES: i64 = 256;

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Pruned {
    pub deleted: usize,
    pub compacted: bool,
}

/// Delete the rows older than `keep_secs` before `now`, then compact the file if a quarter of
/// it is free. A missing db, or one the daemon holds locked, is not an error.
pub(crate) fn prune(db: &Path, now: u64, keep_secs: u64) -> rusqlite::Result<Pruned> {
    if !db.is_file() {
        return Ok(Pruned::default());
    }
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(LOCK_WAIT)?;
    let cutoff = now.saturating_sub(keep_secs) as i64;
    let mut pruned = Pruned::default();
    // The kind test matches the partial index on (event_ts, event_kind, id), so the walk
    // reads index pages instead of the whole table.
    while let Some(count) = busy_is_none(conn.execute(
        "DELETE FROM metrics WHERE id IN (
             SELECT id FROM metrics
             WHERE event_ts IS NOT NULL AND event_kind IS NOT NULL AND event_ts < ?1
             LIMIT ?2)",
        rusqlite::params![cutoff, BATCH],
    ))? {
        if count == 0 {
            break;
        }
        pruned.deleted += count;
    }
    pruned.compacted = match compact(&conn) {
        Ok(done) => done,
        Err(error) if is_busy(&error) => false,
        Err(error) => return Err(error),
    };
    Ok(pruned)
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

/// `Some` for a result, `None` when the daemon's lock was held.
fn busy_is_none<T>(result: rusqlite::Result<T>) -> rusqlite::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_busy(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn compact(conn: &Connection) -> rusqlite::Result<bool> {
    let free: i64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    if free < MIN_FREE_PAGES || free * 4 < pages {
        return Ok(false);
    }
    // Fold the log back so the file itself shrinks, and keep the log small afterwards.
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    let auto: i64 = conn.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
    if auto == 2 {
        conn.execute_batch("PRAGMA incremental_vacuum")?;
    } else {
        // Incremental mode is recorded by the rebuild, so later runs can free pages cheaply.
        conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM")?;
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    Ok(true)
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Where git-ai keeps the metrics-db under a managed home.
fn db_path(git_ai_home: &Path) -> PathBuf {
    git_ai_home
        .join(".git-ai")
        .join("internal")
        .join("metrics-db")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Start a prune on a background thread when the last one is over [`INTERVAL_SECS`] old. At
/// most one runs at a time, and a home with no metrics-db spawns nothing.
pub(crate) fn prune_if_due(managed_root: &Path, git_ai_home: &Path) {
    let db = db_path(git_ai_home);
    if !db.is_file() {
        return;
    }
    let stamp = managed_root.join("metrics-prune-ts");
    let now = now_secs();
    let last = std::fs::read_to_string(&stamp)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok());
    if last.is_some_and(|last| now.saturating_sub(last) < INTERVAL_SECS) {
        return;
    }
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("metrics-db-prune".into())
        .spawn(move || {
            let result = prune(&db, now, KEEP_SECS);
            // Stamp after a finished run only, so a locked one is retried at the next launch.
            if result.is_ok() {
                let _ = std::fs::write(&stamp, now.to_string());
            }
            RUNNING.store(false, Ordering::Release);
        });
    if spawned.is_err() {
        RUNNING.store(false, Ordering::Release);
    }
}
