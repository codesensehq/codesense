// SPDX-License-Identifier: MIT
/**
 * The bodies of the tab kinds a tile renders by key: a dashboard, a story page, a diff, Notes and
 * the Inbox. A file's body and a terminal's are not here: an HTML file is the host's own doc
 * body, other files come later, and a terminal stays in the CLI workspace until workspace leaves
 * move into the host.
 */
import type { ReactNode } from "react";

import { DiffTileBody } from "@/features/viewer/components/diff-tile-body";
import { StoryTileBody } from "@/features/viewer/components/story-tile-body";
import { tileKindOf, type TileKind } from "@/shared/tiling/tile-kinds";
import type { TileBodyContext } from "@/shared/tiling/tile-host";

import { ScratchSlotBody } from "../right-pane/builtin-panels";
import { DashboardTileBody, InboxTileBody } from "../slots/dashboard-tile-body";

export interface TileBodyKind {
  kind: TileKind;
  matches(key: string): boolean;
  Body(props: { tileKey: string; context: TileBodyContext; orgRoot: string }): ReactNode;
  skeleton: ReactNode;
}

const skeleton = (kind: TileKind) => (
  <div data-tile-skeleton={kind} className="h-full w-full bg-muted/40" />
);

const ofKind = (kind: TileKind) => (key: string) => tileKindOf(key) === kind;

export const tileBodyKinds: readonly TileBodyKind[] = [
  {
    kind: "dashboard",
    matches: ofKind("dashboard"),
    Body: DashboardTileBody,
    skeleton: skeleton("dashboard"),
  },
  { kind: "story", matches: ofKind("story"), Body: StoryTileBody, skeleton: skeleton("story") },
  { kind: "diff", matches: ofKind("diff"), Body: DiffTileBody, skeleton: skeleton("diff") },
  {
    kind: "notes",
    matches: ofKind("notes"),
    Body: ({ tileKey }) => <ScratchSlotBody panelId={`tile:${tileKey}`} />,
    skeleton: skeleton("notes"),
  },
  { kind: "inbox", matches: ofKind("inbox"), Body: InboxTileBody, skeleton: skeleton("inbox") },
];
