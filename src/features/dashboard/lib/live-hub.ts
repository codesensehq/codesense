// SPDX-License-Identifier: MIT
import { DEFAULT_APP_THEME, type AppTheme } from "@/themes";
import { createSessionTextRouter, type SessionTextEvent } from "./session-text";
import type { ThemeMode } from "@/themes/compiler";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  liveHubSubscribe,
  liveHubPage,
  liveHubWindow,
  liveHubUnsubscribe,
  liveHubRelease,
  liveHubReleaseOwner,
  liveHubViewKey,
  type FrameRecord,
  agentReadSessions,
  sessionTextUnwatch,
  sessionTextWatch,
  type SessionListRow,
} from "@/tauri/commands";
import { ORG_REGISTRY_CHANGED_EVENT, SOURCE_REPO_ATTACHMENTS_CHANGED_EVENT } from "@/tauri/events";
import { logger } from "@/shared/lib/logger";
import { countWebviewPerf } from "@/shared/lib/webview-perf-counters";
import { readSharedUiState, writeSharedUiState, watchSharedUiState } from "./shared-ui-state";

// Policy: hidden badge work is bounded independently of visible delivery.
export const LIVE_HIDDEN_THROTTLE_MS = 2000;
export const MAX_LIVE_HIDDEN_FRAMES = 4;
/** Cached views no frame, read or write holds (seeded or read by a frameless caller) stay
 *  for a quick re-read, this many at most, least recently used first out. */
export const MAX_UNHELD_VIEWS = 16;
type BadgeDelivery = {
  badge?: "live";
  owner?: string;
  /** What the frame's grant allows, so it is told only changes it could read. */
  grants?: readonly string[];
};
/** The host event a session's assistant prose arrives on (`session_text.rs`). */
const SESSION_TEXT_EVENT = "session-text";
/** A page hears a session's prose only under this grant. */
const SESSIONS_READ_GRANT = "sessions:read";
/** `setupState()` reads every org on this Mac, so it takes the machine-wide grant. */
const SETUP_READ_GRANT = "machines:read";

const RUN_REVIEW_TOPICS = ["runEndorsements", "runEvidence"] as const;
/** One setup write's native events (a registry commit, then a checkout bind after its
 *  reconcile) can be this far apart; the page hears once they have been quiet this long. */
const SETUP_CHANGED_SETTLE_MS = 500;
/** A longer run of setup events still tells the page within this long of its first event. */
const SETUP_CHANGED_MAX_WAIT_MS = 2000;
export type RunReviewTopic = (typeof RUN_REVIEW_TOPICS)[number];
const isRunReviewTopic = (topic: string) =>
  (RUN_REVIEW_TOPICS as readonly string[]).includes(topic);
const isConfigurationTopic = (topic: string) =>
  topic === "profile" || topic === "workspaceConfig" || topic === "prefs";

export type HubRow = Record<string, unknown> & { id: string };
export type HubSnapshot = {
  topic: string;
  viewKey: string;
  rev: number;
  snapshot: HubRow[];
  total?: number;
  cursor?: string;
  /** The generation of the hold the host took for this window when it handed over the view. */
  hold?: number;
};
export type HubReply = Omit<HubSnapshot, "snapshot"> & { snapshot?: HubRow[]; deltas?: HubDelta[] };
export type SubscriptionOptions = {
  window?: [number, number];
  viewKey?: string;
  order?: "status";
};
type ScopedSubscription = SubscriptionOptions & {
  id: string;
  frame: Frame;
  topic: string;
  value?: HubSnapshot;
  stale?: boolean;
  retry?: boolean;
  pending?: Array<{ baseRev: number | null; delta: HubDelta }>;
  read?: Promise<HubSnapshot>;
  paused?: Promise<void>;
};
/** One updated row as the host sends it: the fields it set and the ones it dropped. Only
 *  {@link LiveHub.receive} sees patches; it rebuilds full rows before anything else does. */
