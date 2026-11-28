// SPDX-License-Identifier: MIT
//! SW-FX-64 Layer 1: webview **renderer**-liveness watchdog — the out-of-band
//! recovery layer SF-11's in-renderer error boundary architecturally could not
//! provide.
//!
//! The recurring "whole window blanks after hours, restart-only" symptom is the
//! WKWebView *Web Content* (renderer) process being OOM-killed by macOS. That
//! death happens *to* the JS context — the V8 heap and DOM are gone before any
//! `window.onerror` or React error boundary can run — so nothing inside the
//! renderer can detect or recover it. Recovery must come from **outside** the
//! renderer, in Rust.
//!
//! Mechanism (mirrors the *shape* of [`crate::runtime::start_heartbeat`], but
//! **inverted**): the frontend pushes a liveness ack every
//! [`RENDERER_ACK_INTERVAL_MS`] via the `renderer_heartbeat` command, which
//! bumps [`RendererLiveness`]'s last-ack timestamp. A Rust background task ticks
//! every [`WATCHDOG_TICK_MS`], and when the last ack is older than
//! [`RENDERER_STALE_AFTER_MS`] (~3 missed acks) it treats the renderer as dead
//! and reloads the webview (`WebviewWindow::reload()`) — restoring a rendered UI
//! without a full app restart. The Rust process, PTYs, and sync engine are
//! untouched; a reload only re-navigates the WKWebView.
//!
//! Where `runtime.rs` is a *self-timer* (the process writes its own beat to
//! prove the **process** is alive), this watchdog *reads* an ack the renderer
//! pushes — because an OOM/wedged renderer can leave the Rust process perfectly
//! healthy while the screen is white. The two liveness signals are distinct and
//! both needed.
//!
//! AC-6: a reload must not thrash. After a reload the watchdog backs off
//! (exponential, capped by [`RELOAD_BACKOFF_CAP_MS`]) before it will reload
//! again, and resets that backoff the moment acks resume.
//!
//! Every window is watched: [`WindowLiveness`] holds a [`RendererLiveness`] per label, the
//! heartbeat writes the calling window's, and the one task steps each registered, non-pending
//! window ([`watch_step`]). `main` keeps the backoff ladder above and is never destroyed. A
//! satellite gets [`SATELLITE_MAX_RELOADS`] reloads in a row, each followed by
//! `renderer_recovery::RECOVERY_TIMEOUT` for a heartbeat; then its items return to `main` as
//! `crash` and the window is destroyed ([`give_up_satellite`]).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::runtime::now_ms;
use crate::windows::item_key::ItemKey;
use crate::windows::moves::MoveHost;
use crate::windows::registry::{Locked, WindowRegistry};
use crate::windows::returns::{return_by_kind_locked, ReturnReason};
use crate::windows::{is_main, MAIN_LABEL};

/// RF-perf-4 (AC-1): the per-resource FE instance tally pushed on the heartbeat —
/// the attribution the coarse renderer RSS cannot give (which surface class holds the
/// footprint). Every field is a small count maintained O(1) by the frontend
/// `fe-instance-registry`; the gated `memory` line (RF-perf-5) surfaces them beside
/// the renderer RSS. `#[serde(rename_all = "camelCase")]` accepts the JS payload's
/// `webglTerminals` etc. verbatim; `Copy` so it can be read out of the `Mutex`
/// without cloning.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeInstanceCounts {
    pub editors: u32,
    pub iframes: u32,
    pub webgl_terminals: u32,
    pub teams: u32,
}

/// How often the frontend pushes a liveness ack. Kept in sync with the FE
/// constant `RENDERER_HEARTBEAT_INTERVAL_MS` in `src/app/renderer-heartbeat.ts`.
pub const RENDERER_ACK_INTERVAL_MS: u64 = 30_000;

/// How often the watchdog task wakes to evaluate liveness. Finer than the ack
/// interval so a stale renderer is noticed promptly without waiting a full ack
/// period past the stale threshold.
pub const WATCHDOG_TICK_MS: u64 = 15_000;

/// A renderer that has not acked within this window is treated as dead: 3
/// missed acks — matching `runtime.rs`'s "several missed beats" philosophy so a
/// brief GC pause or a legitimately long synchronous task doesn't flap the
/// signal, but a real content-process death surfaces within ~1.5 ticks.
pub const RENDERER_STALE_AFTER_MS: u64 = 3 * RENDERER_ACK_INTERVAL_MS;

/// Base backoff after the first reload before another reload may fire (AC-6).
/// Doubles per consecutive reload, capped at [`RELOAD_BACKOFF_CAP_MS`].
pub const RELOAD_BACKOFF_BASE_MS: u64 = 60_000;

/// Upper bound on the exponential reload backoff (AC-6): if reloads aren't
/// helping (e.g. the renderer OOMs again immediately), the watchdog settles to
/// at most one attempt per this window rather than a tight loop.
pub const RELOAD_BACKOFF_CAP_MS: u64 = 900_000; // 15 min

/// RF-perf-7 (AC-1): renderer WebContent RSS at/above which the watchdog
/// pre-emptively reloads to reclaim the accumulated heap **before** the OS
/// OOM-kills the renderer (a hard, user-visible blank). MEASURED, not guessed —
/// RF-perf-5's AC-5 ranking captured live on 2026-08-01 put steady heavy-use
/// renderer RSS at ~3.5 GB and creeping, with historical OOM blanks landing at
/// 9–13 GB. 6 GiB sits ~1.7× above observed steady (so it never fires in normal
/// use) and ~0.5× the OOM floor (so it fires with hours of headroom for a clean
/// reload). Single tunable knob — raise it if a live session shows a false trip.
pub const RENDERER_PRESSURE_BYTES: u64 = 6 * 1024 * 1024 * 1024;

/// RF-perf-7 (AC-1): consecutive over-threshold memory samples (each ~60 s — the
/// every-4th-tick cadence) required before a pressure reload fires. ~3 min
/// sustained over the ceiling, so a transient allocation spike can never trip a
/// user-visible reload (R1 — thrash is the cardinal sin).
pub const RENDERER_PRESSURE_MIN_SAMPLES: u32 = 3;

/// RF-perf-7 (AC-2): consecutive *beats* a **visible** renderer may report a
/// frozen paint tick before it is treated as render-stalled (JS-alive but not
/// painting — the blank-but-alive blind spot). 2 beats ≈ 60 s: long enough that
/// a single legitimately long synchronous task / GC pause between beats doesn't
/// flap the signal, short enough to beat the 90 s ack-stale window.
pub const RENDER_STALL_BEATS: u32 = 2;

/// Consecutive beats a visible renderer may report an empty app root before the
/// watchdog logs a blank window. Log only: the cause of an alive-but-blank window
/// is not known yet, so the line exists to make the next one diagnosable.
pub const BLANK_ROOT_BEATS: u32 = 2;

/// Reloads in a row a satellite gets before the watchdog gives up on it. Each is followed by
/// `renderer_recovery::RECOVERY_TIMEOUT` for a heartbeat from that window.
pub const SATELLITE_MAX_RELOADS: u32 = 2;

/// How long the Mac slept between two watchdog ticks. The wall clock keeps
/// counting through sleep; the monotonic clock the ticks run on does not (on
/// macOS `Instant` is `CLOCK_UPTIME_RAW`). A wall clock that outran it by more
/// than one tick means the renderer was asleep, not dead, for that long.
/// `None` for an ordinary tick or a wall clock that stepped backwards.
pub fn slept_ms(wall_elapsed_ms: u64, mono_elapsed_ms: u64) -> Option<u64> {
    let gap = wall_elapsed_ms.saturating_sub(mono_elapsed_ms);
    (gap > WATCHDOG_TICK_MS).then_some(gap)
}

/// Shared renderer-liveness state: the wall-clock ms of the most recent
/// frontend ack. Managed by Tauri; written by the `renderer_heartbeat` command
/// and read by the watchdog task. `AtomicU64` because it's a single value
/// touched from two async contexts with no other invariant.
#[derive(Debug)]
pub struct RendererLiveness {
    last_ack_ms: AtomicU64,
    /// RF-perf-5 (AC-2): the most recent FE `performance.memory.usedJSHeapSize`
    /// pushed on the heartbeat, or 0 when the engine gates `performance.memory`
    /// (WebKit historically does) — the gated memory line reads this beside the
    /// renderer RSS to derive the non-JS gap. A single value touched from two
    /// async contexts, no other invariant → `AtomicU64`, like `last_ack_ms`.
    last_heap_bytes: AtomicU64,
    /// RF-perf-5 (AC-4): cumulative FE `window.unhandledrejection` count pushed on
    /// the heartbeat — the 21:27 incident had a 7-in-one-second burst as the JS
    /// context tore down, so surfacing this in the periodic line makes that signal
    /// visible instead of buried in per-error lines.
    unhandled_rejections: AtomicU64,
    /// RF-perf-5 (AC-4): wall-clock ms of the most recent watchdog-driven reload,
    /// or 0 if none this session. Read when a fresh renderer announces itself
    /// (`init`) to tag the re-init breadcrumb's cause (watchdog vs external).
    last_reload_ms: AtomicU64,
    /// RF-perf-5 (AC-4): how many times a fresh renderer instance has announced
    /// itself (`init`) this session — distinguishes first-boot (0) from a later
    /// external re-init (>0) when no watchdog reload preceded it.
    init_count: AtomicU64,
    /// RF-perf-7 (AC-2): the FE paint tick — a monotonic counter a
    /// `requestAnimationFrame` probe bumps once per beat while the renderer is
    /// actually painting. A wedged / CPU-pegged renderer stops advancing it while
    /// JS still acks, so a value that stays frozen across beats (while visible) is
    /// the blank-but-alive signal `decide()` acts on. `0` = never reported yet
    /// (the loop treats that as "no paint proof", never as a stall).
    last_render_tick: AtomicU64,
    /// RF-perf-7 (AC-2): whether the FE reported `document.visibilityState ==
    /// "visible"` on its most recent beat. A hidden / occluded window pauses rAF
    /// (the paint tick legitimately freezes), so render-stall is asserted **only
    /// while visible** — the R2 guard against an idle/backgrounded false reload.
    render_visible: AtomicBool,
    /// Whether the FE reported an empty app root (`#root` with no children) on its
    /// most recent beat: JS runs but nothing is mounted. Read for the blank-window
    /// log line only.
    root_empty: AtomicBool,
    /// RF-perf-4 (AC-1): the most recent FE per-resource instance counts pushed on the
    /// heartbeat, or `None` until the first beat carries them. A `Mutex` (not atomics)
    /// because it's a 5-field struct updated atomically as a unit; both the write (the
    /// ack) and the read (the gated memory line) use `try_lock`-or-skip so neither can
    /// ever block the infallible ack — a dropped update is harmless (the next 30 s beat
    /// re-reports the current tally).
    instance_counts: Mutex<Option<FeInstanceCounts>>,
}

