// SPDX-License-Identifier: MIT
import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { tileBodyKinds } from "./tile-body-kinds";

vi.mock("@/features/viewer/components/diff-tile-body", () => ({ DiffTileBody: () => null }));
vi.mock("@/features/viewer/components/story-tile-body", () => ({ StoryTileBody: () => null }));
const notes = vi.hoisted(() => ({ panelId: "" }));
vi.mock("../right-pane/builtin-panels", () => ({
  ScratchSlotBody: ({ panelId }: { panelId: string }) => {
    notes.panelId = panelId;
    return null;
  },
}));
vi.mock("../slots/dashboard-tile-body", () => ({
  DashboardTileBody: () => null,
  InboxTileBody: () => null,
}));

const bodyOf = (key: string) =>
  tileBodyKinds.filter((kind) => kind.matches(key)).map((k) => k.kind);

describe("tileBodyKinds", () => {
  it.each([
    ["dashboard:team:acme:alpha/board", "dashboard"],
    ["story-page:DEMO-63", "story"],
    ["diff:context:ctx-demo", "diff"],
    ["notes:scratch", "notes"],
    ["inbox:acme", "inbox"],
  ])("renders %s as one %s body", (key, kind) => {
    expect(bodyOf(key)).toEqual([kind]);
  });

  it.each(["doc:core/a.html", "doc:core/a.md", "agent:alpha/dev", "tab-1"])(
    "leaves %s to the host's own bodies",
    (key) => {
      expect(bodyOf(key)).toEqual([]);
    },
  );

  it("opens Notes under its tile's own panel id, so its reveals are its own", () => {
    const kind = tileBodyKinds.find((k) => k.kind === "notes")!;
    const context = { visible: true, reportLoading: () => {} };
    render(
      createElement(kind.Body, { tileKey: "notes:scratch", context, orgRoot: "/home/me/code" }),
    );
    expect(notes.panelId).toBe("tile:notes:scratch");
  });
});
