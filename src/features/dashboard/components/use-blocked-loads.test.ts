// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBlockedLoads } from "./use-blocked-loads";

const block = (n: number) => ({
  kind: "csp" as const,
  message: `blocked by the frame content policy: https://h${n}.example/p (img-src)`,
});

it("keeps the last 50 rows, counts every block once, and never re-adds an evicted row", () => {
  const { result } = renderHook(() => useBlockedLoads("doc"));
  act(() => {
    for (let n = 0; n < 60; n++) result.current.onDocProblem(block(n));
  });
  expect(result.current.blocked).toHaveLength(50);
  expect(result.current.blocked[0]).toEqual(block(10));
  expect(result.current.total).toBe(60);
  act(() => {
    result.current.onDocProblem(block(0));
    result.current.onDocProblem(block(59));
    result.current.onDocProblem({ kind: "script", message: "boom" });
  });
  expect(result.current.blocked).toHaveLength(50);
  expect(result.current.blocked[0]).toEqual(block(10));
  expect(result.current.total).toBe(60);
  act(() => result.current.dismiss());
  expect(result.current.blocked).toEqual([]);
  act(() => result.current.onDocProblem(block(60)));
  expect(result.current.blocked).toEqual([block(60)]);
  expect(result.current.total).toBe(1);
});

it("starts empty for another document, which may report the same block again", () => {
  const { result, rerender } = renderHook(({ doc }) => useBlockedLoads(doc), {
    initialProps: { doc: "a.html" },
  });
  act(() => result.current.onDocProblem(block(1)));
  expect(result.current.blocked).toEqual([block(1)]);
  rerender({ doc: "b.html" });
  expect(result.current.blocked).toEqual([]);
  expect(result.current.total).toBe(0);
  act(() => result.current.onDocProblem(block(1)));
  expect(result.current.blocked).toEqual([block(1)]);
});