impl Default for RendererLiveness {
    fn default() -> Self {
        // Seed to 0; `start_renderer_watchdog` re-seeds to `now` at spawn so the
        // startup grace window (before the first FE ack) never trips the reload.
        Self {
            last_ack_ms: AtomicU64::new(0),
            last_heap_bytes: AtomicU64::new(0),
            unhandled_rejections: AtomicU64::new(0),
            last_reload_ms: AtomicU64::new(0),
            init_count: AtomicU64::new(0),
            last_render_tick: AtomicU64::new(0),
            // Default visible: absence of a report must never *fabricate* a stall.
            // Combined with the `last_render_tick == 0` guard, a renderer that
            // never reports a paint tick is treated as "no proof", not "stalled".
            render_visible: AtomicBool::new(true),
            root_empty: AtomicBool::new(false),
            // None until the first beat carries counts — the memory line renders
            // `skip`, never a fake 0 that would read as "no editors/teams open".
            instance_counts: Mutex::new(None),
        }
    }
}

impl RendererLiveness {
    /// Record a liveness ack at `now_ms`. Called by the `renderer_heartbeat`
    /// command and once at watchdog start to seed the grace window.
    pub fn beat(&self, now_ms: u64) {
        self.last_ack_ms.store(now_ms, Ordering::Relaxed);
    }

    /// Wall-clock ms of the most recent ack (0 if never acked).
    pub fn last_ack_ms(&self) -> u64 {
        self.last_ack_ms.load(Ordering::Relaxed)
    }

    /// RF-perf-5 (AC-2): store the FE JS-heap reading from a heartbeat. Only
    /// called with a present value — an absent `performance.memory` leaves the
    /// prior reading untouched rather than clobbering it to 0.
    pub fn store_heap_bytes(&self, bytes: u64) {
        self.last_heap_bytes.store(bytes, Ordering::Relaxed);
    }

    /// RF-perf-5 (AC-2): the most recent FE JS-heap reading (0 if never reported /
    /// engine-gated → logged as `unavailable`).
    pub fn last_heap_bytes(&self) -> u64 {
        self.last_heap_bytes.load(Ordering::Relaxed)
    }

    /// RF-perf-5 (AC-4): store the FE's cumulative unhandled-rejection count.
    pub fn store_unhandled_rejections(&self, n: u64) {
        self.unhandled_rejections.store(n, Ordering::Relaxed);
    }

    /// RF-perf-5 (AC-4): the most recent FE unhandled-rejection count.
    pub fn unhandled_rejections(&self) -> u64 {
        self.unhandled_rejections.load(Ordering::Relaxed)
    }

    /// RF-perf-5 (AC-4): record a watchdog-driven reload's wall-clock ms so a
    /// following renderer `init` can attribute its re-init to the watchdog.
    pub fn mark_reload(&self, now_ms: u64) {
        self.last_reload_ms.store(now_ms, Ordering::Relaxed);
    }

    /// RF-perf-5 (AC-4): a fresh renderer instance has announced itself. Returns
    /// the cause tag for the re-init breadcrumb: `watchdog-reload` if a watchdog
    /// reload landed within the last stale window, else `first-boot` for the very
    /// first instance, else `external` (an OOM-recovery / manual reload the
    /// watchdog did not drive — exactly the 21:27 ambiguity this resolves).
    pub fn note_init(&self, now_ms: u64) -> &'static str {
        let prior_inits = self.init_count.fetch_add(1, Ordering::Relaxed);
        // `swap(0)` CONSUMES the reload timestamp so ONE watchdog reload attributes
        // exactly the ONE init that follows it. Without consuming, a later genuine
        // *external* re-init that happened to fall within `RENDERER_STALE_AFTER_MS`
        // of the same old reload would also read `watchdog-reload` — the opposite of
        // the external/OOM disambiguation this breadcrumb exists for.
        let last_reload = self.last_reload_ms.swap(0, Ordering::Relaxed);
        if last_reload != 0 && now_ms.saturating_sub(last_reload) <= RENDERER_STALE_AFTER_MS {
            "watchdog-reload"
        } else if prior_inits == 0 {
            "first-boot"
        } else {
            "external"
        }
    }

    /// RF-perf-7 (AC-2): store the FE paint tick from a heartbeat. Only called
    /// with a present value — an absent tick leaves the prior reading untouched
    /// (a fresh renderer that hasn't wired the probe yet must not read as frozen).
    pub fn store_render_tick(&self, tick: u64) {
        self.last_render_tick.store(tick, Ordering::Relaxed);
    }

    /// RF-perf-7 (AC-2): the most recent FE paint tick (0 → never reported).
    pub fn last_render_tick(&self) -> u64 {
        self.last_render_tick.load(Ordering::Relaxed)
    }

    /// RF-perf-7 (AC-2): store whether the FE reported the document visible.
    pub fn store_render_visible(&self, visible: bool) {
        self.render_visible.store(visible, Ordering::Relaxed);
    }

    /// RF-perf-7 (AC-2): whether the renderer was visible on its last beat.
    pub fn render_visible(&self) -> bool {
        self.render_visible.load(Ordering::Relaxed)
    }

    /// Store whether the FE reported an empty app root.
    pub fn store_root_empty(&self, empty: bool) {
        self.root_empty.store(empty, Ordering::Relaxed);
    }

    /// Whether the app root was empty on the renderer's last beat.
    pub fn root_empty(&self) -> bool {
        self.root_empty.load(Ordering::Relaxed)
    }

    /// RF-perf-4 (AC-1): store the latest FE per-resource instance counts.
    /// `try_lock`-or-skip so the infallible ack never blocks; a skipped update is
    /// re-sent on the next 30 s beat, so a momentary miss costs nothing.
    pub fn store_instance_counts(&self, counts: FeInstanceCounts) {
        if let Ok(mut slot) = self.instance_counts.try_lock() {
            *slot = Some(counts);
        }
    }

    /// RF-perf-4 (AC-1): the most recent FE instance counts, or `None` when never
    /// reported yet or momentarily contended — the gated memory line renders `skip`
    /// for `None`, never a fake 0 that would misread as "nothing mounted".
    pub fn instance_counts(&self) -> Option<FeInstanceCounts> {
        self.instance_counts.try_lock().ok().and_then(|slot| *slot)
    }
}

/// Every watched window's [`RendererLiveness`], by label. Tauri managed state: the heartbeat
/// writes the calling window's entry and the watchdog reads it, dropping it when the window
/// leaves the registry.
#[derive(Debug, Default)]
pub struct WindowLiveness {
    by_label: Mutex<HashMap<String, Arc<RendererLiveness>>>,
}

impl WindowLiveness {
    fn labels_locked(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<RendererLiveness>>> {
        self.by_label.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `label`'s entry, created on first use.
    pub fn liveness_of(&self, label: &str) -> Arc<RendererLiveness> {
        let mut labels = WindowLiveness::labels_locked(self);
        Arc::clone(
            HashMap::entry(&mut *labels, label.to_owned())
                .or_insert_with(|| Arc::new(<RendererLiveness as Default>::default())),
        )
    }

    /// `label`'s entry if it has one.
    pub fn window_liveness(&self, label: &str) -> Option<Arc<RendererLiveness>> {
        WindowLiveness::labels_locked(self).get(label).cloned()
    }

    /// Drops the entry of every label `registered` does not name.
    pub fn retain_registered(&self, registered: &[(String, bool)]) {
        HashMap::retain(&mut *WindowLiveness::labels_locked(self), |label, _| {
            Iterator::any(&mut registered.iter(), |(l, _)| l == label)
        });
    }

    /// Drops `label`'s entry: the window is gone.
    pub fn forget_liveness(&self, label: &str) {
        WindowLiveness::labels_locked(self).remove(label);
    }
}

/// AC-1: the frontend liveness ack. A tiny, infallible signal — the renderer
/// proving it can still run JS and reach IPC. Bumps the last-ack timestamp the
/// watchdog reads. Deliberately returns nothing and never errors: the FE calls
/// it fire-and-forget on an interval.
///
/// RF-perf-5 (AC-2/AC-4): the beat now optionally carries the FE
/// `performance.memory.usedJSHeapSize` (`heap_bytes`), the cumulative
/// `unhandled_rejections` count, and — on the first beat of a fresh renderer
/// instance — `init: true`, which logs a cause-tagged re-init breadcrumb so an
/// external/OOM-recovery reload is no longer silent (the 21:27 ambiguity).
///
/// RF-perf-7 (AC-2): it also carries a `render_tick` (a `requestAnimationFrame`
/// paint counter — frozen while a wedged tree is blank) and `visible`
/// (`document.visibilityState`), so the watchdog can tell a JS-alive-but-blank
/// renderer from a healthy or legitimately-hidden one.
///
/// RF-perf-4 (AC-1): it also carries `instance_counts` — the per-resource FE tally
/// (editors/iframes/WebGL-terminals/mounted-teams) the gated memory line
/// surfaces beside the RSS to attribute the renderer footprint per resource class.
///
/// It also carries `root_empty` (the app root has no children), which the
/// watchdog logs as a blank window; it never reloads on it.
///
/// It stays a one-way, infallible ack: every added field is optional and none can
/// block the liveness store (a read that could break the ack would ironically
/// trip the watchdog). Adding args to an existing command does not change the
/// command-count contract.
///
/// The beat is the calling window's: it lands in that label's entry of [`WindowLiveness`].
/// A label that is neither `main` nor registered is dropped.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn renderer_heartbeat(
    webview: tauri::Webview,
    windows: tauri::State<'_, WindowLiveness>,
    registry: tauri::State<'_, WindowRegistry>,
    heap_bytes: Option<u64>,
    unhandled_rejections: Option<u64>,
    init: Option<bool>,
    render_tick: Option<u64>,
    visible: Option<bool>,
    instance_counts: Option<FeInstanceCounts>,
    root_empty: Option<bool>,
) {
    let label = webview.label();
    if !is_main(label) && !Locked::has_window(&WindowRegistry::locked(&registry), label) {
        return;
    }
    let state: Arc<RendererLiveness> = WindowLiveness::liveness_of(&windows, label);
    let state: &RendererLiveness = &state;
    let now = now_ms();
    state.beat(now);
    if let Some(bytes) = heap_bytes {
        state.store_heap_bytes(bytes);
    }
    if let Some(n) = unhandled_rejections {
        state.store_unhandled_rejections(n);
    }
    if let Some(tick) = render_tick {
        state.store_render_tick(tick);
    }
    if let Some(v) = visible {
        state.store_render_visible(v);
    }
    if let Some(counts) = instance_counts {
        state.store_instance_counts(counts);
    }
    if let Some(empty) = root_empty {
        state.store_root_empty(empty);
    }
    if init == Some(true) {
        let cause = state.note_init(now);
        log::info!(
            target: "webview-watchdog",
            "renderer {label} initialized (cause={cause})"
        );
        // SR-0 (Q4): the post-reload seam. Only for a `watchdog-reload` init (the
        // reload we captured `pre_*` for) and only when the memory gate is on, so
        // an ordinary boot/external re-init never scans. The soak script pairs
        // this with the `reload cause=…` line to report same-PID? + RSS delta.
        if cause == "watchdog-reload" && crate::memory_metrics::memory_enabled() {
            let (post_rss, post_pids) = crate::memory_metrics::renderer_webcontent_snapshot();
            log::debug!(
                target: "memory",
                "reload settled cause={cause} post_pids={post_pids:?} post_rss={post_rss}"
            );
        }
    }
}

/// Why the watchdog is reloading — the AC-4 forensic cause tag carried by
/// [`WatchdogAction::Reload`]. The two **liveness** triggers (process death and
/// render stall) share **one** anti-thrash backoff budget (AC-5) — the cause only
/// distinguishes the log line, never a second recovery path. SR-10: memory pressure
/// is NO LONGER a reload cause — a `win.reload()` reclaims zero native renderer
/// memory (proven ×3), so pressure is surfaced as
/// [`WatchdogAction::MemoryPressureObserved`] (log-only) instead of a destructive,
/// useless reload that blanks the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReloadCause {
    /// SW-FX-64: the renderer stopped acking — WebContent process death.
    ProcessDeath,
    /// RF-perf-7 (AC-2): the heartbeat still acks (the JS timer loop runs) but the
    /// paint tick is frozen while visible — a **paint/compositor-pipeline** stall.
    /// Note the reachable slice: a full JS main-thread peg freezes the `setInterval`
    /// ack too, so that surfaces as `ProcessDeath` (ack stale), not here; and an
    /// idle-but-healthy tree keeps advancing the tick (the probe is scheduled each
    /// beat), so it is not flagged. RenderStall is the narrow, faster (< the 90 s
    /// ack window) signal for "timers alive, paint dead" that the ack-only watchdog
    /// cannot see at all.
    RenderStall,
}

