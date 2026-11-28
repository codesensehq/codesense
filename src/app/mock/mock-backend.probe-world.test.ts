// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { createMockBackend } from "./mock-backend";
import { resolveScenario } from "./scenario";

const call = (search: string) =>
  createMockBackend(resolveScenario(search), search)("file_surface_call", {
    operation: "read",
    args: { path: "probe-read.txt" },
    frameId: "no-such-frame",
  });

it("serves a dashboard's files surface in the probe route's world only", async () => {
  // Handled: the frame is unknown, so the read is denied, not unmocked.
  await expect(call("?window=pane-probe&probe=/mock-ctx/default/panes/p.html")).rejects.toThrow(
    "denied: frame released",
  );
  for (const search of ["", "?window=pane-x", "?terminals=demo"]) {
    await expect(call(search)).rejects.toThrow("not mocked: file_surface_call");
  }
});
