// SPDX-License-Identifier: MIT
//! Per-command invoke-rate instrumentation (SV-PBF-267 PR 1).
//!
//! A process-global registry of command names → counters, so an idle app that
//! burns CPU can be asked *which* commands fire and how often. Only command
//! names and numbers are recorded: never arguments, paths or results.
//!
//! Three kinds share the registry but not keys, so a command that is both a
//! Tauri invoke and an `await_blocking` label is not double counted:
//! - [`Kind::Invoke`]: every frontend invoke (count only, taken at the handler);
//! - [`Kind::Blocking`]: `await_blocking(label, ..)` (in-flight + duration);
//! - [`Kind::Mcp`]: MCP tool dispatch, shown as `mcp:<tool>`.
//!
//! Rates use two 60 s buckets (current + previous). Quiet idle writes nothing
//! to the log: the one `invoke_rate` line per completed window is emitted only
//! if an entry ran at ≥ 1/s or reached 4 concurrent calls, and only by a call
//! that crosses the window boundary (no timer thread).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

const WINDOW_SECS: u64 = 60;
/// Distinct names kept per kind. Frontend command strings are attacker-shaped
/// (any webview can invoke any string), so overflow folds into [`OVERFLOW`].
const MAX_NAMES_PER_KIND: usize = 512;
const OVERFLOW: &str = "<other>";
/// Names longer than this, or outside `[A-Za-z0-9_:|.-]`, are folded into [`OVERFLOW`]
/// so a caller cannot grow memory or inject text into the log.
const MAX_NAME_LEN: usize = 128;
const LOG_MIN_PER_SEC: u64 = 1;
const LOG_MIN_IN_FLIGHT: u32 = 4;
const LOG_TOP: usize = 15;
const HEALTH_TOP: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Invoke,
    Blocking,
    Mcp,
}

impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Kind::Invoke => "",
            Kind::Blocking => "blocking:",
            Kind::Mcp => "mcp:",
        }
    }
    fn slot(self) -> usize {
        self as usize
    }
}

/// One window's numbers for one name. Always read and written under the bucket's
/// mutex, so resetting it for a new window can never drop a concurrent count.
#[derive(Clone, Copy)]
struct BucketData {
    epoch: u64,
    count: u64,
    max_in_flight: u32,
    total_ns: u64,
    max_ns: u64,
}

const EMPTY_BUCKET: BucketData = BucketData {
    epoch: u64::MAX,
    count: 0,
    max_in_flight: 0,
    total_ns: 0,
    max_ns: 0,
};

struct Entry {
    in_flight: AtomicU32,
    buckets: [Mutex<BucketData>; 2],
}

#[derive(Clone, Copy, Default)]
struct MetricBucket {
    epoch: u64,
    count: u64,
    gauge: Option<u64>,
}

impl Entry {
    fn new() -> Self {
        Entry {
            in_flight: AtomicU32::new(0),
            buckets: [Mutex::new(EMPTY_BUCKET), Mutex::new(EMPTY_BUCKET)],
        }
    }

    /// Run `f` on the bucket for `epoch`, first resetting it if it still holds an
    /// older window. A late caller whose window has already been replaced
    /// (a call that outlived two windows) is skipped rather than clobbering newer data.
    fn with_bucket(&self, epoch: u64, f: impl FnOnce(&mut BucketData)) {
        let mut b = self.buckets[(epoch % 2) as usize]
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if b.epoch != epoch {
            if b.epoch != u64::MAX && b.epoch > epoch {
                return;
            }
            *b = BucketData {
                epoch,
                ..EMPTY_BUCKET
            };
        }
        f(&mut b);
    }

    fn read_bucket(&self, epoch: u64) -> Option<BucketData> {
        let b = self.buckets[(epoch % 2) as usize]
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        (b.epoch == epoch).then_some(*b)
    }
}