impl ReloadCause {
    /// The `cause=` token logged for this reload (AC-4 — an incident is
    /// diagnosable from the log alone).
    pub fn as_str(self) -> &'static str {
        match self {
            ReloadCause::ProcessDeath => "process_death",
            ReloadCause::RenderStall => "render_stall",
        }
    }
}

/// What the watchdog should do this tick. Pure output of [`decide`] so the
/// stale/backoff logic is unit-testable without a webview or a clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogAction {
    /// Renderer acked within the stale window and is painting — healthy. SR-10:
    /// being over the memory ceiling while alive is NO LONGER `Healthy`; it is the
    /// distinct [`MemoryPressureObserved`](WatchdogAction::MemoryPressureObserved)
    /// state (both are "liveness OK", so both clear a reload backoff).
    Healthy,
    /// Renderer is unhealthy (process-dead / render-stalled) and no backoff is in
    /// effect — reload the webview, logging the cause. (Liveness only — SR-10
    /// removed memory pressure from this set.)
    Reload(ReloadCause),
    /// SR-10 (AC-1): JS is alive and painting, but renderer RSS is sustained over
    /// the pressure ceiling. A `win.reload()` reclaims ZERO native renderer memory
    /// (proven ×3) and blanks the screen, so pressure NO LONGER reloads — it is
    /// logged for observability and left for the real reclaim path (leak fix /
    /// non-disruptive release) to own. Takes no disruptive action, so it is not
    /// backoff-gated (there is nothing to thrash).
    MemoryPressureObserved,
    /// Renderer is unhealthy but a recent reload's backoff window hasn't elapsed —
    /// wait rather than reload again (AC-6). One budget bounds every cause (AC-5).
    BackoffWait,
}

/// Exponential-with-cap backoff window for the Nth consecutive reload (AC-6).
/// `consecutive_reloads == 0` → no backoff (the first stale detection acts
/// immediately). Each subsequent reload doubles the window up to the cap.
pub fn backoff_window_ms(consecutive_reloads: u32) -> u64 {
    if consecutive_reloads == 0 {
        return 0;
    }
    // Shift by (n-1), clamped so the shift can't overflow before the .min cap.
    let shift = (consecutive_reloads - 1).min(16);
    RELOAD_BACKOFF_BASE_MS
        .saturating_mul(1u64 << shift)
        .min(RELOAD_BACKOFF_CAP_MS)
}

/// Pure watchdog decision. `last_reload_ms` is the time of the most recent
/// reload (if any) and `reload_backoff_ms` the current backoff window for the
/// next reload (from [`backoff_window_ms`]).
///
/// RF-perf-7 extends the liveness decision to a *health* decision without forking
/// it: two already-reduced booleans are threaded in — `pressure_over` (renderer
/// RSS ≥ threshold for ≥ K samples) and `render_stalled` (visible but paint tick
/// frozen for ≥ K beats). The loop owns that reduction (like `consecutive_reloads`);
/// `decide` stays pure and table-testable. Precedence: a stale ack means the JS
/// context is gone, so it is *process death* regardless of the other signals (they
/// can only be trusted while JS is acking); else a visible frozen paint tick is a
/// *render stall*. Both are LIVENESS reloads funnelling through the **one** backoff
/// gate (AC-5). SR-10 (AC-1): `pressure_over` — while JS is alive and painting — is
/// NO LONGER a reload; it yields [`WatchdogAction::MemoryPressureObserved`]
/// (log-only, not backoff-gated), because a reload reclaims no renderer memory.
pub fn decide(
    now_ms: u64,
    last_ack_ms: u64,
    stale_after_ms: u64,
    last_reload_ms: Option<u64>,
    reload_backoff_ms: u64,
    pressure_over: bool,
    render_stalled: bool,
) -> WatchdogAction {
    // `saturating_sub` guards a clock that went backwards (treated as fresh, not a
    // spurious reload) — the JS context is alive iff it acked within the window.
    let js_alive = now_ms.saturating_sub(last_ack_ms) <= stale_after_ms;

    // Only the LIVENESS causes reload (SR-10: memory pressure no longer does — a
    // reload reclaims nothing). A stale ack means the JS context is gone → process
    // death; else a visible frozen paint tick → render stall. A liveness reload
    // takes precedence: on a tick that reloads, pressure is intentionally NOT
    // separately surfaced (the reload resets the pressure sample count anyway).
    let reload_cause = if !js_alive {
        Some(ReloadCause::ProcessDeath)
    } else if render_stalled {
        Some(ReloadCause::RenderStall)
    } else {
        None
    };

    match reload_cause {
        Some(cause) => {
            // Unhealthy, but within a prior reload's backoff → hold (AC-6). One
            // budget for both liveness causes (AC-5) — a renderer that dies then
            // render-stalls cannot escape the cap by switching failure modes.
            if let Some(reloaded) = last_reload_ms {
                if now_ms.saturating_sub(reloaded) < reload_backoff_ms {
                    return WatchdogAction::BackoffWait;
                }
            }
            WatchdogAction::Reload(cause)
        }
        // SR-10 (AC-1): JS alive + painting, but memory pressure sustained → observe
        // only, never reload. Not backoff-gated: it takes no disruptive action.
        None if pressure_over => WatchdogAction::MemoryPressureObserved,
        None => WatchdogAction::Healthy,
    }
}

/// RF-perf-7 (AC-1): fold a fresh memory sample into the consecutive
/// over-threshold count that drives `pressure_over`. `None` (unresolved) or an
/// under-threshold reading resets to 0 — pressure must be both *known* and
/// *sustained* to count (R1: a transient or unattributable spike must never trip
/// a user-visible reload). Pure so the loop's reduction is unit-testable.
fn accrue_pressure_samples(prev: u32, sample: Option<u64>, threshold_bytes: u64) -> u32 {
    match sample {
        Some(rss) if rss >= threshold_bytes => prev.saturating_add(1),
        _ => 0,
    }
}

/// RF-perf-7 (AC-2): fold one beat's paint signal into the consecutive
/// render-stall count that drives `render_stalled`. A stall beat is: **visible**
/// AND a **real** (non-zero) paint tick that **did not advance** since the prior
/// beat. Anything else resets to 0 — an advancing tick (healthy), a hidden window
/// (rAF legitimately paused, R2), or a `0` tick (probe never reported → no proof,
/// never a fabricated stall). Pure so the loop's reduction is unit-testable.
fn accrue_render_stall_beats(
    prev: u32,
    visible: bool,
    render_tick: u64,
    prev_render_tick: u64,
) -> u32 {
    if visible && render_tick != 0 && render_tick == prev_render_tick {
        prev.saturating_add(1)
    } else {
        0
    }
}

/// One watched window's loop state. `main`'s is what the loop held before there were
/// satellites; a satellite's also carries its reload ladder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowWatch {
    /// When watching began (startup for `main`, `pending` clearing for a satellite): counts
    /// as an ack, so a booting window gets a boot's grace.
    watched_since: u64,
    consecutive_reloads: u32,
    last_reload_ms: Option<u64>,
    /// RF-perf-7 (AC-2) render-stall reduction: consecutive *beats* whose paint tick did not
    /// advance while visible. `prev_ack` detects a NEW beat (ack advanced) so we count per
    /// beat, not per (finer) watchdog tick.
    render_stall_beats: u32,
    prev_ack: u64,
    prev_render_tick: u64,
    /// Blank-window capture: consecutive visible beats with an empty app root, and whether
    /// this episode was already logged.
    blank_beats: u32,
    blank_logged: bool,
    /// A satellite the watchdog gave up on whose removal the registry refused: every tick
    /// retries the give-up.
    giving_up: bool,
}

