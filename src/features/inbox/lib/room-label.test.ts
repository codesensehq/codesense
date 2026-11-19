// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { Workspace } from "@/shared/stores/viewer-store";
import { roomName } from "./room-label";

const ws = (fields: Partial<Workspace>) => fields as Workspace;

describe("roomName", () => {
  it("names a plain workspace after its folder", () => {
    expect(roomName(ws({ cwd: "/Users/me/repos/widgets/" }), null, "generic:w1")).toBe("widgets");
  });

  it("names a Windows workspace after its folder", () => {
    expect(roomName(ws({ cwd: "C:\\Users\\me\\repos\\widgets" }), null, "generic:w1")).toBe(
      "widgets",
    );
  });

  it("prefers the story over the folder, and falls back to the room id", () => {
    expect(roomName(ws({ cwd: "/r", storyTitle: "Title" }), null, "generic:w1")).toBe("Title");
    expect(roomName(undefined, null, "generic:w1")).toBe("w1");
  });
});
