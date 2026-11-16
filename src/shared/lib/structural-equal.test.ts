// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { structurallyEqual } from "./structural-equal";
import { resetWebviewPerfCounts, webviewPerfCounts } from "./webview-perf-counters";

it("compares plain data as its JSON would", () => {
  expect(structurallyEqual({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
  expect(structurallyEqual({ a: 1, gone: undefined }, { a: 1 })).toBe(true);
  expect(structurallyEqual({ a: 1 }, { a: 1, b: null })).toBe(false);
  expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  expect(structurallyEqual([], {})).toBe(false);
  expect(structurallyEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  expect(structurallyEqual(null, {})).toBe(false);
  expect(structurallyEqual("a", "a")).toBe(true);
});

it("counts each comparison", () => {
  resetWebviewPerfCounts();
  structurallyEqual({ a: [1] }, { a: [1] });
  expect(webviewPerfCounts().structuralCompares).toBe(1);
});