/// What one tick reads of one window.
#[derive(Debug, Clone, Copy, Default)]
pub struct WatchReading {
    pub now: u64,
    pub last_ack: u64,
    /// The wall-clock ms of the last wake from sleep, which counts as an ack.
    pub woke_at: u64,
    pub render_tick: u64,
    pub visible: bool,
    pub root_empty: bool,
    /// The app-wide memory pressure signal; only `main`'s step reads it.
    pub pressure_over: bool,
}

/// What the watchdog does for one window this tick: the output of [`watch_step`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchStep {
    /// Acking and painting. `cleared` is the length of the reload ladder this tick ended.
    Healthy {
        cleared: u32,
    },
    /// `main` only: alive and painting but over the memory ceiling (log only, SR-10).
    PressureObserved {
        cleared: u32,
    },
    /// Unhealthy, within `main`'s backoff or a satellite's heartbeat wait after a reload.
    Wait,
    Reload(ReloadCause),
    /// A satellite whose reloads brought no heartbeat: return its items and destroy it.
    GiveUp,
}

/// A watch that starts at `now`, from the window's current ack and paint tick.
pub fn watch_from(now: u64, last_ack: u64, render_tick: u64) -> WindowWatch {
    WindowWatch {
        watched_since: now,
        prev_ack: last_ack,
        prev_render_tick: render_tick,
        ..<WindowWatch as Default>::default()
    }
}

/// Folds a new beat (the ack advanced) into the render-stall and blank-root counts. Returns
/// the blank count on the beat a blank episode reaches [`BLANK_ROOT_BEATS`], once per episode.
pub fn fold_beat(watch: &mut WindowWatch, reading: &WatchReading) -> Option<u32> {
    if reading.last_ack == watch.prev_ack {
        return None;
    }
    // RF-perf-7 (AC-2): see `accrue_render_stall_beats` for the visible / non-zero /
    // did-not-advance rule (R2 guards baked in).
    watch.render_stall_beats = accrue_render_stall_beats(
        watch.render_stall_beats,
        reading.visible,
        reading.render_tick,
        watch.prev_render_tick,
    );
    watch.prev_render_tick = reading.render_tick;
    watch.prev_ack = reading.last_ack;
    watch.blank_beats = if reading.visible && reading.root_empty {
        watch.blank_beats.saturating_add(1)
    } else {
        0
    };
    if watch.blank_beats == 0 {
        watch.blank_logged = false;
    } else if watch.blank_beats >= BLANK_ROOT_BEATS && !watch.blank_logged {
        watch.blank_logged = true;
        return Some(watch.blank_beats);
    }
    None
}

/// The window slept: its paint tick legitimately froze.
pub fn note_sleep(watch: &mut WindowWatch) {
    watch.render_stall_beats = 0;
}

/// A reload of the window was posted at `now`.
pub fn record_reload(watch: &mut WindowWatch, now: u64) {
    watch.last_reload_ms = Some(now);
    watch.consecutive_reloads = watch.consecutive_reloads.saturating_add(1);
    // A reload resets the renderer: the stall count is moot until it re-proves itself.
    // `prev_ack` / `prev_render_tick` are deliberately NOT reset: the fresh renderer re-runs
    // its FE module (paint tick back to 0), and the `render_tick != 0` "no proof" guard in
    // `accrue_render_stall_beats` covers the boot window.
    watch.render_stall_beats = 0;
}

/// A satellite reload could not be posted, or its removal was refused: give up every tick
/// until the window is gone.
pub fn mark_giving_up(watch: &mut WindowWatch) {
    watch.giving_up = true;
}

fn clear_ladder(watch: &mut WindowWatch) -> u32 {
    let cleared = watch.consecutive_reloads;
    watch.consecutive_reloads = 0;
    watch.last_reload_ms = None;
    cleared
}

/// The pure per-window step: [`decide`] for `main`, with its backoff ladder and pressure
/// reading; for a satellite, `decide` plus the satellite ladder. After a satellite reload
/// (either cause) a heartbeat from that window ends the ladder; none within
/// `RECOVERY_TIMEOUT` is a failed reload, answered by the next reload or, after
/// [`SATELLITE_MAX_RELOADS`], by [`WatchStep::GiveUp`].
pub fn watch_step(label: &str, watch: &mut WindowWatch, reading: &WatchReading) -> WatchStep {
    let now = reading.now;
    let acked = reading
        .last_ack
        .max(reading.woke_at)
        .max(watch.watched_since);
    let render_stalled = watch.render_stall_beats >= RENDER_STALL_BEATS;
    if is_main(label) {
        let backoff = backoff_window_ms(watch.consecutive_reloads);
        let action = decide(
            now,
            acked,
            RENDERER_STALE_AFTER_MS,
            watch.last_reload_ms,
            backoff,
            reading.pressure_over,
            render_stalled,
        );
        // Liveness is OK in both Healthy and MemoryPressureObserved: memory pressure is not
        // a liveness failure (SR-10), so either clears a prior reload's backoff (AC-6). Only
        // a real ack clears it, not the grace after a sleep.
        let mut cleared = 0;
        if matches!(
            action,
            WatchdogAction::Healthy | WatchdogAction::MemoryPressureObserved
        ) && watch.consecutive_reloads > 0
            && now.saturating_sub(reading.last_ack) <= RENDERER_STALE_AFTER_MS
        {
            cleared = clear_ladder(watch);
        }
        return match action {
            WatchdogAction::Healthy => WatchStep::Healthy { cleared },
            WatchdogAction::MemoryPressureObserved => WatchStep::PressureObserved { cleared },
            WatchdogAction::BackoffWait => WatchStep::Wait,
            WatchdogAction::Reload(cause) => WatchStep::Reload(cause),
        };
    }
    if watch.giving_up {
        return WatchStep::GiveUp;
    }
    let mut cleared = 0;
    if let Some(reloaded) = watch.last_reload_ms {
        if reading.last_ack > reloaded {
            cleared = clear_ladder(watch);
        } else if now.saturating_sub(reloaded)
            < crate::renderer_recovery::RECOVERY_TIMEOUT.as_millis() as u64
        {
            return WatchStep::Wait;
        } else if watch.consecutive_reloads >= SATELLITE_MAX_RELOADS {
            return WatchStep::GiveUp;
        } else if now.saturating_sub(acked) > RENDERER_STALE_AFTER_MS {
            return WatchStep::Reload(ReloadCause::ProcessDeath);
        } else {
            return WatchStep::Reload(ReloadCause::RenderStall);
        }
    }
    match decide(
        now,
        acked,
        RENDERER_STALE_AFTER_MS,
        None,
        0,
        false,
        render_stalled,
    ) {
        WatchdogAction::Reload(cause) => WatchStep::Reload(cause),
        _ => WatchStep::Healthy { cleared },
    }
}

/// The watchdog's give-up on a satellite, in one registry transaction (the order `returns.rs`
/// gives a caller that drops a window): its items return to `main` as `crash`, its entry goes,
/// and once the lock is released the window is destroyed. A satellite holding nothing sends no
/// return. `main` is never given up on. `false` when the registry refuses the removal (the
/// window is already gone); nothing is destroyed and nothing is returned, and the watch is
/// dropped on the next tick with the window's registration.
pub fn give_up_satellite(host: &impl MoveHost, registry: &WindowRegistry, label: &str) -> bool {
    if is_main(label) {
        return false;
    }
    let removed = {
        let mut locked = WindowRegistry::locked(registry);
        let items = Locked::items_held_by(&locked, label);
        if !<[ItemKey]>::is_empty(&items) {
            return_by_kind_locked(host, &mut locked, &items, ReturnReason::Crash);
        }
        Locked::remove_empty_satellite(&mut locked, label)
    };
    if let Err(e) = removed {
        log::warn!(target: "webview-watchdog", "satellite {label} not removed: {e}");
        return false;
    }
    MoveHost::destroy_window(host, label);
    true
}

/// Keeps one watch per registered, non-pending window: a window whose `pending` cleared gets a
/// watch starting `now` (its boot's grace, from `reading_of`'s ack and paint tick), and a
/// pending or unregistered window has none.
pub fn sync_watches(
    watches: &mut BTreeMap<String, WindowWatch>,
    windows: &[(String, bool)],
    now: u64,
    reading_of: &dyn Fn(&str) -> (u64, u64),
) {
    BTreeMap::retain(watches, |label, _| {
        Iterator::any(&mut windows.iter(), |(l, pending)| l == label && !pending)
    });
    for (label, pending) in windows {
        if !*pending && !BTreeMap::contains_key(watches, label) {
            let (last_ack, render_tick) = reading_of(label);
            BTreeMap::insert(
                watches,
                label.clone(),
                watch_from(now, last_ack, render_tick),
            );
        }
    }
}