export type RowPatch = { id: string; set: Record<string, unknown>; unset: string[] };
export type HubDelta = {
  topic: string;
  viewKey: string;
  rev: number;
  baseRev?: number;
  upserts: HubRow[];
  patches?: RowPatch[];
  removes: string[];
  requestId?: string;
  actor?: unknown;
  cursor?: string | null;
  kind?: string;
  total?: number;
};
type Post = (message: Record<string, unknown>) => void;
type Dependencies = {
  readSessions?: () => Promise<SessionListRow[]>;
  read: (
    topic: string,
    viewKey: string,
    sinceRev?: number,
    options?: SubscriptionOptions & { subscriptionId: string; frameId?: string },
  ) => Promise<HubReply>;
  page?: (id: string, cursor: string) => Promise<HubSnapshot>;
  window?: (id: string, window: [number, number]) => Promise<HubDelta>;
  unsubscribe?: (id: string, paused?: boolean) => Promise<void>;
  /** The view left the cache: the host stops sending its deltas (`live_hub_release`). */
  release?: (topic: string, viewKey: string, generation: number) => Promise<void>;
  /** Drop the holds an earlier page in this window left; resolves with the last hold
   *  generation issued (`live_hub_release_owner`). */
  releaseOwner?: () => Promise<number>;
  listen: (event: string, callback: (event: { payload: unknown }) => void) => Promise<UnlistenFn>;
  watchUi?: (changed: (topic: string, viewKey: string) => void) => Promise<UnlistenFn>;
  /** Calls `changed` whenever the answer to canPasteToTerminal() changes. */
  watchPasteTarget?: (changed: () => void) => UnlistenFn;
  readUi: (key: string) => Promise<Record<string, unknown>>;
  writeUi: (key: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Start and stop the host's stream of a session's prose (`session_text_watch`). */
  watchText?: (sessionId: string) => Promise<void>;
  unwatchText?: (sessionId: string) => Promise<void>;
};
type Frame = {
  /** The id `attach` took: the frame id `release_frame` names for a page's frame. */
  id: string;
  viewKey: string;
  grants: readonly string[];
  liveBadge: boolean;
  hiddenLive: boolean;
  shownOrder: number;
  hiddenTimer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
  generation: number;
  native: boolean;
  post: Post;
  visible: boolean;
  stale: boolean;
  defaults: Set<string>;
  scoped: Map<string, ScopedSubscription>;
  pending: HubDelta[];
  resync: Set<string>;
  waits: Array<() => void>;
  invalidations: Map<string, Record<string, unknown>>;
  /** The sessions whose assistant prose this frame hears (`onSessionText`), each with the prose
   *  keys of its current turn already posted: a joiner's replay repeats nothing to this frame. */
  sessionText: Map<string, { turn: string; heard: Set<string> }>;
  /** Views this frame seeded for itself (a prepared agent catalog): held until it rekeys. */
  seeded: Set<string>;
  /** The cached views this frame holds: its default topics' and the ones it seeded. */
  held: Set<string>;
  themeChanged?: () => void;
};
const keyOf = (topic: string, viewKey: string) => JSON.stringify([topic, viewKey]);
/** Inbox rows a committed projection pass changed, as `codesense:inbox-changed` carries them. */
type InboxChange = { team: { org: string; team: string }; messageIds: number[] };
const teamScope = (team: InboxChange["team"]) => `team:${team.org}/${team.team}`;
/** Changes held for a hidden frame, merged per team. A change with no ids is team-wide, and
 *  stays team-wide when named ids merge in. */
function unionChanges(held: InboxChange[], more: InboxChange[]): InboxChange[] {
  const byTeam = new Map(held.map((c) => [teamScope(c.team), c]));
  for (const change of more) {
    const known = byTeam.get(teamScope(change.team));
    const teamWide = known && (!known.messageIds.length || !change.messageIds.length);
    byTeam.set(teamScope(change.team), {
      team: change.team,
      messageIds: teamWide
        ? []
        : [...new Set([...(known?.messageIds ?? []), ...change.messageIds])],
    });
  }
  return [...byTeam.values()];
}
function inboxChangesOf(payload: unknown): InboxChange[] {
  const changes = (payload as { changes?: unknown } | null)?.changes;
  return Array.isArray(changes)
    ? changes.filter((c): c is InboxChange => !!c?.team && Array.isArray(c.messageIds))
    : [];
}
/** What a frame may be told now: an inbox change names only its own team's rows, judged
 *  by the frame's current scope, so held ids never outlive a rekey. A change that named only
 *  other teams' rows tells the frame nothing, so it isn't posted (`null`). */
function deliverable(frame: Pick<Frame, "viewKey">, message: Record<string, unknown>) {
  const { changes, ...rest } = message;
  if (!changes) return rest;
  const visible = (changes as InboxChange[]).filter(
    (c) => !frame.viewKey.startsWith("team:") || frame.viewKey === teamScope(c.team),
  );
  return visible.length ? { ...rest, changes: visible } : null;
}
function postDeliverable(frame: Pick<Frame, "viewKey" | "post">, message: Record<string, unknown>) {
  const delivered = deliverable(frame, message);
  if (delivered) frame.post(delivered);
}
/** Host view state that is one for every team: the dock's folds and arrangement survive a team
 *  switch, whatever view key the frame's grant gives its data topics. */
const GLOBAL_UI_TOPICS: ReadonlySet<string> = new Set(["ui:dock", "theme"]);
const frameKey = (frame: { viewKey: string }, topic: string) =>
  GLOBAL_UI_TOPICS.has(topic) ? "all" : frame.viewKey;
const subscriptionKey = (topic: string, viewKey?: string) =>
  viewKey === undefined ? topic : keyOf(topic, viewKey);
type ViewSelector = Pick<SubscriptionOptions, "viewKey" | "order"> | string;
/** Resolve selectors only against the attached frame's current grant. */
function subscriptionViewKey(frame: Frame, topic: string, selector?: ViewSelector) {
  if (typeof selector === "string") return selector;
  return selector?.order ? `${frameKey(frame, topic)}|${selector.order}` : selector?.viewKey;
}
/** Architecture: delivery-time scope check. Grant-derived views follow the current
 * frame; independently prepared records keys name their own Rust-authorized scope,
 * so they survive a rekey while registered to this frame. Native watchers are internal. */
function canDeliver(frame: Frame, message: Record<string, unknown>) {
  if (frame.disposed) return false;
  if (frame.native || typeof message.viewKey !== "string" || typeof message.topic !== "string")
    return true;
  const base = message.viewKey.split("|")[0];
  if (base === frameKey(frame, message.topic).split("|")[0]) return true;
  if (
    message.topic === "files" &&
    frame.viewKey === "all" &&
    [...frame.scoped.values()].some((s) => s.topic === "files" && s.viewKey === message.viewKey)
  )
    return true;
  if (base === "all" || base.startsWith("team:")) return false;
  return [...frame.scoped.values()].some(
    (sub) => sub.topic === message.topic && !sub.order && sub.viewKey === message.viewKey,
  );
}
/** The session ids an event names: a progress or done event's `sessionId`, a pty-exit's
 *  `session_id`, or a usage notice's `sessionIds`. */
export const sessionIdsOf = (payload: unknown): string[] => {
  const p = (payload ?? {}) as { sessionId?: unknown; session_id?: unknown; sessionIds?: unknown };
  const ids = Array.isArray(p.sessionIds) ? p.sessionIds : [p.sessionId ?? p.session_id];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
};
/** The events a session record moves with, each naming its session. The record's readers listen
 *  over this one list: the hub (`session-record-changed`) and the inbox's `useSessionRecord`. */
export const SESSION_RECORD_EVENTS = [
  "mcp:agent-progress",
  "mcp:agent-done",
  "pty-exit",
  "session-usage-changed",
] as const;
const rowId = (row: HubRow) => row.id ?? String(row.handle);

/** When an inbox row was written: what the inbox lists newest first. */
const inboxAt = (row: HubRow) =>
  Number(
    row.createdAt ??
      (row.message as { createdAtMs?: number } | undefined)?.createdAtMs ??
      row.messageId ??
      0,
  );

/** Keep in step with {@link orderKey}: a field this sorts by must be in that key. */
export function orderedRows(topic: string, rows: HubRow[]): HubRow[] {
  if (topic === "files")
    return rows.sort(
      (a, b) =>
        Number(b.kind === "dir") - Number(a.kind === "dir") ||
        String(a.name).localeCompare(String(b.name), undefined, { numeric: true }),
    );
  if (topic === "agentList" || topic === "records" || topic === "pins")
    return rows.sort(
      (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.id.localeCompare(b.id),
    );
  if (topic !== "inbox") return rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows.sort(
    (a, b) =>
      Number(b.rowType === "counts") - Number(a.rowType === "counts") ||
      inboxAt(b) - inboxAt(a) ||
      Number(b.messageId ?? 0) - Number(a.messageId ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** What {@link orderedRows} sorts a `topic` row by besides its id (keep the two in step). An update that keeps
 *  it keeps the row's place, so the view need not be sorted again. */
export function orderKey(topic: string, row: HubRow): string {
  if (topic === "files") return `${row.kind === "dir"}\u0000${String(row.name)}`;
  if (topic === "agentList" || topic === "records" || topic === "pins")
    return String(Number(row.order ?? 0));
  if (topic !== "inbox") return "";
  return `${row.rowType === "counts"}\u0000${inboxAt(row)}\u0000${Number(row.messageId ?? 0)}`;
}

/** Each patched view's row positions by id. Only {@link patchRows} sets one, so a seed, a
 *  resync or a gap (a snapshot from anywhere else) starts from a full rebuild. */
const rowIndexes = new WeakMap<HubSnapshot, ReadonlyMap<string, number>>();

/**
 * `current` with `delta` applied, as a new snapshot in `envelope`. Neither `current` nor
 * its rows change: the result has its own array and holds the delta's row objects. An
 * update that moves no order key replaces the row in place; an insert, a remove or a
 * moved order key sorts the whole view.
 */
function patchRows(
  current: HubSnapshot | undefined,
  delta: Pick<HubDelta, "upserts" | "removes">,
  envelope: Omit<HubSnapshot, "snapshot">,
): HubSnapshot {
  countWebviewPerf("liveHubPatches");
  const rows = current?.snapshot ?? [];
  const index = current && rowIndexes.get(current);
  let snapshot: HubRow[] | undefined;
  let moved = false;
  if (index && !delta.removes.some((id) => index.has(id))) {
    snapshot = rows;
    for (const row of delta.upserts) {
      const at = index.get(rowId(row));
      if (at === undefined) {
        snapshot = undefined;
        break;
      }
      if (snapshot === rows) snapshot = rows.slice();
      moved ||= orderKey(envelope.topic, snapshot[at]) !== orderKey(envelope.topic, row);
      snapshot[at] = row;
    }
  }
  if (snapshot && !moved) {
    const next = { ...envelope, snapshot };
    rowIndexes.set(next, index!);
    return next;
  }
  if (!snapshot) {
    const byId = new Map(rows.map((row) => [rowId(row), row]));
    for (const id of delta.removes) byId.delete(id);
    for (const row of delta.upserts) byId.set(rowId(row), row);
    snapshot = [...byId.values()];
  }
  countWebviewPerf("liveHubSorts");
  const next = { ...envelope, snapshot: orderedRows(envelope.topic, snapshot) };
  rowIndexes.set(next, new Map(next.snapshot.map((row, at) => [rowId(row), at])));
  return next;
}

/** The full row `patch` makes of `base`, as a new object. */
export function patchedRow(base: HubRow, { set, unset }: RowPatch): HubRow {
  const row: HubRow = { ...base, ...set };
  for (const field of unset) delete row[field];
  return row;
}

/**
 * `delta` with each patch rebuilt into the full row it makes of `current`'s row, so every
 * reader downstream gets full rows. `undefined` when `current` lacks a patched row: a patch is
 * never applied to a guess. Neither `current` nor its rows change.
 */
function withFullRows(current: HubSnapshot, delta: HubDelta): HubDelta | undefined {
  if (!delta.patches?.length) return delta;
  const index = rowIndexes.get(current);
  const byId = index ? undefined : new Map(current.snapshot.map((row) => [rowId(row), row]));
  const upserts = [...delta.upserts];
  for (const patch of delta.patches) {
    const at = index?.get(patch.id);
    const base = byId ? byId.get(patch.id) : at === undefined ? undefined : current.snapshot[at];
    if (!base) return undefined;
    upserts.push(patchedRow(base, patch));
  }
  const { patches: _patches, ...rest } = delta;
  return { ...rest, upserts };
}

export async function paneViewKey(frame: Pick<FrameRecord, "origin" | "token">): Promise<string> {
  return liveHubViewKey(frame.origin, frame.token);
}

export class LiveHub {
  private themeValue = { themeId: DEFAULT_APP_THEME, mode: "light" as ThemeMode, rev: 0 };
  publishTheme(themeId: AppTheme, mode: ThemeMode, force = false) {
    if (!force && themeId === this.themeValue.themeId && mode === this.themeValue.mode) return;
    this.seed({
      topic: "theme",
      viewKey: "all",
      rev: this.themeValue.rev,
      snapshot: [{ id: "theme", ...this.themeValue }],
    });
    this.themeValue = { themeId, mode, rev: this.themeValue.rev + 1 };
    this.receive({
      topic: "theme",
      viewKey: "all",
      rev: this.themeValue.rev,
      upserts: [{ id: "theme", ...this.themeValue }],
      removes: [],
    });
  }
  private frames = new Map<string, Frame>();
  private shownOrder = 0;
  private scoped = new Map<string, ScopedSubscription>();
  private views = new Map<string, HubSnapshot>();
  private pendingReads = new Map<string, HubDelta[]>();
  /** What a scoped view held just before each delta, plus the envelope base the host sent: the host
   *  may suppress revisions, and unchanged `total`/`cursor` can fold. */
  private envelopes = new WeakMap<
    HubDelta,
    { baseRev: number | null; total?: number; cursor?: string }
  >();
  private reads = new Map<string, Promise<HubSnapshot>>();
  private unlisteners: Promise<UnlistenFn>[] = [];
  private ready: Promise<void> | null = null;
  private joinedSessionsRead?: Promise<SessionListRow[]>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private setupFirstAt: number | null = null;
  private uiTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private uiWrites = new Map<string, Promise<unknown>>();
  /** How many holders keep each cached view: frames that read it as a default topic or
   *  seeded it, and reads and writes in flight. The last release evicts it. */
  private holders = new Map<string, number>();
  /** Cached views nobody holds, least recently used first ({@link MAX_UNHELD_VIEWS}). */
  private unheld = new Set<string>();
  /** For each view the host sends deltas for, the generation of this window's latest hold on
   *  it. Kept until the view leaves the cache, never on a resync or gap, so holds mirror `views`. */
  private hostHolds = new Map<string, number>();
  /** Every host hold up to this generation was dropped when the hub started. */
  private releasedThrough = 0;
  /** Each attached frame by the handle `attach` returned, for `seed`'s holder. */
  private handles = new WeakMap<object, Frame>();
  /** Bumped by `dispose`: a read or write that settles later releases nothing it did not hold. */
  private lifetime = 0;
  private hold(key: string) {
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
    this.unheld.delete(key);
  }
  /** Hold `key` for a read or write in flight; the returned release leaves it unheld. */
  private holdWhile(key: string): () => void {
    this.hold(key);
    const lifetime = this.lifetime;
    return () => {
      if (lifetime === this.lifetime) this.release(key, true);
    };
  }
  /** Drop one hold. The last one evicts the view, or, for a read or write that settled
   *  (`keep`), leaves it among the unheld. */
  private release(key: string, keep = false) {
    const count = (this.holders.get(key) ?? 0) - 1;
    if (count > 0) {
      this.holders.set(key, count);
      return;
    }
    this.holders.delete(key);
    if (keep) this.keepUnheld(key);
    else this.evict(key);
  }
  /** Mark an unheld view as just used; past the cap, the least recently used goes. */
  private keepUnheld(key: string) {
    if (this.holders.has(key)) return;
    if (!this.views.has(key)) {
      this.evict(key);
      return;
    }
    this.unheld.delete(key);
    this.unheld.add(key);
    if (this.unheld.size > MAX_UNHELD_VIEWS) this.evict(this.unheld.values().next().value!);
  }
  private evict(key: string) {
    this.unheld.delete(key);
    this.views.delete(key);
    this.pendingReads.delete(key);
    this.uiWrites.delete(key);
    const generation = this.hostHolds.get(key);
    if (generation === undefined) return;
    this.hostHolds.delete(key);
    const [topic, viewKey] = JSON.parse(key) as [string, string];
    // Unheld, the host stops sending sessions deltas, which are what drop the joined read.
    if (topic === "sessions") this.joinedSessionsRead = undefined;
    void this.deps.release?.(topic, viewKey, generation).catch((error) => {
      logger.info("live-hub", `Cannot release ${topic}: ${String(error)}`);
    });
  }
  /** Note the host's hold on a view handed to this window. A hold the start-up release
   *  already dropped is not live, so its view is not cached. */
  private noteHold(key: string, hold: number | undefined): boolean {
    if (hold === undefined) return true;
    if (hold <= this.releasedThrough) return false;
    this.hostHolds.set(key, Math.max(this.hostHolds.get(key) ?? 0, hold));
    return true;
  }
  /** The start-up release dropped every hold up to `through`: a view seeded under one of them
   *  hears no more deltas, so it leaves the cache and its next read holds it again. */
  private releasedHolds(through: number) {
    this.releasedThrough = through;
    for (const [key, generation] of this.hostHolds)
      if (generation <= through) {
        this.hostHolds.delete(key);
        this.views.delete(key);
        this.unheld.delete(key);
      }
  }
  /** Hold exactly the views `frame` reads now: its default topics under its current view
   *  key and the views it seeded. A disposed frame holds none. */
  private syncHolds(frame: Frame) {
    const keys = new Set<string>();
    if (!frame.disposed) {
      for (const key of frame.seeded) keys.add(key);
      for (const topic of frame.defaults) keys.add(keyOf(topic, frameKey(frame, topic)));
    }
    for (const key of frame.held)
      if (!keys.has(key)) {
        frame.held.delete(key);
        this.release(key);
      }
    for (const key of keys)
      if (!frame.held.has(key)) {
        frame.held.add(key);
        this.hold(key);
      }
  }
  constructor(private deps: Dependencies) {}
  private listen(event: string, callback: (event: { payload: unknown }) => void) {
    this.unlisteners.push(
      this.deps.listen(event, callback).catch((error) => {
        logger.info("live-hub", `Cannot listen for ${event}: ${String(error)}`);
        return () => {};
      }),
    );
  }
  /** A native write updates the same cached UI view that dashboard subscribers use. */
  refreshUi(topic: string, viewKey: string): void {
    const current = this.views.get(keyOf(topic, viewKey));
    if (!current) return;
    void (this.uiWrites.get(keyOf(topic, viewKey)) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deps.readUi(keyOf(topic, viewKey)))
      .then((state) => {
        const latest = this.views.get(keyOf(topic, viewKey));
        if (
          latest &&
          JSON.stringify(latest.snapshot[0]) !== JSON.stringify({ ...state, id: topic })
        )
          this.receive({
            topic,
            viewKey,
            rev: latest.rev + 1,
            upserts: [{ ...state, id: topic }],
            removes: [],
          });
      })
      .catch((error) => logger.info("live-hub", `Cannot refresh ${topic}: ${String(error)}`));
  }
  private start() {
    if (this.ready) return this.ready;
    if (this.deps.watchUi)
      this.unlisteners.push(this.deps.watchUi((topic, key) => this.refreshUi(topic, key)));
    this.listen("codesense:delta", (e) => this.receive(e.payload as HubDelta));
    this.listen("codesense:subscription-delta", ({ payload }) => {
      const { subscriptionId, baseRev, delta } = payload as {
        subscriptionId: string;
        baseRev: number | null;
        delta: HubDelta;
      };
      const subscription = this.scoped.get(subscriptionId);
      if (!subscription) return;
      if (!this.delivering(subscription.frame)) {
        // An old in-flight reply must not clear a discarded scoped delta's invalidation.
        if (subscription.read) subscription.retry = true;
        this.stale(subscription.frame);
        return;
      }
      if (subscription.read) {
        const pending = subscription.pending ?? (subscription.pending = []);
        if (pending.length < 256) pending.push({ baseRev, delta });
        else {
          pending.length = 0;
          subscription.retry = true;
        }
        return;
      }
      if (!subscription.value || subscription.value.rev !== baseRev) {
        subscription.stale = true;
        subscription.frame.resync.add(keyOf(delta.topic, delta.viewKey));
        this.schedule();
        return;
      }
      this.envelopes.set(delta, {
        baseRev,
        total: subscription.value.total,
        cursor: subscription.value.cursor,
      });
      this.applyScoped(subscription, delta);
      this.queueDelta(subscription.frame, delta);
      this.schedule();
    });
    const nudges: [event: string, type: string][] = [
      ["agent-inbox-changed", "inbox-changed"],
      ["routines:changed", "routines-changed"],
      ["machines-changed", "machines-changed"],
      ["worktree-changed", "worktrees-changed"],
      ["context-index-changed", "context-changed"],
      ["mcp:agent-message", "agent-activity-changed"],
    ];
    for (const [event, type] of nudges)
      this.listen(event, ({ payload }) => this.invalidate(type, payload));
    // A session's assistant prose as it is written, and one final message per turn, to the
    // frames that watch it (and hold sessions:read). Prose is not a nudge: it is delivered
    // as it comes, never held for a hidden frame to reread.
    this.listen(SESSION_TEXT_EVENT, ({ payload }) => this.sessionText(payload));
    // An agent's session record (tokens, cost, files) moves with its progress and its end, and
    // with usage stored for its session (the host debounces that to about 2 s). Each nudge names
    // its session, so a page reads again only its own agent's record. Commits have no event of
    // their own: a record's files refresh on progress, done and exit.
    for (const event of SESSION_RECORD_EVENTS)
      this.listen(event, ({ payload }) => {
        if (event === "mcp:agent-progress") this.invalidate("agent-activity-changed", payload);
        this.sessionRecordChanged(sessionIdsOf(payload));
      });
    // Any change to orgs, teams or source repos (creating or deleting a team, attaching a
    // context repo, adding a source repo) raises one or more of these; a burst folds into one
    // page event.
    for (const event of [
      ORG_REGISTRY_CHANGED_EVENT,
      "context-attachments-changed",
      SOURCE_REPO_ATTACHMENTS_CHANGED_EVENT,
    ])
      this.listen(event, () => this.setupChanged());
    if (this.deps.watchPasteTarget) {
      const off = this.deps.watchPasteTarget(() => this.invalidate("paste-target-changed"));
      this.unlisteners.push(Promise.resolve(off));
    }
    // A reloaded page's holds are dropped before this hub's first read takes its own.
    const released = this.deps.releaseOwner?.().then(
      (through) => this.releasedHolds(through),
      (error) => logger.info("live-hub", `Cannot release earlier holds: ${String(error)}`),
    );
    this.ready = Promise.all([...this.unlisteners, released]).then(() => {});
    return this.ready;
  }
  /** Tells every page the setup (orgs, teams, source repos) changed, once the burst of
   *  native events has settled; a page rereads `setupState()`. */
  private setupChanged() {
    const now = Date.now();
    this.setupFirstAt ??= now;
    if (this.setupTimer) clearTimeout(this.setupTimer);
    const wait = Math.min(
      SETUP_CHANGED_SETTLE_MS,
      this.setupFirstAt + SETUP_CHANGED_MAX_WAIT_MS - now,
    );
    this.setupTimer = setTimeout(() => {
      this.setupTimer = null;
      this.setupFirstAt = null;
      this.invalidate("setup-changed");
    }, wait);
  }
  private textRouter = createSessionTextRouter();
  private sessionText(payload: unknown) {
    const { sessionId, event } = (payload ?? {}) as { sessionId?: unknown; event?: unknown };
    if (typeof sessionId !== "string" || !event || typeof event !== "object") return;
    for (const message of this.textRouter(sessionId, event as SessionTextEvent)) {
      for (const frame of this.frames.values()) {
        const watch = frame.sessionText.get(sessionId);
        if (frame.disposed || !watch) continue;
        if (!frame.grants.includes(SESSIONS_READ_GRANT)) continue;
        if (watch.turn !== message.turn) watch.heard = new Set();
        watch.turn = message.turn;
        if (message.kind === "prose") {
          if (watch.heard.has(message.key)) continue;
          watch.heard.add(message.key);
        }
        frame.post({ type: "codesense:session-text", ...message });
      }
    }
  }
  /** A gone frame's prose streams stop. */
  private releaseText(frame: Frame) {
    for (const sessionId of frame.sessionText.keys())
      void this.deps.unwatchText?.(sessionId).catch(() => {});
    frame.sessionText.clear();
  }
  private sessionRecordChanged(sessionIds: string[]) {
    // An event that names no session is one every record may have to reread.
    for (const sessionId of sessionIds.length ? sessionIds : [undefined])
      this.invalidate("session-record-changed", { sessionId });
  }
  /** Posts a payloadless (or context/inbox) change nudge to every frame; a hidden frame
   *  holds it until shown, since consumers must reread. */
  private invalidate(type: string, payload?: unknown) {
    if (type === "inbox-changed") this.joinedSessionsRead = undefined;
    const message = {
      type: `codesense:${type}`,
      ...(type === "context-changed"
        ? { orgs: [], allOrgs: true, truncated: true, ...(payload as object) }
        : {}),
      ...(type === "session-record-changed" && sessionIdsOf(payload).length
        ? { sessionId: sessionIdsOf(payload)[0] }
        : {}),
    };
    const changes = type === "inbox-changed" ? inboxChangesOf(payload) : [];
    for (const frame of this.frames.values()) {
      if (type === "setup-changed" && !frame.grants.includes(SETUP_READ_GRANT)) continue;
      // A change that named only other teams' rows tells a team frame nothing.
      if (changes.length && !deliverable(frame, { ...message, changes })) continue;
      if (!frame.visible) {
        // An invalidation can change data outside the delta stream, so consumers must reread.
        // Keep broad inbox changes and named row hints independently: a broad change must
        // not discard the ids a consumer needs to refresh older retained rows.
        const key = type === "inbox-changed" && changes.length ? `${type}:rows` : type;
        const held = frame.invalidations.get(key);
        frame.invalidations.set(
          key,
          type === "context-changed" && held
            ? { ...message, allOrgs: true }
            : type === "session-record-changed" && held && held.sessionId !== message.sessionId
              ? { type: message.type }
              : type === "inbox-changed" && changes.length
                ? {
                    ...message,
                    changes: unionChanges(
                      (held?.changes as InboxChange[] | undefined) ?? [],
                      changes,
                    ),
                  }
                : message,
        );
        // A paste-target flip changes no hub data, so it never makes a hidden page resync.
        if (type === "paste-target-changed") continue;
        if (frame.hiddenLive) this.schedule();
        else this.stale(frame);
        continue;
      }
      if (type === "inbox-changed")
        postDeliverable(frame, changes.length ? { ...message, changes } : message);
      else frame.post(message);
    }
  }
  /** Cache a view read elsewhere. A `holder` frame keeps it until it disposes or rekeys;
   *  without one it is kept among the unheld views. */
  seed(snapshot: HubSnapshot, holder?: HubFrame) {
    const key = keyOf(snapshot.topic, snapshot.viewKey);
    // The hold generation is the hub's to keep; the cached view frames and pages read has none.
    const { hold, ...view } = snapshot;
    if (this.noteHold(key, hold) && (this.views.get(key)?.rev ?? -1) <= view.rev)
      this.views.set(key, view);
    const frame = holder && this.handles.get(holder);
    if (frame && !frame.disposed) {
      frame.seeded.add(key);
      this.syncHolds(frame);
    } else this.keepUnheld(key);
  }
  async joinSessions(rows: HubRow[]): Promise<Array<HubRow | SessionListRow>> {
    if (!this.joinedSessionsRead) {
      const read = this.deps.readSessions!().catch((error) => {
        if (this.joinedSessionsRead === read) this.joinedSessionsRead = undefined;
        throw error;
      });
      this.joinedSessionsRead = read;
    }
    const joined = new Map((await this.joinedSessionsRead).map((row) => [row.handle, row]));
    return rows.map((row) => joined.get(String(row.handle ?? row.id)) ?? row);
  }
  /** Recover one cached view through the same read/delta ordering as a subscription. */
  resync(topic: string, viewKey: string): Promise<HubSnapshot> {
    this.views.delete(keyOf(topic, viewKey));
    this.unheld.delete(keyOf(topic, viewKey));
    return this.snapshot(topic, viewKey);
  }
  async snapshot(topic: string, viewKey: string, sinceRev?: number): Promise<HubSnapshot> {
    await this.start();
    const key = keyOf(topic, viewKey);
    if (topic === "theme")
      return {
        topic,
        viewKey: "all",
        rev: this.themeValue.rev,
        snapshot: [{ id: "theme", ...this.themeValue }],
      };
    const cached = this.views.get(key);
    if (cached) {
      this.keepUnheld(key);
      return cached;
    }
    let read = this.reads.get(key);
    if (!read) {
      // The read holds its view until it settles; nobody else holding it then, it stays unheld.
      const settled = this.holdWhile(key);
      read = (
        topic.startsWith("ui:")
          ? this.deps.readUi(key).then(
              (state): HubSnapshot => ({
                topic,
                viewKey,
                rev: 0,
                snapshot: [{ ...state, id: topic }],
              }),
            )
          : this.deps.read(topic, viewKey, sinceRev)
      )
        .then((result) => {
          if (result.topic !== topic || result.viewKey !== viewKey)
            throw new Error("Unexpected projection reply");
          if (!result.snapshot) {
            this.noteHold(key, result.hold);
            this.reads.delete(key);
            return this.snapshot(topic, viewKey);
          }
          this.seed(result as HubSnapshot);
          this.reads.delete(key);
          const pending = this.pendingReads.get(key) ?? [];
          this.pendingReads.delete(key);
          for (const delta of pending) this.receive(delta);
          if (!this.views.has(key)) return this.snapshot(topic, viewKey, result.rev);
          return this.views.get(key)!;
        })
        .finally(() => {
          this.reads.delete(key);
          settled();
        });
      this.reads.set(key, read);
    }
    return read;
  }
  attach(
    id: string,
    viewKey: string,
    post: Post,
    visible: boolean,
    native = false,
    themeChanged?: () => void,
    delivery: BadgeDelivery = {},
  ) {
    this.start();
    const subscriptionId = (key: string) =>
      `${delivery.owner ? delivery.owner + ":" : ""}${id}:${key}`;
    const frame: Frame = {
      id,
      viewKey,
      grants: delivery.grants ?? [],
      liveBadge: delivery.badge === "live",
      hiddenLive: false,
      shownOrder: ++this.shownOrder,
      disposed: false,
      generation: 0,
      native,
      post: (message) => {
        if (canDeliver(frame, message)) post(message);
      },
      visible,
      stale: false,
      defaults: new Set(themeChanged ? ["theme"] : []),
      themeChanged,
      scoped: new Map(),
      pending: [],
      resync: new Set(),
      waits: [],
      invalidations: new Map(),
      sessionText: new Map(),
      seeded: new Set(),
      held: new Set(),
    };
    this.frames.set(id, frame);
    this.syncHolds(frame);
    this.balanceHidden();
    /** Resync each subscribed view independently. */
    const resyncAll = () => {
      // A view rebind or window move changes the dataset boundary and cannot be folded safely.
      for (const topic of frame.defaults) {
        if (topic === "theme" && frame.themeChanged) frame.themeChanged();
        else frame.post({ type: "codesense:resync", topic, viewKey: frameKey(frame, topic) });
      }
      for (const sub of frame.scoped.values())
        if (sub.viewKey !== undefined)
          frame.post({ type: "codesense:resync", topic: sub.topic, viewKey: sub.viewKey });
    };
    const subscribe = async (topic: string, sinceRev?: number, options?: SubscriptionOptions) => {
      const started = frame.generation;
      if (options?.viewKey === undefined && !options?.order) {
        frame.defaults.add(topic);
        this.syncHolds(frame);
      }
      await this.start();
      if (frame.disposed) throw new Error("frame disposed");
      while (!this.delivering(frame) && !frame.disposed) {
        this.stale(frame);
        await new Promise<void>((resolve) => frame.waits.push(resolve));
      }
      if (frame.disposed) throw new Error("frame disposed");
      const generation = frame.generation;
      if (started !== generation && topic === "agentDefinitions" && options?.viewKey)
        throw new Error("unavailable: subscription scope changed");
      if (started !== generation) sinceRev = undefined;
      const viewKey = subscriptionViewKey(frame, topic, options);
      let result: HubSnapshot;
      let moved = false;
      try {
        if (
          topic === "inbox" ||
          topic === "records" ||
          topic === "stories" ||
          topic === "machineStats" ||
          isRunReviewTopic(topic) ||
          options?.window ||
          viewKey !== undefined
        ) {
          const scopeKey = subscriptionKey(topic, viewKey);
          let subscription = frame.scoped.get(scopeKey);
          if (!subscription) {
            subscription = {
              id: subscriptionId(scopeKey),
              frame,
              topic,
              window:
                options?.window ?? (["records", "stories"].includes(topic) ? [0, 200] : undefined),
              viewKey,
              order: options?.order,
            };
            frame.scoped.set(scopeKey, subscription);
            this.scoped.set(subscription.id, subscription);
          }
          if (
            options?.window &&
            JSON.stringify(subscription.window) !== JSON.stringify(options.window)
          ) {
            subscription.window = options.window;
            moved = true;
            if (subscription.read) await subscription.read;
            if (frame.disposed) throw new Error("frame disposed");
            if (generation !== frame.generation) return subscribe(topic, undefined, options);
            if (this.deps.window && subscription.value) {
              const delta = await this.deps.window(subscription.id, options.window);
              if (generation !== frame.generation) return subscribe(topic, undefined, options);
              if (canDeliver(frame, delta)) this.applyScoped(subscription, delta);
            }
          }
          result = await this.readScoped(subscription, sinceRev);
          if (moved) {
            // Queued deltas up to the moved window's revision describe rows the new window dropped;
            // folding them with newer deltas would put those rows back. A write echo still has to
            // reach the page that is waiting on its requestId, so it goes out without its rows.
            const key = keyOf(topic, subscription.viewKey ?? frameKey(frame, topic));
            const dropped: HubDelta[] = [];
            frame.pending = frame.pending.filter((queued) => {
              const drop = keyOf(queued.topic, queued.viewKey) === key && queued.rev <= result.rev;
              if (drop) dropped.push(queued);
              return !drop;
            });
            for (const queued of dropped)
              if (
                queued.requestId !== undefined ||
                queued.actor !== undefined ||
                queued.kind !== undefined
              )
                frame.post({
                  type: "codesense:delta",
                  ...queued,
                  baseRev: this.envelopes.get(queued)?.baseRev ?? queued.rev - 1,
                  upserts: [],
                  removes: [],
                });
          }
        } else result = await this.snapshot(topic, frameKey(frame, topic), sinceRev);
      } catch (error) {
        if (topic === "agentDefinitions" && generation !== frame.generation) throw error;
        if (!frame.disposed && generation !== frame.generation)
          return subscribe(topic, undefined, options);
        throw error;
      }
      if (!frame.disposed && generation !== frame.generation && topic === "agentDefinitions")
        throw new Error("unavailable: subscription scope changed");
      if (!frame.disposed && generation !== frame.generation)
        return subscribe(topic, undefined, options);
      if (!canDeliver(frame, result)) throw new Error("unavailable: subscription scope changed");
      return result;
    };
    const handle = {
      subscribe,
      /** This frame hears `sessionId`'s assistant prose; the bridge checked its grant and team.
       *  One host watch per frame and session, however often the page asks. */
      watchText: async (sessionId: string) => {
        if (frame.disposed || frame.sessionText.has(sessionId)) return;
        frame.sessionText.set(sessionId, { turn: "", heard: new Set() });
        try {
          await this.deps.watchText?.(sessionId);
        } catch (error) {
          frame.sessionText.delete(sessionId);
          throw error;
        }
      },
      unwatchText: async (sessionId: string) => {
        if (!frame.sessionText.delete(sessionId)) return;
        await this.deps.unwatchText?.(sessionId);
      },
      unsubscribe: async (topic: string, selector?: ViewSelector) => {
        const scopedViewKey = subscriptionViewKey(frame, topic, selector);
        const scopeKey = subscriptionKey(topic, scopedViewKey);
        const subscription = frame.scoped.get(scopeKey);
        let retired: Promise<void> | undefined;
        if (subscription) {
          this.scoped.delete(subscription.id);
          frame.scoped.delete(scopeKey);
          retired = this.releaseAfterRead(subscription);
        }
        if (scopedViewKey === undefined) {
          frame.defaults.delete(topic);
          this.syncHolds(frame);
        }
        frame.resync.delete(keyOf(topic, scopedViewKey ?? frameKey(frame, topic)));
        frame.pending = frame.pending.filter(
          (d) => d.topic !== topic || (scopedViewKey && d.viewKey !== scopedViewKey),
        );
        await retired;
      },
      page: async (
        topic: string,
        cursor: string,
        selector?: ViewSelector,
      ): Promise<HubSnapshot> => {
        while (!this.delivering(frame) && !frame.disposed) {
          this.stale(frame);
          await new Promise<void>((resolve) => frame.waits.push(resolve));
        }
        if (frame.disposed) throw new Error("frame disposed");
        const scopedViewKey = subscriptionViewKey(frame, topic, selector);
        const subscription = frame.scoped.get(subscriptionKey(topic, scopedViewKey));
        if (!subscription || !this.deps.page) throw new Error("subscription unavailable");
        const page = await this.deps.page(subscription.id, cursor);
        if (this.scoped.get(subscription.id) !== subscription || !canDeliver(frame, page))
          throw new Error("unavailable: subscription scope changed");
        if (
          (topic === "records" || topic === "files" || topic === "stories") &&
          subscription.window
        )
          subscription.window = [
            subscription.window[0],
            subscription.window[1] + page.snapshot.length,
          ];
        if (subscription.value) {
          const current = subscription.value;
          subscription.value = {
            ...(page.rev > current.rev ? page : current),
            cursor: page.cursor,
            snapshot: orderedRows(topic, [
              ...new Map(
                [...page.snapshot, ...current.snapshot].map((row) => [row.id, row]),
              ).values(),
            ]),
          };
        }
        return page;
      },
      visible: (shown: boolean) => {
        if (frame.visible === shown) return;
        frame.visible = shown;
        if (shown) frame.shownOrder = ++this.shownOrder;
        this.balanceHidden();
        if (!shown) {
          if (!frame.hiddenLive) this.pause(frame);
          return;
        }
        if (frame.hiddenTimer) clearTimeout(frame.hiddenTimer);
        frame.hiddenTimer = undefined;
        frame.pending = [];
        frame.stale = false;
        for (const message of frame.invalidations.values()) postDeliverable(frame, message);
        frame.invalidations.clear();
        resyncAll();
        frame.waits.splice(0).forEach((resolve) => resolve());
      },
      writeUi: async (topic: string, patch: Record<string, unknown>, requestId?: string) => {
        const value = await this.writeUi(topic, frameKey(frame, topic), patch, requestId);
        if (!canDeliver(frame, value)) throw new Error("unavailable: subscription scope changed");
        return value;
      },
      /** Moves the frame's subscriptions to a new view key (a re-bound grant) and asks the
       *  page to resync every topic it reads. The synchronous handoff rotates the page's
       *  token after keys advance and before any new-scope notifications are posted. */
      rekey: (next: string, beforeResync?: () => void, grants?: readonly string[]) => {
        if (frame.disposed) return;
        frame.generation++;
        frame.viewKey = next;
        if (grants) frame.grants = grants;
        frame.resync.clear();
        frame.pending = [];
        const filesToResync: string[] = [];
        // Prepared records views stay bound; file views follow the new team.
        for (const [key, subscription] of [...frame.scoped]) {
          if (
            subscription.viewKey &&
            !subscription.order &&
            subscription.topic !== "files" &&
            subscription.topic !== "agentDefinitions"
          )
            continue;
          if (subscription.topic === "files" && subscription.viewKey)
            filesToResync.push(
              next + subscription.viewKey.slice(subscription.viewKey.indexOf("|")),
            );
          this.scoped.delete(subscription.id);
          frame.scoped.delete(key);
          void this.deps.unsubscribe?.(subscription.id).catch(() => {});
          if (subscription.topic === "agentDefinitions") frame.defaults.add(subscription.topic);
          if (subscription.order) {
            const viewKey = subscriptionViewKey(frame, subscription.topic, subscription);
            const nextKey = subscriptionKey(subscription.topic, viewKey);
            const rebound: ScopedSubscription = {
              id: subscriptionId(nextKey),
              frame,
              topic: subscription.topic,
              window: subscription.window,
              viewKey,
              order: subscription.order,
            };
            frame.scoped.set(nextKey, rebound);
            this.scoped.set(rebound.id, rebound);
          }
        }
        // The old key's views are released: the frame reads its defaults under the new key,
        // and a view it seeded belonged to the old scope.
        frame.seeded.clear();
        this.syncHolds(frame);
        beforeResync?.();
        if (frame.visible) {
          resyncAll();
          for (const viewKey of filesToResync)
            frame.post({ type: "codesense:resync", topic: "files", viewKey });
        } else if (frame.hiddenLive) {
          this.queueResync(frame);
          for (const viewKey of filesToResync) frame.resync.add(keyOf("files", viewKey));
          this.schedule();
        } else this.stale(frame);
      },
      dispose: () => {
        frame.generation++;
        frame.disposed = true;
        if (frame.hiddenTimer) clearTimeout(frame.hiddenTimer);
        frame.hiddenTimer = undefined;
        frame.waits.splice(0).forEach((resolve) => resolve());
        if (this.frames.get(id) === frame) this.frames.delete(id);
        for (const subscription of frame.scoped.values()) {
          this.scoped.delete(subscription.id);
          if (isRunReviewTopic(subscription.topic)) {
            void this.releaseAfterRead(subscription);
          } else void this.deps.unsubscribe?.(subscription.id).catch(() => {});
        }
        frame.scoped.clear();
        this.syncHolds(frame);
        this.releaseText(frame);
        if (!this.frames.size && this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.balanceHidden();
      },
    };
    this.handles.set(handle, frame);
    return handle;
  }
  private applyScoped(subscription: ScopedSubscription, delta: HubDelta) {
    subscription.value = patchRows(subscription.value, delta, {
      topic: delta.topic,
      viewKey: delta.viewKey,
      rev: delta.rev,
      total: delta.total ?? subscription.value?.total,
      cursor:
        delta.topic === "records" || delta.topic === "files" || delta.topic === "stories"
          ? (delta.cursor ?? undefined)
          : subscription.value?.cursor,
    });
  }
  private releaseAfterRead(subscription: ScopedSubscription): Promise<void> {
    return Promise.resolve(subscription.read)
      .catch(() => {})
      .then(() => this.deps.unsubscribe?.(subscription.id))
      .catch(() => {});
  }
  private readScoped(subscription: ScopedSubscription, sinceRev?: number): Promise<HubSnapshot> {
    if (subscription.read) return subscription.read;
    if (subscription.value && !subscription.stale) return Promise.resolve(subscription.value);
    subscription.read = Promise.resolve(subscription.paused)
      .then(() =>
        this.deps.read(
          subscription.topic,
          subscription.viewKey ?? subscription.frame.viewKey,
          sinceRev ??
            (isRunReviewTopic(subscription.topic) || isConfigurationTopic(subscription.topic)
              ? subscription.value?.rev
              : undefined),
          {
            subscriptionId: subscription.id,
            window: subscription.window,
            // The host drops the frame's subscriptions when the frame is released.
            frameId: subscription.frame.id,
          },
        ),
      )
      .then(async (reply) => {
        if (subscription.frame.disposed || this.scoped.get(subscription.id) !== subscription) {
          await this.deps.unsubscribe?.(subscription.id).catch(() => {});
          throw new Error("subscription retired");
        }
        if (!canDeliver(subscription.frame, reply))
          throw new Error("unavailable: subscription scope changed");
        if (reply.snapshot) subscription.value = { ...reply, snapshot: reply.snapshot };
        else for (const delta of reply.deltas ?? []) this.applyScoped(subscription, delta);
        if (!subscription.value) throw new Error("snapshot unavailable");
        subscription.stale = !this.delivering(subscription.frame) || (subscription.retry ?? false);
        subscription.retry = false;
        for (const { baseRev, delta } of subscription.pending?.splice(0) ?? []) {
          if (baseRev === null) {
            subscription.stale = true;
            break;
          }
          if (delta.rev <= subscription.value.rev) continue;
          if (baseRev !== subscription.value.rev) {
            subscription.stale = true;
            break;
          }
          this.applyScoped(subscription, delta);
        }
        return subscription.value;
      })
      .finally(() => {
        subscription.read = undefined;
        if (
          subscription.stale &&
          this.delivering(subscription.frame) &&
          !subscription.frame.disposed
        ) {
          const frame = subscription.frame;
          const viewKey = subscription.viewKey ?? frame.viewKey;
          if (frame.visible)
            frame.post({ type: "codesense:resync", topic: subscription.topic, viewKey });
          else {
            // Architecture: read recovery shares the hidden frame's throttled delivery path.
            frame.resync.add(keyOf(subscription.topic, viewKey));
            this.schedule();
          }
        }
      });
    return subscription.read;
  }
  private stale(frame: Frame) {
    if (frame.stale) return;
    frame.stale = true;
    frame.post({ type: "codesense:stale" });
  }
  receive(delta: HubDelta) {
    if (delta.topic === "sessions") this.joinedSessionsRead = undefined;
    const key = keyOf(delta.topic, delta.viewKey);
    const current = this.views.get(key);
    if (!current && this.reads.has(key)) {
      const pending = this.pendingReads.get(key) ?? [];
      if (pending.length < 256) pending.push(delta);
      else pending.splice(0, pending.length, delta);
      this.pendingReads.set(key, pending);
      return;
    }
    if (current && delta.rev <= current.rev) return;
    // Frames, the hidden fold and watch callbacks see only full rows.
    const full =
      current && delta.rev === current.rev + 1 ? withFullRows(current, delta) : undefined;
    const gap = !full;
    if (gap) {
      // A held view is read again by its holders; an unheld one leaves the cache, and so
      // releases its host hold, since nothing would re-read it.
      if (this.holders.has(key)) {
        this.views.delete(key);
        this.unheld.delete(key);
      } else this.evict(key);
    } else
      this.views.set(
        key,
        patchRows(current, full, { topic: delta.topic, viewKey: delta.viewKey, rev: delta.rev }),
      );
    for (const frame of this.frames.values()) {
      if (
        frameKey(frame, delta.topic) !== delta.viewKey ||
        !frame.defaults.has(delta.topic) ||
        frame.scoped.has(delta.topic)
      )
        continue;
      if (!this.delivering(frame)) {
        this.stale(frame);
        continue;
      }
      if (delta.topic === "theme" && frame.themeChanged) {
        frame.themeChanged();
        continue;
      }
      this.queueDelta(frame, full ?? delta, gap);
    }
    this.schedule();
  }
  private queueDelta(frame: Frame, delta: HubDelta, gap = false) {
    const key = keyOf(delta.topic, delta.viewKey);
    if (gap || frame.pending.length >= 256) {
      // A gap loses rows; overflow discards the batch. In either case invalidate every queued view.
      for (const queued of frame.pending) frame.resync.add(keyOf(queued.topic, queued.viewKey));
      frame.pending = [];
      frame.resync.add(key);
    } else if (!frame.resync.has(key)) frame.pending.push(delta);
  }
  private delivering(frame: Frame) {
    return frame.visible || frame.hiddenLive;
  }
  private pause(frame: Frame) {
    for (const subscription of frame.scoped.values()) {
      subscription.stale = true;
      if (subscription.topic === "machineStats")
        void this.deps.unsubscribe?.(subscription.id).catch(() => {});
      if (isRunReviewTopic(subscription.topic) || isConfigurationTopic(subscription.topic)) {
        subscription.paused = Promise.resolve(subscription.read)
          .catch(() => {})
          .then(async () => {
            if (!this.delivering(frame))
              await this.deps.unsubscribe?.(subscription.id, isRunReviewTopic(subscription.topic));
          });
      }
    }
    frame.pending = [];
    this.stale(frame);
  }
  private queueResync(frame: Frame) {
    for (const topic of frame.defaults) frame.resync.add(keyOf(topic, frameKey(frame, topic)));
    for (const sub of frame.scoped.values())
      frame.resync.add(keyOf(sub.topic, sub.viewKey ?? frameKey(frame, sub.topic)));
  }
  private balanceHidden() {
    // Policy: retain the four most recently shown frames; evict the oldest-shown first.
    const admitted = new Set(
      [...this.frames.values()]
        .filter((frame) => !frame.visible && frame.liveBadge && !frame.disposed)
        .sort((a, b) => b.shownOrder - a.shownOrder)
        .slice(0, MAX_LIVE_HIDDEN_FRAMES),
    );
    for (const frame of this.frames.values()) {
      const wasLive = frame.hiddenLive;
      frame.hiddenLive = admitted.has(frame);
      if (wasLive && !frame.hiddenLive) {
        if (frame.hiddenTimer) clearTimeout(frame.hiddenTimer);
        frame.hiddenTimer = undefined;
        if (!frame.visible) this.pause(frame);
      }
      if (!wasLive && frame.hiddenLive) {
        if (frame.stale) {
          this.queueResync(frame);
          frame.stale = false;
        }
        frame.waits.splice(0).forEach((resolve) => resolve());
      }
    }
    this.schedule();
  }
  private flush(frame: Frame) {
    const topics = new Map<string, HubDelta[]>();
    for (const d of frame.pending.splice(0)) {
      const key = keyOf(d.topic, d.viewKey);
      topics.set(key, [...(topics.get(key) ?? []), d]);
    }
    for (const [topic, deltas] of topics) {
      if (frame.resync.has(topic)) continue;
      let run: HubDelta[] = [];
      let last: HubDelta | undefined;
      const baseOf = (delta: HubDelta) => this.envelopes.get(delta)?.baseRev ?? delta.rev - 1;
      const postDelta = (delta: HubDelta) =>
        frame.post({
          type: "codesense:delta",
          ...delta,
          ...(baseOf(delta) !== delta.rev - 1 && { baseRev: baseOf(delta) }),
        });
      const flushRun = () => {
        if (!run.length) return;
        if (run.length === 1) postDelta(run[0]);
        else {
          // A run must be contiguous so the receiver can prove continuity from baseRev.
          const upserts = new Map<string, HubRow>();
          const removes = new Set<string>();
          for (const delta of run) {
            for (const id of delta.removes) {
              upserts.delete(id);
              removes.add(id);
            }
            for (const row of delta.upserts) {
              removes.delete(rowId(row));
              upserts.delete(rowId(row));
              upserts.set(rowId(row), row);
            }
          }
          frame.post({
            type: "codesense:delta",
            ...run.at(-1)!,
            baseRev: baseOf(run[0]),
            upserts: [...upserts.values()],
            removes: [...removes],
          });
        }
        run = [];
      };
      for (const delta of deltas) {
        // The host may suppress revisions, so continuity is the envelope base meeting the last rev.
        if (last && baseOf(delta) !== last.rev) {
          // A revision gap means intermediate rows are missing; request a fresh snapshot.
          flushRun();
          frame.resync.add(topic);
          break;
        }
        last = delta;
        const prior = this.envelopes.get(delta);
        const metadataChanged =
          delta.requestId !== undefined ||
          delta.actor !== undefined ||
          delta.kind !== undefined ||
          (delta.cursor !== undefined &&
            (!prior || (delta.cursor ?? undefined) !== (prior.cursor ?? undefined))) ||
          (delta.total !== undefined && (!prior || delta.total !== prior.total));
        if (metadataChanged) {
          flushRun();
          postDelta(delta);
        } else run.push(delta);
      }
      if (!frame.resync.has(topic)) flushRun();
    }
    for (const key of frame.resync) {
      const [topic, viewKey] = JSON.parse(key) as [string, string];
      frame.post({ type: "codesense:resync", topic, viewKey });
    }
    frame.resync.clear();
    for (const message of frame.invalidations.values()) postDeliverable(frame, message);
    frame.invalidations.clear();
  }
  private schedule() {
    for (const frame of this.frames.values()) {
      if (!frame.pending.length && !frame.resync.size && !frame.invalidations.size) continue;
      if (frame.hiddenLive) {
        if (frame.hiddenTimer) continue;
        frame.hiddenTimer = setTimeout(() => {
          frame.hiddenTimer = undefined;
          if (!frame.disposed && frame.hiddenLive) this.flush(frame);
        }, LIVE_HIDDEN_THROTTLE_MS);
      } else if (frame.visible && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          for (const visible of this.frames.values()) if (visible.visible) this.flush(visible);
        }, 0);
      }
    }
  }
  writeUi(
    topic: string,
    viewKey: string,
    patch: Record<string, unknown>,
    requestId?: string,
  ): Promise<HubSnapshot> {
    if (!topic.startsWith("ui:"))
      return Promise.reject(new Error("writeUi needs a ui:<slotId> topic"));
    const key = keyOf(topic, viewKey);
    const prior = this.uiWrites.get(key) ?? Promise.resolve();
    // The write holds its view until it settles, so the view it resolves with is still there.
    const settled = this.holdWhile(key);
    const next: Promise<HubSnapshot> = prior
      .catch(() => {})
      .then(async () => {
        try {
          return await this.writeUiNow(topic, viewKey, key, patch, requestId);
        } finally {
          if (this.uiWrites.get(key) === next) this.uiWrites.delete(key);
          settled();
        }
      });
    this.uiWrites.set(key, next);
    return next;
  }
  private async writeUiNow(
    topic: string,
    viewKey: string,
    key: string,
    patch: Record<string, unknown>,
    requestId?: string,
  ): Promise<HubSnapshot> {
    const before = await this.snapshot(topic, viewKey);
    const state = await this.deps.writeUi(key, patch);
    await new Promise<void>((resolve) => {
      this.uiTimers.set(
        key,
        setTimeout(() => {
          this.uiTimers.delete(key);
          this.receive({
            topic,
            viewKey,
            rev: before.rev + 1,
            upserts: [{ ...state, id: topic }],
            removes: [],
            requestId,
          });
          resolve();
        }, 50),
      );
    });
    return this.views.get(key)!;
  }
  /** A native subscription: `callback` gets the view on subscribe and after each
   *  change, with the delta that changed it when one did (not on a resync). */
  watch(
    topic: string,
    viewKey: string,
    callback: (snapshot: HubSnapshot, change?: HubDelta) => void,
    options?: SubscriptionOptions,
  ): () => void {
    const id = `native:${crypto.randomUUID()}`;
    const frame = this.attach(
      id,
      viewKey,
      (message) => {
        if (message.topic !== topic) return;
        const change = message.type === "codesense:delta" ? (message as HubDelta) : undefined;
        void frame
          .subscribe(topic, undefined, options)
          .then((snapshot) => callback(snapshot, change))
          .catch((error) => {
            logger.info("live-hub", `Cannot resync ${topic}: ${String(error)}`);
          });
      },
      true,
      true,
    );
    void frame
      .subscribe(topic, undefined, options)
      .then((snapshot) => callback(snapshot))
      .catch(() => {});
    return frame.dispose;
  }
  dispose() {
    for (const off of this.unlisteners) void off.then((fn) => fn()).catch(() => {});
    if (this.timer) clearTimeout(this.timer);
    if (this.setupTimer) clearTimeout(this.setupTimer);
    for (const timer of this.uiTimers.values()) clearTimeout(timer);
    for (const frame of this.frames.values()) {
      if (frame.hiddenTimer) clearTimeout(frame.hiddenTimer);
      frame.disposed = true;
      // The hub forgets every hold below, so no frame keeps a key it no longer counts.
      frame.held.clear();
      frame.seeded.clear();
      this.releaseText(frame);
      frame.waits.splice(0).forEach((resolve) => resolve());
    }
    for (const subscription of this.scoped.values())
      void this.deps.unsubscribe?.(subscription.id).catch(() => {});
    this.frames.clear();
    this.scoped.clear();
    this.unlisteners = [];
    this.ready = null;
    this.joinedSessionsRead = undefined;
    this.views.clear();
    this.reads.clear();
    this.pendingReads.clear();
    this.uiWrites.clear();
    this.holders.clear();
    this.unheld.clear();
    this.hostHolds.clear();
    this.releasedThrough = 0;
    this.lifetime++;
    this.uiTimers.clear();
    this.timer = null;
  }
}
export const liveHub = new LiveHub({
  readSessions: async () => agentReadSessions(),
  read: async (...args) => liveHubSubscribe(...args),
  page: async (...args) => liveHubPage(...args),
  window: async (...args) => liveHubWindow(...args),
  unsubscribe: async (...args) => {
    await liveHubUnsubscribe(...args);
  },
  release: async (...args) => liveHubRelease(...args),
  releaseOwner: async () => liveHubReleaseOwner(),
  listen,
  readUi: readSharedUiState,
  writeUi: writeSharedUiState,
  watchUi: watchSharedUiState,
  // Read when called, so a test that mocks the commands without these still loads the hub.
  watchText: (sessionId) => sessionTextWatch(sessionId),
  unwatchText: (sessionId) => sessionTextUnwatch(sessionId),
  // Loaded when the hub starts: a static import of send-to-terminal (which reaches the viewer
  // and org stores) puts live-hub in their import cycle and breaks the app's boot order.
  watchPasteTarget: (changed) => {
    let off: UnlistenFn | undefined,
      stopped = false;
    void import("@/shared/lib/send-to-terminal")
      .then(({ subscribePasteTarget }) => {
        if (!stopped) off = subscribePasteTarget(changed);
      })
      .catch((error) => logger.info("live-hub", `Cannot watch the paste target: ${String(error)}`));
    return () => {
      stopped = true;
      off?.();
    };
  },
});
export type HubFrame = ReturnType<LiveHub["attach"]>;
