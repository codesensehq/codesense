// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEffectiveRefreshKey } from "./use-effective-refresh-key";
import { frameDeclarationPaths } from "@/shared/lib/file-change-affects";

type Cp = Set<string> | null;

it("refreshes for ancestor declarations and directory events but keeps unrelated changes stable", () => {
  const file = "/ctx/boards/demo/index.html";
  const manifests = frameDeclarationPaths(file, "/ctx/");
  expect(manifests).toEqual([
    "/ctx/boards/demo/dashboard.yml",
    "/ctx/boards/dashboard.yml",
    "/ctx/dashboard.yml",
  ]);
  expect(frameDeclarationPaths("/ctx-other/index.html", "/ctx")).toEqual([]);
  const { result, rerender } = renderHook(
    ({ k, changed }) => useEffectiveRefreshKey(k, new Set([changed]), file, manifests),
    { initialProps: { k: 1, changed: file } },
  );
  let k = 1;
  // Edits, creation and deletion use the same path notification, without reading the file.
  for (const changed of [...manifests, "/ctx/boards/demo"]) {
    rerender({ k: ++k, changed });
    expect(result.current).toBe(k);
  }
  for (const changed of [
    "/dashboard.yml",
    "/ctx/boards/other/dashboard.yml",
    "/ctx/boards/demo/data.json",
  ]) {
    const previous = result.current;
    rerender({ k: ++k, changed });
    expect(result.current).toBe(previous);
  }
});

it("tracks only native-discoverable pane siblings, including absent and invalid manifests", () => {
  const file = "/ctx/panes/status.html";
  const related = frameDeclarationPaths(file, "/ctx");
  expect(related).toContain("/ctx/panes/pane-manifest.yaml");
  expect(frameDeclarationPaths(file, "/ctx/content")).toEqual(["/ctx/panes/pane-manifest.yaml"]);
  for (const other of [
    "/ctx/panes/nested/status.html",
    "/ctx/panes/Status.html",
    `/ctx/panes/${"a".repeat(65)}.html`,
  ])
    expect(frameDeclarationPaths(other, "/ctx")).not.toContain("/ctx/panes/pane-manifest.yaml");
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useEffectiveRefreshKey(revision, new Set(["/ctx/panes/pane-manifest.yaml"]), file, related),
    { initialProps: { revision: 1 } },
  );
  for (const revision of [2, 3, 4, 5]) {
    rerender({ revision });
    expect(result.current).toBe(revision);
  }
});

describe("useEffectiveRefreshKey", () => {
  it("returns the initial key on first render", () => {
    const { result } = renderHook(() => useEffectiveRefreshKey(1, null, "/a"));
    expect(result.current).toBe(1);
  });

  it("advances when the file is in changedPaths", () => {
    const { result, rerender } = renderHook(({ k, cp }) => useEffectiveRefreshKey(k, cp, "/a"), {
      initialProps: { k: 1, cp: new Set(["/other"]) as Cp },
    });
    expect(result.current).toBe(1);
    rerender({ k: 2, cp: new Set(["/a"]) });
    expect(result.current).toBe(2);
  });

  it("holds the prior key when the file is not in changedPaths", () => {
    const { result, rerender } = renderHook(({ k, cp }) => useEffectiveRefreshKey(k, cp, "/a"), {
      initialProps: { k: 1, cp: new Set(["/other"]) as Cp },
    });
    rerender({ k: 2, cp: new Set(["/other"]) });
    expect(result.current).toBe(1);
  });

  it("falls back to advancing when changedPaths is null/absent", () => {
    const { result, rerender } = renderHook(({ k, cp }) => useEffectiveRefreshKey(k, cp, "/a"), {
      initialProps: { k: 1, cp: null as Cp },
    });
    rerender({ k: 2, cp: null });
    expect(result.current).toBe(2);
  });

  it("holds across multiple non-matching bumps, then advances when matched", () => {
    const { result, rerender } = renderHook(({ k, cp }) => useEffectiveRefreshKey(k, cp, "/a"), {
      initialProps: { k: 1, cp: new Set(["/other"]) as Cp },
    });
    rerender({ k: 2, cp: new Set(["/other"]) });
    rerender({ k: 3, cp: new Set(["/other"]) });
    expect(result.current).toBe(1);
    rerender({ k: 4, cp: new Set(["/a"]) });
    expect(result.current).toBe(4);
  });

  it("resets to the current key when filePath changes (self-contained)", () => {
    const { result, rerender } = renderHook(({ k, cp, fp }) => useEffectiveRefreshKey(k, cp, fp), {
      initialProps: { k: 5, cp: new Set(["/other"]) as Cp, fp: "/a" },
    });
    // Same file, unrelated bump → holds.
    rerender({ k: 6, cp: new Set(["/other"]), fp: "/a" });
    expect(result.current).toBe(5);
    // Switch to a new file → adopt the current key even though it's not in
    // changedPaths (the new file must load fresh).
    rerender({ k: 6, cp: new Set(["/other"]), fp: "/b" });
    expect(result.current).toBe(6);
  });

  // SW-SC-11: an atomic-temp sibling (the agent's `<file>.tmp.<pid>.<hash>`
  // write) is a different path than the open file, so the gate must HOLD on it —
  // the viewer reloads only once the backend forwards the REAL rename
  // destination. This shared-gate invariant is why filtering transient temps at
  // the Rust emit (so changedPaths carries only real paths) fixes all four
  // viewers at once.
  it("holds on an atomic-temp sibling, advances on the real rename target (SW-SC-11)", () => {
    const file = "/x/canvas.excalidraw";
    const { result, rerender } = renderHook(({ k, cp }) => useEffectiveRefreshKey(k, cp, file), {
      initialProps: { k: 1, cp: new Set([`${file}.tmp.99999.deadbeef`]) as Cp },
    });
    expect(result.current).toBe(1);
    // Another temp sibling bump → still holds (gate can never match a temp).
    rerender({ k: 2, cp: new Set([`${file}.tmp.10001.beadfeed`]) });
    expect(result.current).toBe(1);
    // Real rename destination arrives → advances.
    rerender({ k: 3, cp: new Set([file]) });
    expect(result.current).toBe(3);
  });

  it("does not advance when refreshKey regresses to undefined", () => {
    const { result, rerender } = renderHook(({ k, cp }) => useEffectiveRefreshKey(k, cp, "/a"), {
      initialProps: { k: 3 as number | undefined, cp: null as Cp },
    });
    expect(result.current).toBe(3);
    rerender({ k: undefined, cp: null });
    expect(result.current).toBe(3);
  });
});

it.each(["/team/content", "/team/content/docs", "/team/content/"])(
  "advances for ancestor directory %s",
  (directory) => {
    const { result, rerender } = renderHook(
      ({ k, cp }) => useEffectiveRefreshKey(k, cp, "/team/content/docs/a.md"),
      {
        initialProps: { k: 1, cp: new Set<string>() },
      },
    );
    rerender({ k: 2, cp: new Set([directory]) });
    expect(result.current).toBe(2);
    rerender({ k: 3, cp: new Set(["/team/content/doc", "/team/content/docs-other"]) });
    expect(result.current).toBe(2);
  },
);