/// Start the renderer-liveness watchdog. Seeds `main`'s ack to `now` (startup grace),
/// then ticks every [`WATCHDOG_TICK_MS`] for the life of the process, stepping every
/// registered, non-pending window ([`watch_step`]). Called once from Tauri `setup()`.
pub fn start_renderer_watchdog(app: tauri::AppHandle) {
    // Grace: pretend the renderer just acked so the window between app start and
    // the first FE beat can't trip a reload.
    let started = now_ms();
    let main_liveness = WindowLiveness::liveness_of(&app.state::<WindowLiveness>(), MAIN_LABEL);
    RendererLiveness::beat(&main_liveness, started);

    #[cfg(debug_assertions)]
    debug_wedge_renderer(app.clone());

    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(WATCHDOG_TICK_MS));
        let mut watches: BTreeMap<String, WindowWatch> = BTreeMap::new();
        BTreeMap::insert(
            &mut watches,
            MAIN_LABEL.to_owned(),
            watch_from(
                started,
                RendererLiveness::last_ack_ms(&main_liveness),
                RendererLiveness::last_render_tick(&main_liveness),
            ),
        );
        let mut tick: u64 = 0;
        // RF-perf-7 (AC-1) pressure reduction: consecutive over-threshold memory
        // samples; `pressure_over` once it reaches the K-sample floor. One app-wide reading.
        let mut pressure_samples: u32 = 0;
        // SR-10 (AC-1): rising-edge guard so the "over ceiling, not reloading" warn
        // logs once per pressure episode, not every tick. Cleared when the episode
        // ends (`!pressure_over`), independent of what action the tick took.
        let mut pressure_logged = false;
        // SR-10 (AC-1): the most recent resolved WebContent RSS (`None` = unresolved),
        // so the observed-pressure warn can carry the ACTUAL bytes — the value the
        // leak investigation cares about — not just the fixed ceiling.
        let mut last_sample_rss: Option<u64> = None;
        // Sleep detection: the previous tick's wall and monotonic clocks, and the
        // wall-clock ms of the last wake, which counts as an ack for `decide`.
        let mut prev_wall = now_ms();
        let mut prev_mono = std::time::Instant::now();
        let mut woke_at: u64 = 0;

        loop {
            interval.tick().await;

            tick = tick.wrapping_add(1);

            let now = now_ms();
            let mono = std::time::Instant::now();
            let slept = slept_ms(
                now.saturating_sub(prev_wall),
                mono.duration_since(prev_mono).as_millis() as u64,
            );
            prev_wall = now;
            prev_mono = mono;
            if let Some(gap) = slept {
                // A renderer cannot ack while the Mac sleeps: give it a fresh
                // grace window, as at startup, instead of reloading a live window.
                woke_at = now;
                for watch in watches.values_mut() {
                    note_sleep(watch);
                }
                log::info!(
                    target: "webview-watchdog",
                    "Mac was asleep for {}s; renderers get a fresh grace period",
                    gap / 1000
                );
            }

            // RF-perf-7 (AC-1, decision #2): every 4th tick (~60 s) take ONE
            // process-table snapshot on this watchdog thread (off the UI/render
            // thread) and read the renderer WebContent RSS. `sample` runs the scan
            // UNGATED — it is the production pressure signal (FE heap is engine-gated
            // to `unavailable` on WebKit) — while the verbose forensic line it also
            // emits stays behind `memory_enabled()`, reusing the same snapshot.
            // `None` = unresolved: never counted as pressure (a reload on an unknown
            // sample would be a guess, violating "measured, not guessed").
            if tick.is_multiple_of(4) {
                let sample = crate::memory_metrics::sample(&app);
                last_sample_rss = sample;
                pressure_samples =
                    accrue_pressure_samples(pressure_samples, sample, RENDERER_PRESSURE_BYTES);
            }
            let pressure_over = pressure_samples >= RENDERER_PRESSURE_MIN_SAMPLES;
            // SR-10 (AC-1): the pressure episode ended → re-arm the once-per-episode
            // warn. Tied to the pressure signal itself, not to any one action, so a
            // liveness reload/backoff in the middle of an episode can't strand the flag.
            if !pressure_over {
                pressure_logged = false;
            }

            // The windows to watch: `main` and every registered window that is not pending.
            let windows: Vec<(String, bool)> = {
                let registry = app.state::<WindowRegistry>();
                let locked = WindowRegistry::locked(&registry);
                Iterator::collect(Locked::window_labels(&locked).into_iter().map(|label| {
                    let pending = Locked::is_pending(&locked, &label);
                    (label, pending)
                }))
            };
            let liveness_map = app.state::<WindowLiveness>();
            let reading_of = |label: &str| {
                let liveness = WindowLiveness::liveness_of(&liveness_map, label);
                (
                    RendererLiveness::last_ack_ms(&liveness),
                    RendererLiveness::last_render_tick(&liveness),
                )
            };
            sync_watches(&mut watches, &windows, now, &reading_of);
            WindowLiveness::retain_registered(&liveness_map, &windows);

            let labels: Vec<String> = Iterator::collect(watches.keys().cloned());
            for label in labels {
                let liveness = WindowLiveness::liveness_of(&liveness_map, &label);
                let last_ack = RendererLiveness::last_ack_ms(&liveness);
                let reading = WatchReading {
                    now,
                    last_ack,
                    woke_at,
                    render_tick: RendererLiveness::last_render_tick(&liveness),
                    visible: RendererLiveness::render_visible(&liveness),
                    root_empty: RendererLiveness::root_empty(&liveness),
                    pressure_over,
                };
                let Some(watch) = watches.get_mut(&label) else {
                    continue;
                };
                if let Some(blank_beats) = fold_beat(watch, &reading) {
                    let rss =
                        last_sample_rss.map_or_else(|| "unresolved".to_string(), |b| b.to_string());
                    log::warn!(
                        target: "webview-watchdog",
                        "renderer {label} visible and acking but the app root is empty for {blank_beats} beats (blank window); paint tick {}, renderer RSS {rss}, runtime stalled {} — not reloading",
                        reading.render_tick,
                        crate::runtime_diagnostics::runtime_stalled()
                    );
                }
                let render_stall_beats = watch.render_stall_beats;
                let mut give_up = false;
                let step = watch_step(&label, watch, &reading);
                match step {
                    WatchStep::Healthy { cleared } | WatchStep::PressureObserved { cleared }
                        if cleared > 0 =>
                    {
                        log::info!(
                            target: "webview-watchdog",
                            "renderer {label} acks resumed — clearing reload backoff after {cleared} reload(s)"
                        );
                    }
                    WatchStep::Healthy { .. } | WatchStep::PressureObserved { .. } => {}
                    WatchStep::Wait => {
                        // Keep the ack age in the line so a suppressed event is still
                        // reconstructable (ack age > stale window ⇒ process-death).
                        log::warn!(
                            target: "webview-watchdog",
                            "renderer {label} unhealthy but within reload backoff or its heartbeat wait (last ack {}ms ago) — waiting",
                            now.saturating_sub(last_ack)
                        );
                    }
                    WatchStep::Reload(cause) => {
                        // AC-3/AC-4: a distinct, cause-tagged WARN line so every reload
                        // class (process-death / render-stall) is observable and
                        // attributable from the log alone. Logged Rust-side because for
                        // process-death the renderer that would otherwise log it is the
                        // thing that's dead.
                        let detail = match cause {
                            ReloadCause::ProcessDeath => {
                                format!("no ack for {}ms", now.saturating_sub(last_ack))
                            }
                            ReloadCause::RenderStall => format!(
                                "paint tick frozen for {render_stall_beats} beats while visible"
                            ),
                        };
                        log::warn!(
                            target: "webview-watchdog",
                            "renderer {label} unhealthy — reloading webview (cause={}, {detail})",
                            cause.as_str()
                        );
                        let dispatched =
                            crate::renderer_recovery::reload(app.clone(), &label, cause).await;
                        // AC-6: only engage the backoff once a reload actually
                        // dispatched. For `main`, a missing window or a failed `reload()`
                        // never attempted recovery — retry on the next tick rather than
                        // backing off. A satellite whose reload cannot be posted is
                        // given up on.
                        if dispatched {
                            record_reload(watch, now);
                            // RF-perf-5 (AC-4): record the reload so the renderer's
                            // post-reload `init` breadcrumb attributes its cause to the
                            // watchdog rather than reading as an external re-init.
                            RendererLiveness::mark_reload(&liveness, now);
                            if is_main(&label) {
                                pressure_samples = 0;
                            }
                        } else if !is_main(&label) {
                            give_up = true;
                        }
                    }
                    WatchStep::GiveUp => give_up = true,
                }
                // SR-10 (AC-1): `main` is over the memory ceiling, but a `win.reload()`
                // reclaims ZERO native renderer memory (proven ×3) and blanks the screen, so
                // it never reloads for it. Log once per pressure episode (rising edge), with
                // the ACTUAL sampled RSS.
                if matches!(step, WatchStep::PressureObserved { .. }) && !pressure_logged {
                    pressure_logged = true;
                    let rss =
                        last_sample_rss.map_or_else(|| "unresolved".to_string(), |b| b.to_string());
                    log::warn!(
                        target: "webview-watchdog",
                        "renderer over memory ceiling (RSS {rss} ≥ ceiling {RENDERER_PRESSURE_BYTES} bytes, {pressure_samples} samples) — NOT reloading (a reload reclaims no renderer memory)"
                    );
                }
                if give_up {
                    mark_giving_up(watch);
                    log::warn!(
                        target: "webview-watchdog",
                        "renderer {label} did not recover after {} reload(s) — returning its items to main and closing it",
                        watch.consecutive_reloads
                    );
                    let registry = app.state::<WindowRegistry>();
                    if give_up_satellite(&app, &registry, &label) {
                        BTreeMap::remove(&mut watches, &label);
                        WindowLiveness::forget_liveness(&liveness_map, &label);
                    }
                }
            }
        }
    });
}

