// SPDX-License-Identifier: MIT
/**
 * Which hidden tile bodies a window's tile host lets go. The host keeps at most
 * `tileKeepAliveMaxHidden` hidden bodies, least recently shown out first, and never evicts a
 * protected one: a pin, a key the caller keeps (a cell's active tab) or a key a registered keep
 * predicate names (a file with an unsaved edit, an agent that needs you). Protected bodies count
 * toward the cap; when they alone exceed it every other hidden body goes and the pass stops.
 *
 * A visible body is never hidden, so it is never a candidate. A hidden body's frames still count
 * against the frame budget, which applies its own cap; this policy adds none to it.
 */
import { VIEWER_PERF } from "../lib/viewer-perf-config";

export interface KeepAliveInput {
  /** The hidden bodies' keys, least recently shown first. */
  hidden: readonly string[];
  /** How many hidden bodies to keep. Default `tileKeepAliveMaxHidden`. */
  cap?: number;
  /** The window's pinned tile keys. Default none. */
  pins?: ReadonlySet<string>;
  /** Keys the caller never lets go, such as each cell's active tab. */
  keep?: (key: string) => boolean;
}

type KeepPredicate = (key: string) => boolean;

const predicates = new Set<KeepPredicate>();

/** Registers a predicate whose keys are never evicted. Returns its unregister. */
export function registerKeepPredicate(predicate: KeepPredicate): () => void {
  predicates.add(predicate);
  return () => {
    predicates.delete(predicate);
  };
}

/** Whether a registered keep predicate names `key`. */
export function isKeptByPredicate(key: string): boolean {
  for (const predicate of predicates) if (predicate(key)) return true;
  return false;
}

/** Forgets every registered predicate, so a test starts with none. */
export function resetKeepPredicatesForTests(): void {
  predicates.clear();
}

/** The hidden bodies to evict, least recent first, in one pass. */
export function evictHidden({
  hidden,
  cap = VIEWER_PERF.tileKeepAliveMaxHidden,
  pins,
  keep,
}: KeepAliveInput): string[] {
  let excess = hidden.length - cap;
  const evicted: string[] = [];
  for (const key of hidden) {
    if (excess <= 0) break;
    if (pins?.has(key) || keep?.(key) || isKeptByPredicate(key)) continue;
    evicted.push(key);
    excess -= 1;
  }
  return evicted;
}
