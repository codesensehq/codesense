// SPDX-License-Identifier: MIT
import { useRef } from "react";

/**
 * Wrap a store selector so it returns its previous result while `equal` says the new
 * one is the same: a store hook bails out of re-rendering exactly as for a scalar, and
 * a fresh object never loops `useSyncExternalStore`. Every hook given the wrapper
 * shares one cache, so they all agree on the value's identity.
 */
export function useEqualSelector<A extends unknown[], T>(
  select: (...args: A) => T,
  equal: (a: T, b: T) => boolean,
): (...args: A) => T {
  const last = useRef<{ value: T } | null>(null);
  return (...args) => {
    const value = select(...args);
    const previous = last.current;
    if (previous && equal(previous.value, value)) return previous.value;
    last.current = { value };
    return value;
  };
}
