// SPDX-License-Identifier: MIT
/**
 * The status line: one line in the title bar that any feature or agent posts to, so what the app
 * and agents just did shows in one place and can be undone or acted on. Plain module state read
 * through React's external-store hook, like `tray-move-announcement.ts`, so `StatusLine` is its
 * only subscriber and a post never re-renders the rest of the title bar.
 *
 * Rules:
 * - A line shows for 6 s; a line of kind `undo` shows for 10 s. Hover, focus inside the line and
 *   its open menu pause the timer, which resumes with the time left. Timers keep counting while
 *   the window is blurred or hidden.
 * - An `undo` line wins: it preempts whatever shows (that line waits again with its time left),
 *   and a newer `undo` line replaces an older one.
 * - Offers wait behind "+N waiting": at most 3 (the oldest drops). Every waiting line, offer or
 *   not, waits at most 60 s, and its own 6 s start when it first shows. Announcements, `info` and
 *   `progress` lines queue in the order posted. The next line to show is the earliest posted.
 * - A post whose `key` is waiting or showing replaces that line; a `progress` line updated by key
 *   changes in place and its 6 s count from the update.
 * - A line closes once its action runs; a second run is a no-op.
 * - `holdStatusLine()` hides every line and pauses the timers; under a hold only the line keyed
 *   `hint` shows (kind `info`, no timer). `releaseStatusLine()` brings the line back with its time
 *   left and the queue intact.
 * - The queue belongs to the app session: nothing about a team or workspace clears it.
 *
 * Each line is announced once, in one polite live region, when it first shows: a line queued or
 * preempted before it showed is announced when it shows, an in-place `progress` update is not
 * announced again, and the hint is announced once per distinct text.
 */

import { useSyncExternalStore } from "react";

export type StatusLineKind = "undo" | "offer" | "announcement" | "progress" | "info";

/** What a line's button does. `keyHint` is display text for a key pill after the label. */
export interface StatusLineAction {
  label: string;
  run: () => void | Promise<void>;
  keyHint?: string;
}

export interface StatusLinePost {
  key?: string;
  text: string;
  kind: StatusLineKind;
  action?: StatusLineAction;
}

/** A posted line. `id` tells two posts apart. */
export interface StatusLineEntry {
  id: number;
  key?: string;
  text: string;
  kind: StatusLineKind;
  action?: StatusLineAction;
}

/** One text for the live region. `seq` tells two identical texts apart. */
export interface StatusLineAnnouncement {
  text: string;
  seq: number;
}

export interface StatusLineState {
  /** The line that shows: the hint under a hold, else the current line, else null. */
  line: StatusLineEntry | null;
  /** Offers waiting behind the current line, oldest first. */
  waiting: readonly StatusLineEntry[];
  held: boolean;
  /** The live region's latest texts, oldest first. */
  announcements: readonly StatusLineAnnouncement[];
}

/** The key of the hint line shown under a hold. */
export const STATUS_LINE_HINT_KEY = "hint";
export const STATUS_LINE_MS = 6_000;
export const STATUS_LINE_UNDO_MS = 10_000;
export const STATUS_LINE_OFFER_WAIT_MS = 60_000;
export const STATUS_LINE_MAX_WAITING = 3;
/** How many recent texts the live region keeps. */
const ANNOUNCEMENTS_KEPT = 3;

/** Why the timer is paused, e.g. `hover`, `focus`, `menu`; the hold adds `hold`. */
export type StatusLinePauseReason = "hover" | "focus" | "menu" | "hold";

interface Line extends StatusLineEntry {
  /** Time left to show, null before it first shows. */
  remaining: number | null;
  announced: boolean;
  /** When a waiting offer drops, epoch ms. */
  expiresAt?: number;
}

let nextId = 0;
let current: Line | null = null;
/** When `current`'s timer last started, while it runs. */
let runningSince: number | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let offers: Line[] = [];
let queue: Line[] = [];
let hint: Line | null = null;
let held = false;
let lastHintText: string | null = null;
let announcements: StatusLineAnnouncement[] = [];
let announceSeq = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const paused = new Set<StatusLinePauseReason>();

