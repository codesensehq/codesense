// SPDX-License-Identifier: MIT
/**
 * `main`'s copy of the satellite-owned map: every key a satellite holds → that
 * satellite's label, from `main`'s registry slice (`owners`). `main` owns every key not
 * in it. Reads are synchronous, so `main`'s store actions never wait on IPC.
 *
 * Tab keys are also indexed as `Map<team, Set<path>>`, so the viewer store's guard
 * (`guardSatelliteItems`) checks a tab with two lookups instead of building its key.
 */
import { windowGetSlice } from "@/tauri/commands";
import { logger } from "@/shared/lib/logger";
import { canonicalItemKey, parseCanonicalItemKey, TAB_ITEM_KIND, type ItemKey } from "./item-key";
import { createSliceHolder, type SliceHolder } from "./registry-client";
import { MAIN_WINDOW_LABEL, type WindowSlice } from "./window-slice";

const EMPTY_TABS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

let owners: ReadonlyMap<string, string> = new Map();
let tabs: ReadonlyMap<string, ReadonlySet<string>> = EMPTY_TABS;
const listeners = new Set<() => void>();

/** Replaces the map with `next` (canonical key → satellite label) and tells listeners. */
export function applyOwnerMap(next: Record<string, string>): void {
  const nextOwners = new Map<string, string>();
  const nextTabs = new Map<string, Set<string>>();
  for (const [canonical, label] of Object.entries(next)) {
    const key = parseCanonicalItemKey(canonical);
    if (!key) {
      logger.warn("windows", `owner map: skipped a malformed key ${canonical}`);
      continue;
    }
    nextOwners.set(canonical, label);
    if (key.kind !== TAB_ITEM_KIND) continue;
    let paths = nextTabs.get(key.team);
    if (!paths) nextTabs.set(key.team, (paths = new Set()));
    paths.add(key.id);
  }
  owners = nextOwners;
  tabs = nextTabs.size === 0 ? EMPTY_TABS : nextTabs;
  for (const listener of listeners) listener();
}

/** How many keys satellites hold; `0` means `main` owns everything. */
export function ownerMapSize(): number {
  return owners.size;
}

/** The satellite-owned tab paths, by `openTabs` bucket key. */
export function satelliteOwnedTabs(): ReadonlyMap<string, ReadonlySet<string>> {
  return tabs;
}

/** The label of the window that owns `key`. */
export function ownerOfItem(key: ItemKey): string {
  return owners.get(canonicalItemKey(key)) ?? MAIN_WINDOW_LABEL;
}

/** Calls `listener` after every map update; returns the unsubscribe. */
export function onOwnerMapChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function createMainHolder() {
  return createSliceHolder((slice: WindowSlice) => applyOwnerMap(slice.owners ?? {}));
}

let mainHolder = createMainHolder();

/** `main`'s newest slice: a newer one replaces the map, an older one is ignored. */
export const mainSlice: SliceHolder = {
  offer: (slice) => mainHolder.offer(slice),
  current: () => mainHolder.current(),
};

/** Empties the map and forgets the held slice, without telling listeners. */
export function resetOwnerMapForTests(): void {
  owners = new Map();
  tabs = EMPTY_TABS;
  mainHolder = createMainHolder();
}

/**
 * Pulls `main`'s slice into the map (the hydrate pull). A failed pull leaves the map as
 * it is: outside the app (tests, the mock) there is no registry and `main` owns all.
 */
export async function pullMainSlice(
  getSlice?: (label: string) => Promise<WindowSlice>,
): Promise<void> {
  try {
    mainSlice.offer(await (getSlice ?? windowGetSlice)(MAIN_WINDOW_LABEL));
  } catch (e) {
    logger.warn("windows", `main slice pull failed: ${String(e)}`);
  }
}
