// SPDX-License-Identifier: MIT
import { useRunningAgent } from "@/features/viewer/lib/hand-agents";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import {
  cleanupAgentInboxRailTab,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";
import {
  useMinimizedTerminalTabIndex,
  useRunningTerminalTabIndex,
} from "@/features/viewer/lib/cli-workspace/store/terminal-selectors";

import { overlayPlacement } from "../lib/overlay-layout";

// The chat (markdown renderer, thread) loads only once some tab opens it.
const ChatOverlay = lazy(() => import("./chat-overlay").then((m) => ({ default: m.ChatOverlay })));

/**
 * A tab's body under its caption: the terminal and, when the tab's chat is open, the agent's
 * chat overlay. On a tab 840+ wide and 360+ tall the chat docks on the right at a fixed width
 * and the terminal reflows beside it; on a smaller tab it covers the tab. The terminal keeps the
 * same parent element whether or not the chat shows, so opening it never remounts (or
 * re-attaches) the terminal.
 */
export function InboxSplit({
  tab,
  teamKey,
  visible = true,
  children,
}: {
  tab: { id: string; sessionId: string };
  teamKey: string;
  visible?: boolean;
  children: ReactNode;
}) {
  const runningAgent = useRunningAgent(tab.sessionId);
  const target = useAgentInboxRailStore((s) => s.bySession[tab.sessionId]);
  const ref = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!visible || !target || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSplit({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [target, visible]);
  // Not measured yet (the first frame, or no layout at all): dock, as on a usual wide tab.
  const placement =
    split.width > 0 ? overlayPlacement(split.width, split.height) : overlayPlacement(840, 360);
  const size =
    placement.mode === "dock"
      ? { width: placement.width, height: split.height || 360 }
      : { width: split.width, height: split.height };
  const style: React.CSSProperties =
    placement.mode === "dock" ? { width: placement.width } : { position: "absolute", inset: 0 };

  return (
    // `flex-1 min-h-0`: under the caption it takes exactly the height left, never `h-full`
    // (that overflowed the tile by one caption height, see `paneBodyView`).
    <div ref={ref} className="ibx-split flex-1 min-h-0" data-testid={`inbox-split-${tab.id}`}>
      <div className="ibx-split-term">{children}</div>
      {target && visible && (
        <div
          data-surface="canvas"
          hidden={!runningAgent}
          className={runningAgent ? "contents" : "hidden"}
        >
          <Suspense fallback={<div className="ibx-ov" style={style} />}>
            <ChatOverlay
              tabId={tab.id}
              sessionId={tab.sessionId}
              teamKey={teamKey}
              composeRequest={target.composeRequest}
              size={size}
              placement={placement.mode}
              visible={runningAgent}
              style={style}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * Drop a closed tab's remembered inbox width and lens so the maps stay bounded. A tab that only
 * left this tile (Hidden, moved to another tile, its workspace minimized) is still running and
 * keeps both.
 */
export function useInboxTabCleanup(tabs: readonly { id: string }[]): void {
  const running = useRunningTerminalTabIndex();
  const minimized = useMinimizedTerminalTabIndex();
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    const alive = new Set<string>();
    for (const index of [running, minimized])
      for (const byWorkspace of Object.values(index))
        for (const list of Object.values(byWorkspace)) for (const t of list) alive.add(t.id);
    const here = new Set(tabs.map((t) => t.id));
    const next = new Set(here);
    for (const id of known.current) {
      if (here.has(id)) continue;
      if (alive.has(id)) next.add(id);
      else cleanupAgentInboxRailTab(id);
    }
    known.current = next;
  }, [tabs, running, minimized]);
}
