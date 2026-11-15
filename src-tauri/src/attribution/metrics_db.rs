// SPDX-License-Identifier: MIT
//! A retention for git-ai's metrics-db.
//!
//! The daemon records every agent session event in `metrics-db` and only ever deletes rows older
//! than a year, and it never shrinks the file. CodeSense never uploads those rows (git-ai
//! telemetry is off), so nothing marks them delivered and the file grows by about a gigabyte a
//! day. [`prune`] drops rows past [`RETENTION_SECS`] and returns the freed pages to the
//! filesystem.
//!
//! **What the window costs.** The rows are not only telemetry: git-ai's post-commit attribution
//! recovery reads the SessionEvents back (it matches a changed file's mtime to an event within a
//! few seconds, to recover AI attribution for lines whose checkpoint was missed). An agent edit
//! with a missed checkpoint that is committed more than [`RETENTION_SECS`] later has no event left
//! to match, and its lines fall back to unknown. Three days keeps the file near 0.7 GB; a longer
//! window recovers older commits at about 0.25 GB a day. The window is this one constant.
//!
//! **What it costs the daemon.** The daemon's own connection waits about five seconds for the
//! write lock and then drops the batch it was storing. A prune holds that lock for each delete
//! batch, and the one-time rebuild that turns on incremental vacuum holds it for the whole
//! rebuild (tens of seconds on a large file). So a sweep runs only when the db is idle (no new
//! row over [`IDLE_WINDOW`]), from a timer that starts after the app does, never on an agent
//! launch; it pauses between batches; and a lock it cannot get ends the run without a stamp, so
//! the next tick tries again.

use super::managed::Managed;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a metric row is kept. See the module doc for what a shorter or longer window trades.
pub(crate) const RETENTION_SECS: u64 = 3 * 24 * 3600;
/// How often a prune may run.
const INTERVAL_SECS: u64 = 6 * 3600;
/// How often the timer looks at whether a prune is due.
const TICK: Duration = Duration::from_secs(10 * 60);
/// How long after app start the first look is.
const STARTUP_DELAY: Duration = Duration::from_secs(2 * 60);
/// The db is idle when its newest row id is the same at both ends of this window.
const IDLE_WINDOW: Duration = Duration::from_secs(20);
/// Rest between delete batches, so the daemon's own inserts get the lock.
const BATCH_PAUSE: Duration = Duration::from_millis(75);
const BATCH: i64 = 5_000;
const LOCK_WAIT: Duration = Duration::from_millis(100);
/// Below this many free pages (1 MiB at 4 KiB) the file is left as it is.
const MIN_FREE_PAGES: i64 = 256;

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Pruned {
    pub deleted: usize,
    pub compacted: bool,
    /// The daemon held the lock before the run finished, so rows past the window may remain.
    pub stopped_busy: bool,
}

/// Delete the rows older than `keep_secs` before `now`, resting `pause` between batches, then
/// compact the file if a quarter of it is free. A missing db is not an error.
pub(crate) fn prune(
    db: &Path,
    now: u64,
    keep_secs: u64,
    pause: Duration,
) -> rusqlite::Result<Pruned> {
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
    loop {
        let result = conn.execute(
            "DELETE FROM metrics WHERE id IN (
                 SELECT id FROM metrics
                 WHERE event_ts IS NOT NULL AND event_kind IS NOT NULL AND event_ts < ?1
                 LIMIT ?2)",
            rusqlite::params![cutoff, BATCH],
        );
        match result {
            Ok(0) => break,
            Ok(count) => pruned.deleted += count,
            Err(error) if is_busy(&error) => {
                pruned.stopped_busy = true;
                return Ok(pruned);
            }
            Err(error) => return Err(error),
        }
        std::thread::sleep(pause);
    }
    match compact(&conn) {
        Ok(done) => pruned.compacted = done,
        Err(error) if is_busy(&error) => pruned.stopped_busy = true,
        Err(error) => return Err(error),
    }
    Ok(pruned)
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
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
        // The pragma returns one row per page it frees and frees a page as each row is
        // read, so the rows have to be stepped through (`execute_batch` stops after one).
        let mut statement = conn.prepare("PRAGMA incremental_vacuum")?;
        let mut rows = statement.query([])?;
        while rows.next()?.is_some() {}
    } else {
        // Incremental mode is recorded by the rebuild, so later runs can free pages cheaply.
        conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM")?;
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    Ok(true)
}

