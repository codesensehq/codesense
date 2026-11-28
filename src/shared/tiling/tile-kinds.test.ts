// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  checkTileOpen,
  LIVE_ELSEWHERE_REASON,
  parseTileRef,
  TILE_KINDS,
  tileKeyOf,
  tileKindOf,
  WORKSPACE_REF_REASON,
  type TerminalPlace,
  type TileOpenContext,
  type TileRef,
} from "./tile-kinds";

// One ref of every kind, a markdown and an HTML file among them.
const REFS: Record<string, TileRef> = {
  dashboard: { kind: "dashboard", ref: { scope: "team", org: "acme", team: "core", id: "board" } },
  "markdown file": { kind: "file", team: "core", path: "notes/plan.md" },
  "HTML file": { kind: "file", team: "core", path: "dashboards/status.html" },
  "story page": { kind: "story", storyId: "DEMO-63" },
  diff: { kind: "diff", worktree: { kind: "source", id: "wt-demo-63" } },
  notes: { kind: "notes" },
  inbox: { kind: "inbox", org: "acme" },
  agent: { kind: "agent", team: "team-2", name: "review.bot_1" },
  shell: { kind: "shell", tabId: "tab_7F3e" },
};

// Host tiles by what they already hold: agents only, content only, both, one shell.
const HOSTS: Record<string, string[]> = {
  "an agent tile": ["agent:core/dev", "agent:core/lead"],
  "a content tile": ["doc:core/README.md", "story-page:DEMO-1"],
  "a mixed tile": ["agent:core/dev", "dashboard:built-in:acme/inbox", "tab_shell1"],
  "a shell tile": ["tab_shell1"],
};

function context(host: string, tabs: string[], terminals: Record<string, TerminalPlace> = {}) {
  return {
    cell: host,
    cellHolding: (key: string) => (tabs.includes(key) ? host : null),
    terminalPlace: (key: string) => terminals[key] ?? null,
  } satisfies TileOpenContext;
}

describe("checkTileOpen: every kind is a tab in every tile", () => {
  const rows = Object.entries(HOSTS).flatMap(([host, tabs]) =>
    Object.entries(REFS).map(([kind, ref]) => ({ host, tabs, kind, ref })),
  );

  it.each(rows)("$kind opens in $host", ({ host, tabs, ref }) => {
    const check = checkTileOpen(ref, context(host, tabs));
    expect(check).toEqual({ status: "open", ref, key: tileKeyOf(ref), leavesCliWorkspace: false });
  });

  it("covers every kind", () => {
    expect(new Set(Object.values(REFS).map((ref) => ref.kind))).toEqual(new Set(TILE_KINDS));
  });
});

describe("checkTileOpen: the three refusals", () => {
  it("refuses a workspace ref with a reason", () => {
    const check = checkTileOpen({ kind: "workspace", id: "ws-1a2b3c" }, context("c1", []));
    expect(check).toEqual({ status: "refused", reason: WORKSPACE_REF_REASON });
  });

  it.each(["shell", "agent"])("refuses a %s live in another tile: one live copy", (kind) => {
    const ref = REFS[kind];
    const terminals = { [tileKeyOf(ref)]: { where: "tile", cell: "other-window-cell" } as const };
    const check = checkTileOpen(ref, context("c1", [], terminals));
    expect(check).toEqual({ status: "refused", reason: LIVE_ELSEWHERE_REASON });
  });

  it("focuses the tab already open instead of adding a duplicate", () => {
    const ref = REFS["markdown file"];
    const held = { cell: "c1", cellHolding: () => "c2", terminalPlace: () => null };
    expect(checkTileOpen(ref, held)).toEqual({ status: "focus", key: tileKeyOf(ref), cell: "c2" });
  });

  it("moves a CLI-workspace terminal into the tile, keeping the same key", () => {
    const ref = REFS.shell;
    const terminals = { tab_7F3e: { where: "cli-workspace" } as const };
    expect(checkTileOpen(ref, context("c1", [], terminals))).toEqual({
      status: "open",
      ref,
      key: "tab_7F3e",
      leavesCliWorkspace: true,
    });
  });

  it("holds no other refusal: the old cell-mixing texts are gone", () => {
    const texts = Object.entries(HOSTS).flatMap(([host, tabs]) =>
      Object.values(REFS).map((ref) => checkTileOpen(ref, context(host, tabs))),
    );
    expect(texts.filter((c) => c.status === "refused")).toEqual([]);
  });
});

describe("parseTileRef", () => {
  it.each(Object.values(REFS))("reads back $kind", (ref) => {
    expect(parseTileRef(JSON.parse(JSON.stringify(ref)))).toEqual({ ok: true, ref });
  });

  it.each([
    ["no object", null],
    ["an unknown kind", { kind: "view" }],
    ["a dashboard with no scope", { kind: "dashboard", ref: { org: "acme", id: "x" } }],
    [
      "a team dashboard with no team",
      { kind: "dashboard", ref: { scope: "team", org: "acme", id: "x" } },
    ],
    ["a file with no path", { kind: "file", team: "core" }],
    ["a diff of an unknown worktree kind", { kind: "diff", worktree: { kind: "lead", id: "x" } }],
    ["an agent with no name", { kind: "agent", team: "core" }],
    ["a shell with no tab", { kind: "shell" }],
  ])("refuses %s", (_name, value) => {
    expect(parseTileRef(value)).toMatchObject({ ok: false });
  });

  it("drops a team on a built-in dashboard", () => {
    const value = {
      kind: "dashboard",
      ref: { scope: "built-in", org: "acme", team: "core", id: "x" },
    };
    expect(parseTileRef(value)).toEqual({
      ok: true,
      ref: { kind: "dashboard", ref: { scope: "built-in", org: "acme", id: "x" } },
    });
  });
});

describe("tileKeyOf and tileKindOf", () => {
  it.each(Object.values(REFS))("reads $kind back from its key", (ref) => {
    expect(tileKindOf(tileKeyOf(ref))).toBe(ref.kind);
  });

  it("keys a dashboard as the app's dashboard ref key", () => {
    expect(tileKeyOf(REFS.dashboard)).toBe("dashboard:team:acme:core/board");
    expect(
      tileKeyOf({ kind: "dashboard", ref: { scope: "built-in", org: "acme", id: "inbox" } }),
    ).toBe("dashboard:built-in:acme/inbox");
  });

  it("keys a file and an agent as the leaf-id grammar does", () => {
    expect(tileKeyOf(REFS["markdown file"])).toBe("doc:core/notes/plan.md");
    expect(tileKeyOf(REFS.agent)).toBe("agent:team-2/review.bot_1");
  });
});
