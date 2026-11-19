// SPDX-License-Identifier: MIT
import { basename } from "@/shared/lib/path";
import type { Workspace } from "@/shared/stores/viewer-store";

/** A group room's name: its story, epic doc or folder, else the room id. */
export function roomName(
  ws: Workspace | undefined,
  storyId: string | null,
  workspaceId: string,
): string {
  return (
    ws?.storyTitle ||
    ws?.storyId ||
    ws?.epicDocPath ||
    (ws?.cwd && basename(ws.cwd)) ||
    storyId ||
    workspaceId.replace(/^generic:/, "")
  );
}
