// SPDX-License-Identifier: MIT
import { useLayoutEffect, useState, useSyncExternalStore } from "react";

/** Two views with the same fields (an array field compares by its items). */
function sameView(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const x = left[key];
    const y = right[key];
    if (Object.is(x, y)) return true;
    return (
      Array.isArray(x) &&
      Array.isArray(y) &&
      x.length === y.length &&
      x.every((item, i) => Object.is(item, y[i]))
    );
  });
}

/**
 * What each keyed child of a tiled surface draws from, held outside React so a child redraws only
 * when its own view changes. The kit redraws every leaf when its `renderLeaf` is a new function,
 * so `renderLeaf` has to be stable, and what changes per child (focused, zoomed, a drag's zones)
 * cannot travel in it: it travels here.
 *
 * The owner publishes every render. A view equal to the key's last one keeps its identity, so a
 * subscriber's snapshot is unchanged and it does not redraw.
 *
 * Limit: it publishes during the owner's render, which is safe only while nothing renders the
 * owner in a transition or under Suspense. A render React throws away would leave the store
 * holding views that never committed, and a child that redraws for its own reason would read them.
 */
export class KeyedViewStore<V extends object> {
  private views: ReadonlyMap<string, V> = new Map();
  private listeners = new Set<() => void>();
  private dirty = false;

  /** Take the owner's views for this render. Written during render, so a child that mounts in
   *  this commit reads its view at once; subscribers are told after the commit ({@link notify}). */
  publish(next: ReadonlyMap<string, V>): void {
    const merged = new Map<string, V>();
    for (const [key, view] of next) {
      const before = this.views.get(key);
      merged.set(key, before && sameView(before, view) ? before : view);
    }
    if (merged.size !== this.views.size || [...merged].some(([k, v]) => this.views.get(k) !== v)) {
      this.dirty = true;
    }
    this.views = merged;
  }

  /** Tell subscribers, once, if the last publish changed anything. */
  notify(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  get(key: string): V | undefined {
    return this.views.get(key);
  }
}

/** A store of `views` for the calling component (the owner of the keyed children). */
export function useKeyedViewStore<V extends object>(views: ReadonlyMap<string, V>) {
  const [store] = useState(() => new KeyedViewStore<V>());
  store.publish(views);
  useLayoutEffect(() => store.notify());
  return store;
}

/** The view for `key`, redrawing the caller only when that view changes. */
export function useKeyedView<V extends object>(
  store: KeyedViewStore<V>,
  key: string,
): V | undefined {
  return useSyncExternalStore(store.subscribe, () => store.get(key));
}
