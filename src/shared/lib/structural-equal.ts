// SPDX-License-Identifier: MIT
import { countWebviewPerf } from "./webview-perf-counters";

/**
 * Whether two plain values (primitives, arrays, plain objects) hold the same data, as
 * their JSON would: an object key whose value is `undefined` counts as absent. Store
 * selectors that derive a fresh object compare with it instead of building JSON keys.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  countWebviewPerf("structuralCompares");
  return equal(a, b);
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let keys = 0;
  for (const key in left) {
    if (left[key] === undefined) continue;
    keys++;
    if (!equal(left[key], right[key])) return false;
  }
  for (const key in right) if (right[key] !== undefined) keys--;
  return keys === 0;
}