// Architecture: fault injection is compiled out of release builds. The one-shot
// delay leaves time to record the app PID and probe its isolated transports.
#[cfg(debug_assertions)]
fn debug_wedge_renderer(app: tauri::AppHandle) {
    let Some(delay_ms) = std::env::var("CODESENSE_DEBUG_RENDERER_WEDGE_AFTER_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return;
    };
    // Architecture: measure the repro process's inherited limit after exec.
    #[cfg(unix)]
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            log::warn!(target: "webview-watchdog", "debug repro RLIMIT_NOFILE: pid={} soft={} hard={}", std::process::id(), limit.rlim_cur, limit.rlim_max);
        }
    }
    log::warn!(target: "webview-watchdog", "debug renderer wedge armed: pid={} delay_ms={delay_ms}", std::process::id());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        if let Some(win) = app.get_webview_window(crate::windows::MAIN_LABEL) {
            log::warn!(target: "webview-watchdog", "debug renderer wedge dispatching JS busy loop");
            if let Err(e) = win.eval("setTimeout(() => { for (;;) {} }, 0)") {
                log::error!(target: "webview-watchdog", "debug renderer wedge failed: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Architecture: the scheduler stand-in stays test-only; native dispatch uses the bounded gateway.
    fn dispatch_reload(dispatch: impl FnOnce() -> Result<(), String>) -> bool {
        dispatch().is_ok()
    }

    #[test]
    fn unanswered_dispatch_and_roundtrips_on_shared_workers() {
        use std::sync::mpsc;
        use std::time::Duration;
        use tauri_plugin_log::fern;

        // Architecture: observe from an OS thread so a starved runtime cannot
        // also starve the test's deadline. Dropping release unblocks teardown.
        for (workers, wait_for_reply) in [(1, false), (1, true), (2, true)] {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(workers)
                .enable_all()
                .build()
                .unwrap();
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release, blocked) = mpsc::channel::<()>();
            let reload = runtime.spawn(async move {
                dispatch_reload(|| {
                    entered_tx.send(()).unwrap();
                    // Architecture: Tauri reload posts without waiting. Getter
                    // round trips additionally wait for the main-thread reply.
                    // The stand-in never replies in either case.
                    if wait_for_reply {
                        let _ = blocked.recv();
                    }
                    Ok(())
                })
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (completed_tx, completed_rx) = mpsc::channel();
            let probe = runtime.spawn(async move {
                let tools = crate::mcp::handler::CodesenseHandler::served_tool_router().list_all();
                assert!(tools.iter().any(|tool| tool.name == "list_sessions"));
                let hub = crate::live_hub::LiveHub::default();
                assert!(hub.snapshot("all", "sessions").is_ok());
                let bytes = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
                let sink = bytes.clone();
                let (_, logger) = fern::Dispatch::new()
                    .chain(fern::Output::call(move |record| {
                        use std::io::Write;
                        writeln!(sink.lock().unwrap(), "{}", record.args()).unwrap();
                    }))
                    .into_log();
                logger.log(
                    &log::Record::builder()
                        .args(format_args!("runtime log witness"))
                        .level(log::Level::Info)
                        .build(),
                );
                assert!(!bytes.lock().unwrap().is_empty());
                completed_tx.send(()).unwrap();
            });
            let starved = workers == 1 && wait_for_reply;
            let observed = completed_rx.recv_timeout(if starved {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(5)
            });
            drop(release);
            assert!(runtime.block_on(reload).unwrap());
            runtime.block_on(probe).unwrap();
            if starved {
                assert!(matches!(observed, Err(mpsc::RecvTimeoutError::Timeout)));
                completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            } else {
                observed.expect("posted reload or a spare worker permits other tasks");
            }
        }
    }

    /// The liveness-only (SW-FX-64) tests exercise the process-death path with the
    /// RF-perf-7 health signals held false — this thin wrapper keeps them readable
    /// and proves the extension is additive (their expectations are unchanged bar
    /// the cause tag on `Reload`).
    fn decide_liveness(
        now_ms: u64,
        last_ack_ms: u64,
        stale_after_ms: u64,
        last_reload_ms: Option<u64>,
        reload_backoff_ms: u64,
    ) -> WatchdogAction {
        decide(
            now_ms,
            last_ack_ms,
            stale_after_ms,
            last_reload_ms,
            reload_backoff_ms,
            false,
            false,
        )
    }

    #[test]
    fn fresh_ack_is_healthy() {
        // Acked 2s ago, 90s stale window → healthy.
        assert_eq!(
            decide_liveness(102_000, 100_000, RENDERER_STALE_AFTER_MS, None, 0),
            WatchdogAction::Healthy
        );
    }

    #[test]
    fn exactly_at_threshold_is_healthy() {
        // now - ack == stale_after → still healthy (boundary is inclusive).
        assert_eq!(
            decide_liveness(190_000, 100_000, RENDERER_STALE_AFTER_MS, None, 0),
            WatchdogAction::Healthy
        );
    }

    #[test]
    fn stale_with_no_prior_reload_reloads() {
        // Acked 100s ago (> 90s) and never reloaded → reload immediately, tagged
        // process-death (the JS context is gone).
        assert_eq!(
            decide_liveness(200_000, 100_000, RENDERER_STALE_AFTER_MS, None, 0),
            WatchdogAction::Reload(ReloadCause::ProcessDeath)
        );
    }

    #[test]
    fn stale_within_backoff_waits() {
        // Stale, reloaded 30s ago, backoff window 60s → still waiting.
        assert_eq!(
            decide_liveness(
                230_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                Some(200_000),
                RELOAD_BACKOFF_BASE_MS
            ),
            WatchdogAction::BackoffWait
        );
    }

    #[test]
    fn stale_after_backoff_elapsed_reloads_again() {
        // Stale, reloaded 61s ago, backoff window 60s → backoff elapsed, reload.
        assert_eq!(
            decide_liveness(
                261_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                Some(200_000),
                RELOAD_BACKOFF_BASE_MS
            ),
            WatchdogAction::Reload(ReloadCause::ProcessDeath)
        );
    }

    #[test]
    fn recovered_ack_is_healthy_even_after_reload() {
        // A fresh ack (2s ago) reads healthy regardless of a prior reload — the
        // loop uses this to reset the backoff.
        assert_eq!(
            decide_liveness(
                202_000,
                200_000,
                RENDERER_STALE_AFTER_MS,
                Some(150_000),
                RELOAD_BACKOFF_BASE_MS
            ),
            WatchdogAction::Healthy
        );
    }

    #[test]
    fn clock_going_backwards_reads_healthy_not_reload() {
        // now < last_ack (clock skew) → saturating_sub yields 0 → healthy.
        assert_eq!(
            decide_liveness(90_000, 100_000, RENDERER_STALE_AFTER_MS, None, 0),
            WatchdogAction::Healthy
        );
    }

    // --- RF-perf-7: memory-pressure + render-stall health paths ---

    #[test]
    fn pressure_over_while_js_alive_is_observed_not_reloaded() {
        // SR-10 (AC-1): fresh ack (JS alive), not stalled, but pressure_over → the
        // watchdog OBSERVES it (log-only), it does NOT reload. A reload reclaims no
        // renderer memory (proven ×3) and would only blank the screen.
        assert_eq!(
            decide(
                102_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                None,
                0,
                true,
                false
            ),
            WatchdogAction::MemoryPressureObserved
        );
    }

    #[test]
    fn pressure_over_is_not_backoff_gated() {
        // SR-10 (AC-1): the observe path takes no disruptive action, so a live reload
        // backoff never suppresses it. Pin the last reload AT `now` (age 0) so it is
        // inside ANY positive backoff window regardless of the base constant's value
        // — a backoff-GATED action here would `BackoffWait`; pressure instead reports
        // observed, proving it is genuinely not gated (and can't rot if the constant
        // is retuned).
        assert_eq!(
            decide(
                102_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                Some(102_000), // last reload == now → age 0, inside any positive backoff
                RELOAD_BACKOFF_BASE_MS,
                true,
                false
            ),
            WatchdogAction::MemoryPressureObserved
        );
    }

    #[test]
    fn render_stalled_while_js_alive_reloads_render_stall() {
        // Fresh ack (JS alive) but render_stalled → reload, tagged render_stall.
        // AC-2 — the blank-but-alive case the ack-only watchdog misses.
        assert_eq!(
            decide(
                102_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                None,
                0,
                false,
                true
            ),
            WatchdogAction::Reload(ReloadCause::RenderStall)
        );
    }

    #[test]
    fn render_stall_outranks_pressure_when_both_fire() {
        // Both live-JS causes at once → render stall (blank now) wins over pressure
        // (blank soon). Cause tag is forensic only; either reloads.
        assert_eq!(
            decide(
                102_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                None,
                0,
                true,
                true
            ),
            WatchdogAction::Reload(ReloadCause::RenderStall)
        );
    }

    #[test]
    fn process_death_outranks_health_signals_when_ack_stale() {
        // A stale ack means the JS context is gone — the health signals can't be
        // trusted, so it is process-death regardless of pressure/stall inputs.
        assert_eq!(
            decide(
                200_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                None,
                0,
                true,
                true
            ),
            WatchdogAction::Reload(ReloadCause::ProcessDeath)
        );
    }

    #[test]
    fn healthy_when_alive_and_no_pressure_or_stall() {
        // AC-3: a fresh ack with neither health signal set stays Healthy — the new
        // paths never fire on a progressing renderer.
        assert_eq!(
            decide(
                102_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                None,
                0,
                false,
                false
            ),
            WatchdogAction::Healthy
        );
    }

    #[test]
    fn one_backoff_bounds_both_liveness_causes() {
        // AC-5: the shared backoff bounds BOTH liveness reload causes. Given a
        // pre-existing reload's backoff window, a process-death AND a render-stall
        // that land inside it each `BackoffWait` — a renderer can't escape the cap by
        // switching failure modes.
        assert_eq!(
            decide(
                200_000, // ack stale → process death
                100_000,
                RENDERER_STALE_AFTER_MS,
                Some(150_000),
                RELOAD_BACKOFF_BASE_MS,
                false,
                false,
            ),
            WatchdogAction::BackoffWait
        );
        // And a render-stall inside the same window also waits — one budget.
        assert_eq!(
            decide(
                102_000,
                100_000,
                RENDERER_STALE_AFTER_MS,
                Some(100_000),
                RELOAD_BACKOFF_BASE_MS,
                false,
                true,
            ),
            WatchdogAction::BackoffWait
        );
    }

    #[test]
    fn reload_cause_tags_are_distinct() {
        // AC-4: each LIVENESS cause logs a distinct token. (SR-10 removed the
        // memory_pressure cause — pressure no longer reloads.)
        assert_eq!(ReloadCause::ProcessDeath.as_str(), "process_death");
        assert_eq!(ReloadCause::RenderStall.as_str(), "render_stall");
    }

    #[test]
    fn accrue_pressure_samples_counts_sustained_and_resets_otherwise() {
        let t = RENDERER_PRESSURE_BYTES;
        // Over-threshold accumulates.
        assert_eq!(accrue_pressure_samples(0, Some(t), t), 1);
        assert_eq!(accrue_pressure_samples(2, Some(t + 1), t), 3);
        // Exactly at threshold counts (>=).
        assert_eq!(accrue_pressure_samples(1, Some(t), t), 2);
        // Under-threshold resets — pressure must be sustained.
        assert_eq!(accrue_pressure_samples(5, Some(t - 1), t), 0);
        // Unresolved (None) resets — never count an unknown sample (R1).
        assert_eq!(accrue_pressure_samples(5, None, t), 0);
    }

    #[test]
    fn slept_ms_reads_a_wall_clock_that_outran_the_ticks() {
        // An ordinary tick, or jitter under one tick: not asleep.
        assert_eq!(slept_ms(15_000, 15_000), None);
        assert_eq!(slept_ms(29_000, 15_000), None);
        // Lid closed for 6 or 33 minutes between two 15 s ticks.
        assert_eq!(slept_ms(373_000, 15_000), Some(358_000));
        assert_eq!(slept_ms(2_021_000, 15_000), Some(2_006_000));
        // A wall clock that stepped backwards is never a sleep.
        assert_eq!(slept_ms(0, 15_000), None);
    }

    #[test]
    fn a_wake_from_sleep_gets_a_fresh_grace_not_a_reload() {
        // The loop's step: the renderer acked, then the Mac slept 6 minutes.
        let last_ack = 1_000_000;
        let now = last_ack + 373_000;
        assert!(slept_ms(373_000, 15_000).is_some());
        // Judged on the ack alone the sleep reads as a dead renderer.
        assert_eq!(
            decide_liveness(now, last_ack, RENDERER_STALE_AFTER_MS, None, 0),
            WatchdogAction::Reload(ReloadCause::ProcessDeath)
        );
        // The wake counts as an ack, so the first tick awake is healthy.
        let woke_at = now;
        assert_eq!(
            decide_liveness(now, last_ack.max(woke_at), RENDERER_STALE_AFTER_MS, None, 0),
            WatchdogAction::Healthy
        );
        // A renderer that stays silent for 105 s of awake time is still reloaded.
        assert_eq!(slept_ms(105_000, 105_000), None);
        assert_eq!(
            decide_liveness(
                now + 105_000,
                last_ack.max(woke_at),
                RENDERER_STALE_AFTER_MS,
                None,
                0
            ),
            WatchdogAction::Reload(ReloadCause::ProcessDeath)
        );
    }

    #[test]
    fn stores_root_empty() {
        let liveness = RendererLiveness::default();
        assert!(!liveness.root_empty());
        liveness.store_root_empty(true);
        assert!(liveness.root_empty());
    }

    #[test]
    fn accrue_render_stall_beats_only_counts_visible_frozen_nonzero() {
        // Visible + real tick that did not advance → one more stall beat.
        assert_eq!(accrue_render_stall_beats(1, true, 7, 7), 2);
        // Advanced tick → healthy, reset.
        assert_eq!(accrue_render_stall_beats(3, true, 8, 7), 0);
        // Hidden window (rAF paused) → not a stall, reset (R2).
        assert_eq!(accrue_render_stall_beats(3, false, 7, 7), 0);
        // `0` tick = probe never reported → no proof, never a stall.
        assert_eq!(accrue_render_stall_beats(3, true, 0, 0), 0);
    }

    #[test]
    fn backoff_window_is_exponential_and_capped() {
        assert_eq!(backoff_window_ms(0), 0);
        assert_eq!(backoff_window_ms(1), RELOAD_BACKOFF_BASE_MS);
        assert_eq!(backoff_window_ms(2), RELOAD_BACKOFF_BASE_MS * 2);
        assert_eq!(backoff_window_ms(3), RELOAD_BACKOFF_BASE_MS * 4);
        // Deep into the sequence it saturates at the cap, never overflows.
        assert_eq!(backoff_window_ms(50), RELOAD_BACKOFF_CAP_MS);
        assert_eq!(backoff_window_ms(u32::MAX), RELOAD_BACKOFF_CAP_MS);
    }

    #[test]
    fn beat_updates_last_ack() {
        let liveness = RendererLiveness::default();
        assert_eq!(liveness.last_ack_ms(), 0);
        liveness.beat(123_456);
        assert_eq!(liveness.last_ack_ms(), 123_456);
        liveness.beat(999_999);
        assert_eq!(liveness.last_ack_ms(), 999_999);
    }

    #[test]
    fn stores_heap_and_unhandled_rejections() {
        let l = RendererLiveness::default();
        assert_eq!(l.last_heap_bytes(), 0);
        assert_eq!(l.unhandled_rejections(), 0);
        l.store_heap_bytes(1234);
        l.store_unhandled_rejections(7);
        assert_eq!(l.last_heap_bytes(), 1234);
        assert_eq!(l.unhandled_rejections(), 7);
    }

    #[test]
    fn stores_render_tick_and_visibility() {
        let l = RendererLiveness::default();
        // Defaults: no paint proof yet (0), assume visible (absence never stalls).
        assert_eq!(l.last_render_tick(), 0);
        assert!(l.render_visible());
        l.store_render_tick(42);
        l.store_render_visible(false);
        assert_eq!(l.last_render_tick(), 42);
        assert!(!l.render_visible());
        l.store_render_visible(true);
        assert!(l.render_visible());
    }

    #[test]
    fn stores_and_reads_fe_instance_counts() {
        // RF-perf-4 (AC-1): None until the first beat carries counts (the memory line
        // renders `skip`, never a fake 0), then reflects the last-stored tally.
        let l = RendererLiveness::default();
        assert_eq!(l.instance_counts(), None);
        let counts = FeInstanceCounts {
            editors: 12,
            iframes: 3,
            webgl_terminals: 9,
            teams: 4,
        };
        l.store_instance_counts(counts);
        assert_eq!(l.instance_counts(), Some(counts));
        // Last write wins — a fresh beat replaces the tally wholesale.
        let next = FeInstanceCounts {
            editors: 5,
            ..counts
        };
        l.store_instance_counts(next);
        assert_eq!(l.instance_counts().map(|c| c.editors), Some(5));
    }

    #[test]
    fn fe_instance_counts_deserialize_camelcase_payload() {
        // The heartbeat wrapper sends camelCase keys; the serde rename must accept
        // `webglTerminals` (the only multi-word field) verbatim.
        let json = r#"{"editors":2,"iframes":0,"webglTerminals":7,"teams":3}"#;
        let parsed: FeInstanceCounts = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed,
            FeInstanceCounts {
                editors: 2,
                iframes: 0,
                webgl_terminals: 7,
                teams: 3,
            }
        );
    }

    #[test]
    fn note_init_attributes_reinit_cause() {
        let l = RendererLiveness::default();
        // First announce, no reload yet → first-boot.
        assert_eq!(l.note_init(1_000), "first-boot");
        // A later announce with no watchdog reload → external (the 21:27 case).
        assert_eq!(l.note_init(2_000), "external");
        // A watchdog reload just landed → the next announce is attributed to it.
        l.mark_reload(50_000);
        assert_eq!(l.note_init(60_000), "watchdog-reload");
        // m1: the reload is CONSUMED — a second init still inside the window reads
        // `external`, not a spurious second `watchdog-reload`.
        assert_eq!(l.note_init(61_000), "external");
        // Long after the reload (past the stale window) → external again.
        assert_eq!(
            l.note_init(50_000 + RENDERER_STALE_AFTER_MS + 60_000),
            "external"
        );
    }
}

#[cfg(test)]
mod per_label {
    use super::*;
    use crate::renderer_recovery::RECOVERY_TIMEOUT;
    use crate::windows::item_key::ItemKey;
    use crate::windows::moves::MoveTimer;
    use crate::windows::registry::{WindowHost, WindowSlice};
    use std::cell::RefCell;

    /// Records the events and destroys a give-up sends.
    #[derive(Default)]
    struct Host {
        events: RefCell<Vec<(String, String, serde_json::Value)>>,
        destroyed: RefCell<Vec<String>>,
    }

    impl WindowHost for Host {
        fn send_slice(&self, _: &WindowSlice) {}
        fn focus(&self, _: &str) {}
    }

    impl MoveHost for Host {
        fn send_event(&self, label: &str, event: &str, payload: serde_json::Value) {
            self.events
                .borrow_mut()
                .push((label.to_owned(), event.to_owned(), payload));
        }
        fn window_exists(&self, _: &str) -> bool {
            true
        }
        fn create_window(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn destroy_window(&self, label: &str) {
            self.destroyed.borrow_mut().push(label.to_owned());
        }
        fn schedule(&self, _: u64, _: MoveTimer) {}
    }

    fn tab(id: &str) -> ItemKey {
        ItemKey {
            kind: "tab".into(),
            team: "acme:docs".into(),
            id: id.into(),
        }
    }

    /// `main` and a ready `sat-1` holding one tab.
    fn reg(host: &Host) -> WindowRegistry {
        let reg = WindowRegistry::new();
        reg.add_satellite(host, "sat-1").unwrap();
        reg.ready(host, "sat-1").unwrap();
        reg.reassign_item(host, &tab("/repo/a.md"), "sat-1")
            .unwrap();
        host.events.borrow_mut().clear();
        reg
    }

    fn at(now: u64, last_ack: u64) -> WatchReading {
        WatchReading {
            now,
            last_ack,
            visible: true,
            ..<WatchReading as Default>::default()
        }
    }

    const STALE_PLUS: u64 = RENDERER_STALE_AFTER_MS + 1;
    const WAIT_MS: u64 = RECOVERY_TIMEOUT.as_millis() as u64;

    #[test]
    fn two_windows_heartbeats_do_not_mask_each_other() {
        let windows = <WindowLiveness as Default>::default();
        RendererLiveness::beat(&WindowLiveness::liveness_of(&windows, "main"), 200_000);
        let sat = WindowLiveness::liveness_of(&windows, "sat-1");
        assert_eq!(RendererLiveness::last_ack_ms(&sat), 0);

        let mut main = watch_from(0, 0, 0);
        let mut sat_watch = watch_from(0, 0, 0);
        let main_ack =
            RendererLiveness::last_ack_ms(&WindowLiveness::liveness_of(&windows, "main"));
        assert_eq!(
            watch_step("main", &mut main, &at(200_000, main_ack)),
            WatchStep::Healthy { cleared: 0 }
        );
        assert_eq!(
            watch_step("sat-1", &mut sat_watch, &at(200_000, 0)),
            WatchStep::Reload(ReloadCause::ProcessDeath)
        );

        // And the other way round: a live satellite does not keep a hung `main` alive.
        RendererLiveness::beat(&sat, 400_000);
        assert_eq!(
            watch_step("main", &mut main, &at(400_000, main_ack)),
            WatchStep::Reload(ReloadCause::ProcessDeath)
        );
    }

    #[test]
    fn a_hung_satellite_reloads_with_its_items_kept_while_mains_counters_stay() {
        let host = Host::default();
        let reg = reg(&host);
        let mut main = watch_from(0, 0, 0);
        let mut sat = watch_from(0, 0, 0);
        assert_eq!(
            watch_step("sat-1", &mut sat, &at(STALE_PLUS, 0)),
            WatchStep::Reload(ReloadCause::ProcessDeath)
        );
        record_reload(&mut sat, STALE_PLUS);
        assert_eq!(
            watch_step("main", &mut main, &at(STALE_PLUS, STALE_PLUS)),
            WatchStep::Healthy { cleared: 0 }
        );
        assert_eq!(main, watch_from(0, 0, 0));
        let locked = WindowRegistry::locked(&reg);
        assert_eq!(
            Locked::items_held_by(&locked, "sat-1"),
            vec![tab("/repo/a.md")]
        );
        assert!(host.destroyed.borrow().is_empty());
        assert!(host.events.borrow().is_empty());
    }

    #[test]
    fn a_heartbeat_after_a_satellite_reload_ends_its_ladder() {
        let mut sat = watch_from(0, 0, 0);
        record_reload(&mut sat, STALE_PLUS);
        assert_eq!(
            watch_step("sat-1", &mut sat, &at(STALE_PLUS + 1_000, 0)),
            WatchStep::Wait
        );
        assert_eq!(
            watch_step(
                "sat-1",
                &mut sat,
                &at(STALE_PLUS + 10_000, STALE_PLUS + 5_000)
            ),
            WatchStep::Healthy { cleared: 1 }
        );
        assert_eq!(sat.consecutive_reloads, 0);
    }

    /// Steps a satellite on a 15 s tick starting at `offset`, with heartbeats from `acks`
    /// (the last ack at a time, given whether it has been reloaded yet), until it is given
    /// up on. Returns the give-up time and the last heartbeat before it.
    fn give_up_time(offset: u64, acks: &dyn Fn(u64, bool) -> (u64, u64)) -> (u64, u64) {
        let mut watch = watch_from(0, 0, 0);
        let mut now = offset;
        loop {
            let (last_ack, render_tick) = acks(now, watch.consecutive_reloads > 0);
            let reading = WatchReading {
                render_tick,
                ..at(now, last_ack)
            };
            fold_beat(&mut watch, &reading);
            match watch_step("sat-1", &mut watch, &reading) {
                WatchStep::GiveUp => return (now, last_ack),
                WatchStep::Reload(_) => record_reload(&mut watch, now),
                WatchStep::Healthy { cleared } => assert_eq!(cleared, 0),
                _ => {}
            }
            now += WATCHDOG_TICK_MS;
            assert!(now < 1_000_000, "never gave up");
        }
    }

    #[test]
    fn two_failed_reloads_give_up_within_190_s_of_the_last_heartbeat_for_both_causes() {
        // Process death: the last heartbeat was at 0.
        let dead = |_: u64, _: bool| (0, 0);
        // Render stall: beats every 30 s with a frozen paint tick until the first reload,
        // none after it (the last ack stays the last pre-reload beat).
        let frozen = std::cell::Cell::new(0);
        let stalled = |now: u64, reloaded: bool| {
            if !reloaded {
                frozen.set(now - now % RENDERER_ACK_INTERVAL_MS);
            }
            (frozen.get(), 7)
        };
        for offset in (0..WATCHDOG_TICK_MS).step_by(1_000) {
            let (when, last) = give_up_time(offset, &dead);
            assert!(when - last <= 190_000, "process death at {offset}: {when}");
            let (when, last) = give_up_time(offset, &stalled);
            assert!(when - last <= 190_000, "render stall at {offset}: {when}");
        }
    }

    #[test]
    fn a_satellite_gives_up_after_exactly_two_reloads() {
        let mut watch = watch_from(0, 0, 0);
        let mut reloads = 0;
        let mut now = 0;
        loop {
            match watch_step("sat-1", &mut watch, &at(now, 0)) {
                WatchStep::Reload(_) => {
                    reloads += 1;
                    record_reload(&mut watch, now);
                }
                WatchStep::GiveUp => break,
                _ => {}
            }
            now += WATCHDOG_TICK_MS;
        }
        assert_eq!(reloads, SATELLITE_MAX_RELOADS);
        assert!(now >= STALE_PLUS + 2 * WAIT_MS);
    }

    #[test]
    fn the_give_up_returns_the_items_as_crash_and_destroys_the_window() {
        let host = Host::default();
        let reg = reg(&host);
        assert!(give_up_satellite(&host, &reg, "sat-1"));
        assert_eq!(*host.destroyed.borrow(), vec!["sat-1".to_owned()]);
        let events = host.events.borrow();
        let returned: Vec<&serde_json::Value> = Iterator::collect(
            events
                .iter()
                .filter(|(to, event, _)| {
                    to == MAIN_LABEL && event == crate::windows::moves::ITEMS_RETURNED_EVENT
                })
                .map(|(_, _, payload)| payload),
        );
        assert_eq!(returned.len(), 1);
        assert_eq!(returned[0]["reason"], "crash");
        assert_eq!(returned[0]["items"].as_array().unwrap().len(), 1);
        let locked = WindowRegistry::locked(&reg);
        assert!(!Locked::has_window(&locked, "sat-1"));
    }

    #[test]
    fn a_failed_dispatch_gives_up() {
        let host = Host::default();
        let reg = reg(&host);
        let mut watch = watch_from(0, 0, 0);
        assert_eq!(
            watch_step("sat-1", &mut watch, &at(STALE_PLUS, 0)),
            WatchStep::Reload(ReloadCause::ProcessDeath)
        );
        // The loop's answer to a reload that could not be posted.
        mark_giving_up(&mut watch);
        assert_eq!(
            watch_step("sat-1", &mut watch, &at(STALE_PLUS, STALE_PLUS)),
            WatchStep::GiveUp
        );
        assert!(give_up_satellite(&host, &reg, "sat-1"));
        assert_eq!(*host.destroyed.borrow(), vec!["sat-1".to_owned()]);
    }

    fn returned_events(host: &Host) -> usize {
        Iterator::count(host.events.borrow().iter().filter(|(to, event, _)| {
            to == MAIN_LABEL && event == crate::windows::moves::ITEMS_RETURNED_EVENT
        }))
    }

    #[test]
    fn a_refused_removal_destroys_nothing_and_the_watch_retries_until_the_window_is_gone() {
        let host = Host::default();
        let reg = reg(&host);
        // Removed by another path (a close) since this tick read the registry.
        assert!(give_up_satellite(&host, &reg, "sat-1"));
        host.events.borrow_mut().clear();
        host.destroyed.borrow_mut().clear();

        assert!(!give_up_satellite(&host, &reg, "sat-1"));
        assert!(host.destroyed.borrow().is_empty());
        assert_eq!(returned_events(&host), 0);

        let mut watch = watch_from(0, 0, 0);
        mark_giving_up(&mut watch);
        assert_eq!(
            watch_step("sat-1", &mut watch, &at(1_000, 1_000)),
            WatchStep::GiveUp
        );
        let mut watches = BTreeMap::from([("sat-1".to_owned(), watch)]);
        sync_watches(
            &mut watches,
            &[(MAIN_LABEL.to_owned(), false)],
            1_000,
            &|_: &str| (0, 0),
        );
        assert!(!watches.contains_key("sat-1"));
    }

    #[test]
    fn a_refused_removal_returns_nothing_twice() {
        let host = Host::default();
        let reg = reg(&host);
        assert!(give_up_satellite(&host, &reg, "sat-1"));
        assert_eq!(returned_events(&host), 1);
        for _ in 0..3 {
            assert!(!give_up_satellite(&host, &reg, "sat-1"));
        }
        assert_eq!(returned_events(&host), 1);
        assert_eq!(*host.destroyed.borrow(), vec!["sat-1".to_owned()]);
    }

    #[test]
    fn an_empty_satellite_is_removed_without_a_return() {
        let host = Host::default();
        let reg = reg(&host);
        reg.reassign_item(&host, &tab("/repo/a.md"), MAIN_LABEL)
            .unwrap();
        host.events.borrow_mut().clear();
        assert!(give_up_satellite(&host, &reg, "sat-1"));
        assert_eq!(returned_events(&host), 0);
        assert_eq!(*host.destroyed.borrow(), vec!["sat-1".to_owned()]);
    }

    #[test]
    fn a_hung_main_reloads_backs_off_and_is_never_destroyed() {
        let host = Host::default();
        let reg = reg(&host);
        let mut main = watch_from(0, 0, 0);
        let mut reload_times = Vec::new();
        let mut now = 0;
        while now < 2 * RELOAD_BACKOFF_CAP_MS {
            match watch_step("main", &mut main, &at(now, 0)) {
                WatchStep::Reload(cause) => {
                    assert_eq!(cause, ReloadCause::ProcessDeath);
                    reload_times.push(now);
                    record_reload(&mut main, now);
                }
                WatchStep::GiveUp => panic!("main given up at {now}"),
                _ => {}
            }
            now += WATCHDOG_TICK_MS;
        }
        assert!(reload_times.len() > SATELLITE_MAX_RELOADS as usize);
        let gaps: Vec<u64> = Iterator::collect(reload_times.windows(2).map(|w| w[1] - w[0]));
        assert!(gaps[0] >= RELOAD_BACKOFF_BASE_MS);
        assert!(Iterator::all(&mut gaps.windows(2), |w| w[1] >= w[0]));
        assert!(!give_up_satellite(&host, &reg, MAIN_LABEL));
        assert!(host.destroyed.borrow().is_empty());
        assert!(Locked::has_window(
            &WindowRegistry::locked(&reg),
            MAIN_LABEL
        ));
    }

    #[test]
    fn a_pending_window_is_unwatched_and_its_grace_starts_when_pending_clears() {
        let host = Host::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-2").unwrap();
        let labels = |reg: &WindowRegistry| -> Vec<(String, bool)> {
            let locked = WindowRegistry::locked(reg);
            let labels: Vec<(String, bool)> =
                Iterator::collect(Locked::window_labels(&locked).into_iter().map(|l| {
                    let pending = Locked::is_pending(&locked, &l);
                    (l, pending)
                }));
            labels
        };
        let never = |_: &str| (0, 0);
        let mut watches = BTreeMap::new();
        sync_watches(&mut watches, &labels(&reg), 0, &never);
        assert_eq!(
            Iterator::collect::<Vec<&String>>(watches.keys()),
            vec!["main"]
        );

        let ready_at = 500_000;
        reg.ready(&host, "sat-2").unwrap();
        sync_watches(&mut watches, &labels(&reg), ready_at, &never);
        let watch = watches.get_mut("sat-2").unwrap();
        assert_eq!(
            watch_step("sat-2", watch, &at(ready_at + RENDERER_STALE_AFTER_MS, 0)),
            WatchStep::Healthy { cleared: 0 }
        );
        assert_eq!(
            watch_step("sat-2", watch, &at(ready_at + STALE_PLUS, 0)),
            WatchStep::Reload(ReloadCause::ProcessDeath)
        );

        // Pending again (a move target) or gone: unwatched.
        reg.set_pending(&host, "sat-2", true).unwrap();
        sync_watches(&mut watches, &labels(&reg), ready_at, &never);
        assert!(!watches.contains_key("sat-2"));
    }

    #[test]
    fn liveness_keeps_only_registered_windows() {
        let windows = <WindowLiveness as Default>::default();
        WindowLiveness::liveness_of(&windows, "main");
        WindowLiveness::liveness_of(&windows, "sat-9");
        WindowLiveness::retain_registered(&windows, &[("main".to_owned(), false)]);
        assert!(WindowLiveness::window_liveness(&windows, "main").is_some());
        assert!(WindowLiveness::window_liveness(&windows, "sat-9").is_none());
    }
}