/// The newest row id, which moves whenever the daemon stores an event.
fn newest_id(db: &Path) -> rusqlite::Result<i64> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(LOCK_WAIT)?;
    conn.query_row("SELECT COALESCE(MAX(id), 0) FROM metrics", [], |row| {
        row.get(0)
    })
}

/// Whether no row was stored over `window`. `wait` is the sleep, so a test can store a row in it.
pub(crate) fn is_idle(db: &Path, window: Duration, wait: impl FnOnce(Duration)) -> bool {
    let Ok(before) = newest_id(db) else {
        return false;
    };
    wait(window);
    newest_id(db).is_ok_and(|after| after == before)
}

/// Where git-ai keeps the metrics-db under a managed home.
fn db_path(git_ai_home: &Path) -> PathBuf {
    git_ai_home
        .join(".git-ai")
        .join("internal")
        .join("metrics-db")
}

/// A prune is due when none was stamped, one was stamped [`INTERVAL_SECS`] ago, or the stamp is
/// in the future (the clock moved back).
pub(crate) fn due(last: Option<u64>, now: u64) -> bool {
    last.is_none_or(|last| last > now || now - last >= INTERVAL_SECS)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Tick {
    NoDb,
    NotDue,
    /// Rows were still arriving, or the db could not be read.
    NotIdle,
    Ran(Pruned),
    Failed(String),
}

/// One look: prune when a run is due and the db is idle. The stamp (in `managed_root`) is written
/// after a run that finished or failed, so a failing run (a full disk, a schema change) repeats
/// every [`INTERVAL_SECS`] and not every tick, and not after a run the daemon's lock cut short.
pub(crate) fn tick(
    managed_root: &Path,
    git_ai_home: &Path,
    now: u64,
    idle: impl FnOnce(&Path) -> bool,
    pause: Duration,
) -> Tick {
    let db = db_path(git_ai_home);
    if !db.is_file() {
        return Tick::NoDb;
    }
    let stamp = managed_root.join("metrics-prune-ts");
    let last = std::fs::read_to_string(&stamp)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok());
    if !due(last, now) {
        return Tick::NotDue;
    }
    if !idle(&db) {
        return Tick::NotIdle;
    }
    let result = prune(&db, now, RETENTION_SECS, pause);
    if !matches!(&result, Ok(pruned) if pruned.stopped_busy) {
        let _ = std::fs::write(&stamp, now.to_string());
    }
    match result {
        Ok(pruned) => Tick::Ran(pruned),
        Err(error) => Tick::Failed(error.to_string()),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Start the timer that keeps the metrics-db inside its window, on its own thread for the life of
/// the app. The first look is [`STARTUP_DELAY`] after start.
pub(crate) fn start(codesense_home: &Path) {
    let home = codesense_home.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("metrics-db-prune".into())
        .spawn(move || {
            std::thread::sleep(STARTUP_DELAY);
            let managed = Managed::for_codesense_home(&home);
            loop {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tick(
                        managed.root(),
                        &managed.git_ai_home(),
                        now_secs(),
                        |db| is_idle(db, IDLE_WINDOW, std::thread::sleep),
                        BATCH_PAUSE,
                    )
                }));
                match outcome {
                    Ok(Tick::Ran(pruned)) => log::info!(
                        target: "metrics_db",
                        "pruned {} rows past the window, compacted: {}, cut short by a lock: {}",
                        pruned.deleted, pruned.compacted, pruned.stopped_busy
                    ),
                    Ok(Tick::Failed(error)) => {
                        log::warn!(target: "metrics_db", "prune failed: {error}")
                    }
                    Ok(_) => {}
                    Err(_) => log::error!(target: "metrics_db", "prune panicked"),
                }
                std::thread::sleep(TICK);
            }
        });
    if let Err(error) = spawned {
        log::error!(target: "metrics_db", "prune timer failed to spawn: {error}");
    }
}
