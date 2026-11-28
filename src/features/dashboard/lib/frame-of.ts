// SPDX-License-Identifier: MIT
import type { LiveFrame } from "./frame-lifecycle";

/** Whether `f` is a frame the tab `path` of `teamKey` hosts: a centre frame mounted inside
 *  that tab's viewer. A story md tab hosts its team's story page, a frame whose document is
 *  the page, not the md, so the viewer element is what decides. */
export function frameOf(f: LiveFrame, teamKey: string, path: string): boolean {
  return (
    f.slotId === "centre" &&
    f.teamKey === teamKey &&
    f.element?.closest("[data-viewer-path]")?.getAttribute("data-viewer-path") === path
  );
}