const listeners = new Set<() => void>();
let snapshot: StatusLineState = buildSnapshot();

function buildSnapshot(): StatusLineState {
  return {
    line: entry(held ? hint : current),
    waiting: offers.map((o) => entry(o)!),
    held,
    announcements,
  };
}

function entry(line: Line | null): StatusLineEntry | null {
  if (!line) return null;
  const { id, key, text, kind, action } = line;
  return { id, ...(key !== undefined ? { key } : {}), text, kind, ...(action ? { action } : {}) };
}

function announce(text: string) {
  announceSeq += 1;
  announcements = [...announcements, { text, seq: announceSeq }].slice(-ANNOUNCEMENTS_KEPT);
}

/** Announce what newly shows, rebuild the snapshot and tell the subscriber. */
function notify() {
  if (held) {
    if (hint && hint.text !== lastHintText) {
      lastHintText = hint.text;
      announce(hint.text);
    }
  } else if (current && !current.announced) {
    current.announced = true;
    announce(current.text);
  }
  snapshot = buildSnapshot();
  listeners.forEach((l) => l());
}

const durationOf = (kind: StatusLineKind) =>
  kind === "undo" ? STATUS_LINE_UNDO_MS : STATUS_LINE_MS;

function stopTimer() {
  if (showTimer !== null) clearTimeout(showTimer);
  showTimer = null;
  if (current && runningSince !== null && current.remaining !== null)
    current.remaining = Math.max(0, current.remaining - (Date.now() - runningSince));
  runningSince = null;
}

function startTimer() {
  if (!current || paused.size > 0 || showTimer !== null) return;
  current.remaining ??= durationOf(current.kind);
  runningSince = Date.now();
  showTimer = setTimeout(() => {
    showTimer = null;
    runningSince = null;
    current = null;
    showNext();
    notify();
  }, current.remaining);
}

/** Show `line` as the current line; the caller has stopped the old one. */
function show(line: Line) {
  delete line.expiresAt;
  current = line;
  startTimer();
}

const byId = (a: Line, b: Line) => a.id - b.id;

function enqueue(line: Line) {
  line.expiresAt = Date.now() + STATUS_LINE_OFFER_WAIT_MS;
  if (line.kind === "offer") {
    offers = [...offers, line].sort(byId);
    if (offers.length > STATUS_LINE_MAX_WAITING) offers = offers.slice(-STATUS_LINE_MAX_WAITING);
    scheduleExpiry();
  } else {
    queue = [...queue, line].sort(byId);
  }
  scheduleExpiry();
}

/** Show the earliest posted waiting line, if any. */
function showNext() {
  const next = [queue[0], offers[0]].filter(Boolean).sort(byId)[0];
  if (!next) return;
  if (next === queue[0]) queue = queue.slice(1);
  else offers = offers.slice(1);
  show(next);
  scheduleExpiry();
}

function scheduleExpiry() {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const waitingLines = [...offers, ...queue];
  if (waitingLines.length === 0) return;
  const soonest = Math.min(...waitingLines.map((o) => o.expiresAt ?? Infinity));
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      const now = Date.now();
      const live = (o: Line) => (o.expiresAt ?? Infinity) > now;
      offers = offers.filter(live);
      queue = queue.filter(live);
      scheduleExpiry();
      notify();
    },
    Math.max(0, soonest - Date.now()),
  );
}

/** Take the line `id` out of wherever it is. Returns it, or null when it is gone. */
function take(id: number): Line | null {
  if (current?.id === id) {
    const line = current;
    stopTimer();
    current = null;
    showNext();
    return line;
  }
  if (hint?.id === id) {
    const line = hint;
    hint = null;
    lastHintText = null;
    return line;
  }
  const line = offers.find((o) => o.id === id) ?? queue.find((q) => q.id === id) ?? null;
  if (!line) return null;
  offers = offers.filter((o) => o !== line);
  queue = queue.filter((q) => q !== line);
  scheduleExpiry();
  return line;
}

