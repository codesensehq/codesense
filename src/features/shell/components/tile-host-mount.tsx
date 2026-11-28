// SPDX-License-Identifier: MIT
/**
 * The one place the tile host mounts in the app. With the tiles flag off it renders nothing and
 * the team view is today's. With it on it lays the host over the content area, on the active
 * team's foreground tree, and fills only tile-ref leaves: a `doc:` leaf is an `HtmlViewer` whose
 * frame loads once. A workspace leaf stays in today's team view, so no terminal gets a second
 * xterm; the host draws nothing over it and takes no pointer input there.
 *
 * Bodies come from the kinds below: the doc body and the content kinds of `tileBodyKinds` (a
 * dashboard, a story page, a diff, Notes, the Inbox). The terminal kind is listed but matches no
 * leaf until workspace leaves move into the host.
 *
 * Each tile-ref body sits in its tile's tab frame, whose bar shows for one tab or five. The
 * window keeps each cell's tabs (`use-cell-tabs.ts`); until a tab is placed into a cell, each
 * holds one.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { HtmlViewer } from "@/features/dashboard/components/html-viewer";
import { TileTabFrame, TileTabsContext } from "@/features/viewer/components/tile-tab-frame";
import { join } from "@/shared/lib/path";
import { parseTeamKey } from "@/shared/lib/team-key";
import { pathToTeamContentDirSync } from "@/shared/lib/team-content-path";
import { tilesEnabled } from "@/shared/lib/tiles-enabled";
import { useOrgStore } from "@/shared/stores/org-store";
import { activeForegroundLayout, useViewerStore } from "@/shared/stores/viewer-store";
import { readTileFlag } from "@/shared/tiling/hosted-frame";
import { TileHost, type TileBodyContext } from "@/shared/tiling/tile-host";

import { tileBodyKinds } from "./tile-body-kinds";
import { useCellTabs } from "./use-cell-tabs";

/** The window's pins. Empty until pins reach the window. */
const PINS: ReadonlySet<string> = new Set();

/** `doc:<team>/<path>`: a file in a team's content. */
const DOC_REF = /^doc:([^/]+)\/(.+)$/;

interface BodyKind {
  matches(key: string): boolean;
  Body(props: { tileKey: string; context: TileBodyContext; orgRoot: string }): ReactNode;
  skeleton: ReactNode;
}

function DocBody({
  tileKey,
  context,
  orgRoot,
}: {
  tileKey: string;
  context: TileBodyContext;
  orgRoot: string;
}) {
  const [, team, path] = DOC_REF.exec(tileKey)!;
  const root = pathToTeamContentDirSync(orgRoot, team);
  // The frame's document is set once: `refreshKey` never changes, so nothing here reloads it.
  return (
    <HtmlViewer
      filePath={join(root, path)}
      teamContentPath={root}
      refreshKey={0}
      visible={context.visible}
      onPageStart={() => context.reportLoading(true)}
      onPageLoad={() => context.reportLoading(false)}
    />
  );
}

const KINDS: readonly BodyKind[] = [
  {
    matches: (key) => DOC_REF.test(key) && /\.html?$/i.test(key),
    Body: DocBody,
    skeleton: <div data-tile-skeleton="doc" className="h-full w-full bg-muted/40" />,
  },
  ...tileBodyKinds,
  {
    // Workspace leaves render in the team view for now.
    matches: () => false,
    Body: () => null,
    skeleton: <div data-tile-skeleton="terminal" className="h-full w-full bg-muted/40" />,
  },
];
const bodyKindOf = (key: string) => KINDS.find((kind) => kind.matches(key));
const renderSkeleton = (key: string) => bodyKindOf(key)?.skeleton ?? null;
/** The overlay's dividers take no input: the team view commits sizes. */
const ignoreSizes = () => {};

/** A tile-ref body in its tile's tab frame; a workspace leaf, drawn by the team view, has none. */
function TabFrame({ tileKey, children }: { tileKey: string; children: ReactNode }) {
  if (!bodyKindOf(tileKey)) return <>{children}</>;
  return <TileTabFrame tileKey={tileKey}>{children}</TileTabFrame>;
}

/** Whether tiles are on this session; false until the boot value is read. */
function useTilesOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const enabled = await tilesEnabled();
      // The frame checks read the same flag; they have it before any tile frame exists.
      if (enabled) await readTileFlag();
      if (live) setOn(enabled);
    })();
    return () => {
      live = false;
    };
  }, []);
  return on;
}

export function TileHostMount({ teamKey }: { teamKey: string | null }) {
  const on = useTilesOn();
  if (!on || !teamKey) return null;
  return <ActiveTeamHost teamKey={teamKey} />;
}

function ActiveTeamHost({ teamKey }: { teamKey: string }) {
  const root = useViewerStore((s) => activeForegroundLayout(s, teamKey)?.root ?? null);
  const { orgSlug } = parseTeamKey(teamKey);
  const orgRoot = useOrgStore((s) => s.orgs.find((org) => org.slug === orgSlug)?.org_root ?? "");
  const renderBody = useMemo(() => bodiesFor(orgRoot), [orgRoot]);
  const tabs = useCellTabs();
  if (!orgRoot) return null;
  return (
    // Over the content area; only a shown tile-ref body takes pointer input.
    <div
      data-tile-host-mount=""
      className="pointer-events-none absolute inset-0 [&_[data-tile-body]:not(:has([data-tile-kind]))]:!pointer-events-none"
    >
      <TileTabsContext.Provider value={tabs}>
        <TileHost
          node={root}
          renderBody={renderBody}
          renderSkeleton={renderSkeleton}
          wrapBody={TabFrame}
          cellTabs={tabs.cells}
          onSizesCommit={ignoreSizes}
          pins={PINS}
        />
      </TileTabsContext.Provider>
    </div>
  );
}

/** `renderBody` for one org: stable while the org root is. */
function bodiesFor(orgRoot: string) {
  return function renderBody(key: string, context: TileBodyContext) {
    const kind = bodyKindOf(key);
    if (!kind) return null;
    return (
      <div data-tile-kind="" className="h-full w-full">
        <kind.Body tileKey={key} context={context} orgRoot={orgRoot} />
      </div>
    );
  };
}
