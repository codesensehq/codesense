// SPDX-License-Identifier: MIT
/**
 * `ItemKey`: one key shape for "a thing a window shows", shared with Rust
 * (`src-tauri/src/windows/item_key.rs`) through one fixture,
 * `src-tauri/src/windows/fixtures/item-keys.json`.
 *
 * The one kind defined today is `tab`: a viewer tab in `main`'s `openTabs`, whatever
 * renders it. `team` is the `openTabs` bucket key, verbatim, and `id` is
 * `TabState.path` exactly as the store holds it. Two keys are one item exactly when
 * `main` would treat them as one tab (`t.path === filePath`): no decoding, no query
 * sorting, no case folding. `kind` is a namespace; later stories add kinds.
 *
 * Must not import from `viewer-store.ts`, which imports this module.
 */

export const TAB_ITEM_KIND = "tab";

export interface ItemKey {
  kind: string;
  team: string;
  id: string;
}

/** The key of a viewer tab in `openTabs[team]`. */
export function itemKeyForTab(team: string, tab: { path: string }): ItemKey {
  return { kind: TAB_ITEM_KIND, team, id: tab.path };
}

/** The item's name, as its tab shows it: the last segment of its path. */
export function itemName(key: ItemKey): string {
  return key.id.slice(key.id.lastIndexOf("/") + 1) || key.id;
}

/** The canonical string, `["<kind>","<team>","<id>"]`; Rust writes the same bytes. */
export function canonicalItemKey(key: ItemKey): string {
  return JSON.stringify([key.kind, key.team, key.id]);
}

/** Parses a canonical string; `null` when it is not a three-string array. */
export function parseCanonicalItemKey(canonical: string): ItemKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  if (!parsed.every((part) => typeof part === "string")) return null;
  const [kind, team, id] = parsed as [string, string, string];
  return { kind, team, id };
}