/// One row of a snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub kind: Kind,
    pub name: String,
    pub count: u64,
    pub per_sec: f64,
    pub in_flight: u32,
    pub max_in_flight: u32,
    pub total_ms: f64,
    pub max_ms: f64,
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '|' | '.' | '-')
}

fn name_is_safe(name: &str) -> bool {
    name.trim_matches(name_char) == ""
}

/// Fold all `mcp:<tool>` rows into one `mcp:*` row (counts and times add up).
fn fold_mcp(rows: Vec<Row>) -> Vec<Row> {
    let mut out = Vec::new();
    let mut folded: Option<Row> = None;
    for r in rows {
        if r.kind != Kind::Mcp {
            out.push(r);
            continue;
        }
        match &mut folded {
            Some(a) => {
                a.count += r.count;
                a.per_sec += r.per_sec;
                a.in_flight += r.in_flight;
                a.max_in_flight = a.max_in_flight.max(r.max_in_flight);
                a.total_ms += r.total_ms;
                a.max_ms = a.max_ms.max(r.max_ms);
            }
            None => {
                folded = Some(Row {
                    name: "mcp:*".into(),
                    ..r
                })
            }
        }
    }
    if let Some(a) = folded {
        out.push(a);
    }
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    out
}

pub struct Registry {
    maps: [RwLock<HashMap<Box<str>, Arc<Entry>>>; 3],
    reported_epoch: AtomicU64,
    metrics: Mutex<HashMap<Box<str>, [MetricBucket; 2]>>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Registry {
            maps: Default::default(),
            reported_epoch: AtomicU64::new(0),
            metrics: Mutex::new(HashMap::new()),
        }
    }

    fn entry(&self, kind: Kind, name: &str) -> Arc<Entry> {
        // `await_blocking` labels are `&'static str` literals (some contain spaces), so
        // they are trusted and only bounded by MAX_NAMES_PER_KIND; Invoke and Mcp names
        // come from callers and are filtered.
        let untrusted = kind != Kind::Blocking;
        let name = if untrusted && (name.len() > MAX_NAME_LEN || !name_is_safe(name)) {
            OVERFLOW
        } else {
            name
        };
        let map = &self.maps[kind.slot()];
        if let Some(e) = map.read().unwrap_or_else(|e| e.into_inner()).get(name) {
            return e.clone();
        }
        let mut w = map.write().unwrap_or_else(|e| e.into_inner());
        let key = if w.len() >= MAX_NAMES_PER_KIND && !w.contains_key(name) {
            OVERFLOW
        } else {
            name
        };
        w.entry(key.into())
            .or_insert_with(|| Arc::new(Entry::new()))
            .clone()
    }

    /// Count one call. `now` is the time since registry start.
    pub fn count_at(&self, kind: Kind, name: &str, now: Duration) -> Option<String> {
        let epoch = now.as_secs() / WINDOW_SECS;
        let e = self.entry(kind, name);
        e.with_bucket(epoch, |b| b.count += 1);
        self.rollover(epoch)
    }

    /// Record an internal event counter. Names are code-defined and capped to
    /// the same safe character set as invoke names.
    pub fn metric_count_at(&self, name: &str, now: Duration) -> Option<String> {
        self.metric_add_at(name, 1, now)
    }

    /// Add an amount to an internal event counter.
    pub fn metric_add_at(&self, name: &str, amount: u64, now: Duration) -> Option<String> {
        self.update_metric(name, now, |m| m.count = m.count.saturating_add(amount));
        self.rollover(now.as_secs() / WINDOW_SECS)
    }

    /// Set an internal gauge for the current reporting window.
    pub fn metric_gauge_at(&self, name: &str, value: u64, now: Duration) -> Option<String> {
        self.update_metric(name, now, |m| m.gauge = Some(value));
        self.rollover(now.as_secs() / WINDOW_SECS)
    }

    #[cfg(test)]
    fn metric_at(&self, name: &str, epoch: u64) -> Option<MetricBucket> {
        let metrics = self.metrics.lock().unwrap_or_else(|e| e.into_inner());
        metrics.get(name).map(|buckets| buckets[(epoch % 2) as usize]).filter(|b| b.epoch == epoch)
    }

    fn update_metric(&self, name: &str, now: Duration, update: impl FnOnce(&mut MetricBucket)) {
        if name.len() > MAX_NAME_LEN || !name_is_safe(name) {
            return;
        }
        let epoch = now.as_secs() / WINDOW_SECS;
        let mut metrics = self.metrics.lock().unwrap_or_else(|e| e.into_inner());
        if metrics.len() >= MAX_NAMES_PER_KIND && !metrics.contains_key(name) {
            return;
        }
        let buckets = metrics.entry(name.into()).or_insert([MetricBucket::default(); 2]);
        let bucket = &mut buckets[(epoch % 2) as usize];
        if bucket.epoch != epoch {
            if bucket.epoch > epoch && bucket.epoch != 0 {
                return;
            }
            *bucket = MetricBucket { epoch, ..MetricBucket::default() };
        }
        update(bucket);
    }

    /// Begin a timed call; the guard records in-flight and duration on drop.
    pub fn begin_at(&self, kind: Kind, name: &str, now: Duration) -> Guard {
        let epoch = now.as_secs() / WINDOW_SECS;
        let e = self.entry(kind, name);
        let now_in = e.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        e.with_bucket(epoch, |b| {
            b.count += 1;
            b.max_in_flight = b.max_in_flight.max(now_in);
        });
        let line = self.rollover(epoch);
        Guard {
            entry: e,
            start: Instant::now(),
            epoch,
            line,
        }
    }

    /// First call to observe a new epoch reports the completed one.
    fn rollover(&self, epoch: u64) -> Option<String> {
        let last = self.reported_epoch.load(Ordering::Acquire);
        if epoch <= last
            || self
                .reported_epoch
                .compare_exchange(last, epoch, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        self.report_line(epoch - 1)
    }

    fn window_rows(&self, epochs: &[u64], covered_secs: f64) -> Vec<Row> {
        let mut rows = Vec::new();
        for kind in [Kind::Invoke, Kind::Blocking, Kind::Mcp] {
            let map = self.maps[kind.slot()]
                .read()
                .unwrap_or_else(|e| e.into_inner());
            for (name, e) in map.iter() {
                let (mut count, mut max_if, mut total, mut max_ns) = (0u64, 0u32, 0u64, 0u64);
                for &ep in epochs {
                    if let Some(b) = e.read_bucket(ep) {
                        count += b.count;
                        max_if = max_if.max(b.max_in_flight);
                        total += b.total_ns;
                        max_ns = max_ns.max(b.max_ns);
                    }
                }
                let in_flight = e.in_flight.load(Ordering::Relaxed);
                if count == 0 && in_flight == 0 {
                    continue;
                }
                rows.push(Row {
                    kind,
                    name: format!("{}{}", kind.prefix(), name),
                    count,
                    per_sec: count as f64 / covered_secs,
                    in_flight,
                    max_in_flight: max_if,
                    total_ms: total as f64 / 1e6,
                    max_ms: max_ns as f64 / 1e6,
                });
            }
        }
        rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        rows
    }

    /// The log line for a completed window, or `None` at quiet idle.
    pub fn report_line(&self, epoch: u64) -> Option<String> {
        let mut rows = self.window_rows(&[epoch], WINDOW_SECS as f64);
        let metrics = self.metric_rows(epoch);
        if rows.is_empty() && metrics.is_empty() || !rows.iter().any(|r| {
            r.count >= LOG_MIN_PER_SEC * WINDOW_SECS || r.max_in_flight >= LOG_MIN_IN_FLIGHT
        }) && metrics.is_empty() {
            return None;
        }
        rows.truncate(LOG_TOP);
        let body: Vec<String> = rows
            .iter()
            .map(|r| {
                format!(
                    "{} {} {:.2}/s maxInFlight={} totalMs={:.0} maxMs={:.0}",
                    r.name, r.count, r.per_sec, r.max_in_flight, r.total_ms, r.max_ms
                )
            })
            .collect();
        let metric_counts = metrics
            .iter()
            .map(|(name, count, _)| (name.clone(), *count))
            .collect::<HashMap<_, _>>();
        let mut metric_body = metrics
            .into_iter()
            .map(|(name, count, gauge)| {
                format!(
                    "{name} count={count} rate={:.2}/s{}",
                    count as f64 / WINDOW_SECS as f64,
                    gauge.map(|v| format!(" value={v}")).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>();
        if let Some(rebuilds) = metric_counts
            .get("live_hub.rebuild")
            .copied()
            .filter(|count| *count > 0)
        {
            let activity_only = metric_counts
                .get("live_hub.rebuild.activity_only")
                .copied()
                .unwrap_or(0);
            metric_body.push(format!(
                "live_hub.rebuild.activity_only_share={:.2}%",
                100.0 * activity_only as f64 / rebuilds as f64
            ));
        }
        Some(format!("window={WINDOW_SECS}s {}{}", body.join("; "),
            if metric_body.is_empty() { String::new() } else { format!("; m4 {}", metric_body.join("; ")) }))
    }

    fn metric_rows(&self, epoch: u64) -> Vec<(String, u64, Option<u64>)> {
        let metrics = self.metrics.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows = metrics.iter().filter_map(|(name, buckets)| {
            let bucket = buckets[(epoch % 2) as usize];
            (bucket.epoch == epoch).then(|| (name.to_string(), bucket.count, bucket.gauge))
        }).collect::<Vec<_>>();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows
    }

    /// `health_ping` payload: current + previous window, top rows by count.
    /// Without `mcp_tool_names`, every `mcp:<tool>` row is folded into one `mcp:*`
    /// aggregate, so a caller sees the load but not which tools other sessions call.
    pub fn snapshot_json_at(&self, now: Duration, mcp_tool_names: bool) -> serde_json::Value {
        let secs = now.as_secs();
        let epoch = secs / WINDOW_SECS;
        let covered = if epoch == 0 {
            secs.max(1) as f64
        } else {
            (WINDOW_SECS + secs % WINDOW_SECS) as f64
        };
        let epochs: Vec<u64> = if epoch == 0 {
            vec![0]
        } else {
            vec![epoch, epoch - 1]
        };
        let mut rows = self.window_rows(&epochs, covered);
        if !mcp_tool_names {
            rows = fold_mcp(rows);
        }
        rows.truncate(HEALTH_TOP);
        serde_json::json!({
            "windowSecs": covered as u64,
            "sinceStartSecs": secs,
            "top": rows.iter().map(|r| serde_json::json!({
                "name": r.name,
                "count": r.count,
                "perSec": (r.per_sec * 100.0).round() / 100.0,
                "inFlight": r.in_flight,
                "maxInFlight": r.max_in_flight,
                "totalMs": r.total_ms.round(),
                "maxMs": r.max_ms.round(),
            })).collect::<Vec<_>>(),
        })
    }
}

pub struct Guard {
    entry: Arc<Entry>,
    start: Instant,
    epoch: u64,
    line: Option<String>,
}

impl Guard {
    /// The `invoke_rate` line produced if this call crossed a window boundary.
    pub fn take_report(&mut self) -> Option<String> {
        self.line.take()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let ns = self.start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        self.entry.in_flight.fetch_sub(1, Ordering::AcqRel);
        // Attribute the duration to the window the call started in.
        self.entry.with_bucket(self.epoch, |b| {
            b.total_ns += ns;
            b.max_ns = b.max_ns.max(ns);
        });
    }
}

fn global() -> &'static Arc<Registry> {
    static G: OnceLock<Arc<Registry>> = OnceLock::new();
    G.get_or_init(|| Arc::new(Registry::new()))
}

fn since_start() -> Duration {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

fn emit(line: Option<String>) {
    if let Some(line) = line {
        log::info!(target: "invoke_rate", "{line}");
    }
}

/// Count a frontend invoke (called from the Tauri `invoke_handler` wrapper).
pub fn count(command: &str) {
    emit(global().count_at(Kind::Invoke, command, since_start()));
}

/// Wrap the Tauri `invoke_handler` so every frontend invoke is counted.
pub fn counted<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        count(tauri::ipc::InvokeMessage::command(&invoke.message));
        handler(invoke)
    }
}

/// Time a blocking command or MCP tool; hold the guard for the call's duration.
pub fn begin(kind: Kind, name: &str) -> Guard {
    let mut g = global().begin_at(kind, name, since_start());
    emit(g.take_report());
    g
}

/// `health_ping`'s `invokeStats` object. `mcp_tool_names` is false for callers
/// from another machine: they get the aggregate `mcp:*` row only.
pub fn snapshot_json(mcp_tool_names: bool) -> serde_json::Value {
    global().snapshot_json_at(since_start(), mcp_tool_names)
}

/// Record a low-cardinality internal event in the same sixty-second report.
pub fn metric_count(name: &str) {
    emit(global().metric_count_at(name, since_start()));
}

/// Add an amount to a low-cardinality internal event counter.
pub fn metric_add(name: &str, amount: usize) {
    emit(global().metric_add_at(name, amount as u64, since_start()));
}

/// Update a low-cardinality internal gauge in the same sixty-second report.
pub fn metric_gauge(name: &str, value: usize) {
    emit(global().metric_gauge_at(name, value as u64, since_start()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn concurrent_guards_track_in_flight_and_max() {
        let r = Registry::new();
        let gs: Vec<_> = (0..5)
            .map(|_| r.begin_at(Kind::Blocking, "cmd", secs(1)))
            .collect();
        let row = &r.window_rows(&[0], 1.0)[0];
        assert_eq!((row.in_flight, row.max_in_flight, row.count), (5, 5, 5));
        drop(gs);
        let row = &r.window_rows(&[0], 1.0)[0];
        assert_eq!((row.in_flight, row.max_in_flight), (0, 5));
        assert!(row.total_ms >= 0.0);
        assert_eq!(row.name, "blocking:cmd");
    }

    #[test]
    fn window_rolls_and_old_buckets_expire() {
        let r = Registry::new();
        for _ in 0..3 {
            r.count_at(Kind::Invoke, "a", secs(5));
        }
        r.count_at(Kind::Invoke, "a", secs(65));
        let snap = r.snapshot_json_at(secs(65), true);
        assert_eq!(snap["top"][0]["count"], 4); // previous + current
                                                // Two windows later the first bucket is gone; the previous one still counts.
        r.count_at(Kind::Invoke, "a", secs(130));
        let snap = r.snapshot_json_at(secs(130), true);
        assert_eq!(snap["top"][0]["count"], 2);
        let snap = r.snapshot_json_at(secs(190), true);
        assert_eq!(snap["top"].as_array().unwrap().len(), 1);
        assert_eq!(snap["top"][0]["count"], 1, "only the epoch-2 call remains");
    }

    #[test]
    fn log_line_suppressed_below_threshold_and_emitted_above() {
        let r = Registry::new();
        for _ in 0..10 {
            r.count_at(Kind::Invoke, "quiet", secs(1));
        }
        assert_eq!(r.report_line(0), None);
        assert_eq!(r.count_at(Kind::Invoke, "quiet", secs(61)), None);
        for _ in 0..60 {
            r.count_at(Kind::Invoke, "hot", secs(70));
        }
        let line = r
            .count_at(Kind::Invoke, "hot", secs(125))
            .expect("rollover reports");
        assert!(line.starts_with("window=60s hot 60 1.00/s"), "{line}");
    }

    #[test]
    fn in_flight_alone_triggers_the_log_line() {
        let r = Registry::new();
        let gs: Vec<_> = (0..4)
            .map(|_| r.begin_at(Kind::Mcp, "query_context", secs(1)))
            .collect();
        drop(gs);
        let line = r.report_line(0).expect("4 concurrent");
        assert!(line.contains("mcp:query_context") && line.contains("maxInFlight=4"));
    }

    #[test]
    fn records_names_and_numbers_only() {
        let r = Registry::new();
        r.count_at(Kind::Invoke, "read_file", secs(1));
        let text = r.snapshot_json_at(secs(1), true).to_string();
        let obj = r.snapshot_json_at(secs(1), true);
        let keys: Vec<_> = obj["top"][0].as_object().unwrap().keys().cloned().collect();
        for k in &keys {
            assert!(
                [
                    "name",
                    "count",
                    "perSec",
                    "inFlight",
                    "maxInFlight",
                    "totalMs",
                    "maxMs"
                ]
                .contains(&k.as_str()),
                "unexpected field {k}"
            );
        }
        assert!(text.contains("read_file"));
        // The API takes no argument-bearing parameter at all: compile-time guarantee.
    }

    #[test]
    fn long_or_unsafe_names_fold_into_other() {
        let r = Registry::new();
        r.count_at(Kind::Invoke, &"x".repeat(MAX_NAME_LEN + 1), secs(1));
        r.count_at(Kind::Invoke, "a\nb", secs(1));
        r.count_at(Kind::Invoke, "ok_name", secs(1));
        let snap = r.snapshot_json_at(secs(1), true);
        let names: Vec<_> = snap["top"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                (
                    t["name"].as_str().unwrap().to_string(),
                    t["count"].as_u64().unwrap(),
                )
            })
            .collect();
        assert!(names.contains(&("<other>".to_string(), 2)), "{names:?}");
        assert!(names.contains(&("ok_name".to_string(), 1)));
    }

    #[test]
    fn blocking_labels_with_spaces_keep_their_own_row() {
        let r = Registry::new();
        drop(r.begin_at(Kind::Blocking, "context worktree status", secs(1)));
        r.count_at(Kind::Invoke, "bad name", secs(1));
        let snap = r.snapshot_json_at(secs(1), true);
        let names: Vec<_> = snap["top"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(
            names.contains(&"blocking:context worktree status".to_string()),
            "{names:?}"
        );
        assert!(
            names.contains(&"<other>".to_string()),
            "caller-supplied names still fold"
        );
    }

    #[test]
    fn remote_callers_see_one_mcp_aggregate_and_no_tool_names() {
        let r = Registry::new();
        r.count_at(Kind::Invoke, "list_things", secs(1));
        for _ in 0..3 {
            r.count_at(Kind::Mcp, "query_context", secs(1));
        }
        r.count_at(Kind::Mcp, "send_message", secs(1));
        let names = |snap: &serde_json::Value| -> Vec<String> {
            snap["top"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };
        let local = names(&r.snapshot_json_at(secs(1), true));
        assert!(local.contains(&"mcp:query_context".to_string()));
        let remote = r.snapshot_json_at(secs(1), false);
        let remote_names = names(&remote);
        assert_eq!(remote_names, vec!["mcp:*", "list_things"]);
        assert_eq!(remote["top"][0]["count"], 4);
    }

    #[test]
    fn concurrent_window_rollover_loses_no_counts() {
        let r = std::sync::Arc::new(Registry::new());
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let r = r.clone();
                std::thread::spawn(move || {
                    for i in 0..5_000u64 {
                        // Every thread crosses the same window boundaries together.
                        r.count_at(Kind::Invoke, "hot", secs(i / 1_000 * 60 + t % 2));
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let e = r.entry(Kind::Invoke, "hot");
        let total: u64 = (0..5u64)
            .filter_map(|ep| e.read_bucket(ep))
            .map(|b| b.count)
            .sum();
        // Only the two most recent windows are retained; each holds exactly its calls.
        assert_eq!(total, 2 * 8 * 1_000);
    }

    #[test]
    fn name_cardinality_is_bounded() {
        let r = Registry::new();
        for i in 0..(MAX_NAMES_PER_KIND + 50) {
            r.count_at(Kind::Invoke, &format!("evil{i}"), secs(1));
        }
        let n = r.maps[Kind::Invoke.slot()].read().unwrap().len();
        assert!(n <= MAX_NAMES_PER_KIND + 1);
    }

    #[test]
    fn count_micro_bench_one_million_under_one_second() {
        let r = Registry::new();
        let t = Instant::now();
        for _ in 0..1_000_000 {
            r.count_at(Kind::Invoke, "hot", secs(1));
        }
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    }

    #[test]
    fn global_snapshot_shape() {
        let v = snapshot_json(true);
        assert!(v["windowSecs"].is_number() && v["sinceStartSecs"].is_number());
        assert!(v["top"].is_array());
    }

    #[test]
    fn registry_snapshot_shape() {
        let registry = Registry::new();
        registry.count_at(Kind::Invoke, "stubbed_command_for_test", secs(1));
        let v = registry.snapshot_json_at(secs(1), true);
        assert!(v["windowSecs"].is_number() && v["sinceStartSecs"].is_number());
        assert!(v["top"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "stubbed_command_for_test"));
    }

    #[test]
    fn m4_metrics_appear_when_recorded_and_are_absent_when_idle() {
        let r = Registry::new();
        assert_eq!(r.report_line(0), None);
        r.metric_count_at("live_hub.rebuild", secs(2));
        r.metric_gauge_at("live_hub.agent_views", 3, secs(2));
        let line = r.report_line(0).expect("metric activity is reported");
        assert!(line.contains("live_hub.rebuild count=1 rate=0.02/s"), "{line}");
        assert!(line.contains("live_hub.agent_views count=0 rate=0.00/s value=3"), "{line}");
        assert_eq!(r.report_line(1), None);
    }

    #[test]
    fn m4_delta_bytes_accumulate_and_rebuild_share_needs_a_rebuild() {
        let r = Registry::new();
        assert!(r.metric_at("live_hub.delta.bytes.sessions", 0).is_none());
        r.metric_add_at("live_hub.delta.bytes.sessions", 100, secs(1));
        r.metric_add_at("live_hub.delta.bytes.sessions", 50, secs(2));
        assert_eq!(r.metric_at("live_hub.delta.bytes.sessions", 0).unwrap().count, 150);
        // No rebuild recorded: no share is printed even with other metrics present.
        let line = r.report_line(0).unwrap();
        assert!(!line.contains("activity_only_share"), "{line}");
        r.metric_count_at("live_hub.rebuild", secs(3));
        r.metric_count_at("live_hub.rebuild", secs(3));
        r.metric_count_at("live_hub.rebuild.activity_only", secs(3));
        let line = r.report_line(0).unwrap();
        assert!(line.contains("live_hub.rebuild.activity_only_share=50.00%"), "{line}");
        assert!(line.contains("live_hub.delta.bytes.sessions count=150"), "{line}");
    }

    #[test]
    fn m4_event_metrics_change_only_after_their_event_is_recorded() {
        let r = Registry::new();
        assert!(r.metric_at("session_record.read", 0).is_none());
        assert!(r.metric_at("story_changes.git_child", 0).is_none());
        assert!(r.metric_at("session_text.emit", 0).is_none());
        r.metric_count_at("session_record.read", secs(1));
        r.metric_count_at("story_changes.git_child", secs(1));
        r.metric_count_at("session_text.emit", secs(1));
        assert_eq!(r.metric_at("session_record.read", 0).unwrap().count, 1);
        assert_eq!(r.metric_at("story_changes.git_child", 0).unwrap().count, 1);
        assert_eq!(r.metric_at("session_text.emit", 0).unwrap().count, 1);
        assert!(r.metric_at("session_record.read", 1).is_none());
    }
}