function waitingWithKey(key: string): Line | null {
  return offers.find((o) => o.key === key) ?? queue.find((q) => q.key === key) ?? null;
}

/** Post a line. Returns its id. */
export function postStatusLine(post: StatusLinePost): number {
  nextId += 1;
  const { key, text, action } = post;
  if (key === STATUS_LINE_HINT_KEY) {
    hint = { id: nextId, key, text, kind: "info", action, remaining: null, announced: false };
    notify();
    return nextId;
  }
  const line: Line = {
    id: nextId,
    key,
    text,
    kind: post.kind,
    action,
    remaining: null,
    announced: false,
  };

  if (key !== undefined) {
    const progressUpdate = post.kind === "progress";
    const isProgress = (l: Line) => l.kind === "progress" && progressUpdate;
    if (current?.key === key && isProgress(current)) {
      stopTimer();
      Object.assign(current, { text, action, remaining: STATUS_LINE_MS });
      startTimer();
      notify();
      return current.id;
    }
    const same = waitingWithKey(key);
    if (same && isProgress(same)) {
      Object.assign(same, { text, action });
      notify();
      return same.id;
    }
    if (same) take(same.id);
    if (current?.key === key) {
      stopTimer();
      current = null;
    }
  }

  if (!current) {
    show(line);
  } else if (line.kind === "undo") {
    const old = current;
    stopTimer();
    current = null;
    if (old.kind !== "undo") enqueue(old);
    show(line);
  } else {
    enqueue(line);
  }
  notify();
  return line.id;
}

/** Remove the line posted with `key`, showing or waiting. */
export function clearStatusLine(key: string): void {
  const line =
    key === STATUS_LINE_HINT_KEY ? hint : current?.key === key ? current : waitingWithKey(key);
  if (!line) return;
  take(line.id);
  notify();
}

/** Run the line `id`'s action once and close the line. A line already gone is a no-op. */
export function runStatusLineAction(id: number): void {
  const line = take(id);
  if (!line) return;
  notify();
  try {
    // A rejected action is the poster's to report: it posts its own line.
    void Promise.resolve(line.action?.run()).catch(() => {});
  } catch {
    // A throwing action is the poster's to report, too.
  }
}

/** Close the line `id` without running its action. */
export function dismissStatusLine(id: number): void {
  if (take(id)) notify();
}

/** Pause the current line's timer for `reason`, until it is resumed. */
export function pauseStatusLine(reason: StatusLinePauseReason): void {
  if (paused.has(reason)) return;
  paused.add(reason);
  stopTimer();
}

/** Resume the timer `reason` paused: it runs again with the time left once nothing pauses it. */
export function resumeStatusLine(reason: StatusLinePauseReason): void {
  if (!paused.delete(reason)) return;
  startTimer();
}

/** Hide every line and pause the timers; only the `hint` line shows until released. */
export function holdStatusLine(): void {
  if (held) return;
  held = true;
  pauseStatusLine("hold");
  notify();
}

/** End the hold: the current line comes back with its time left, the queue intact. */
export function releaseStatusLine(): void {
  if (!held) return;
  held = false;
  resumeStatusLine("hold");
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStatusLineState(): StatusLineState {
  return snapshot;
}

/** The status line's state, for `StatusLine`, its only subscriber. */
export function useStatusLine(): StatusLineState {
  return useSyncExternalStore(subscribe, getStatusLineState);
}

/** Drop every line, timer and pause, for tests. */
export function resetStatusLineForTests(): void {
  if (showTimer !== null) clearTimeout(showTimer);
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  showTimer = expiryTimer = runningSince = null;
  current = hint = lastHintText = null;
  offers = [];
  queue = [];
  held = false;
  announcements = [];
  paused.clear();
  snapshot = buildSnapshot();
  listeners.forEach((l) => l());
}
