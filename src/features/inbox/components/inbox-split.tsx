// SPDX-License-Identifier: MIT
import { useRunningAgent } from "@/features/viewer/lib/hand-agents";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useAgentInboxRailStore } from "@/features/viewer/stores/agent-inbox-rail-store";

// The chat (markdown renderer, thread) loads only once some tab opens it.
const ChatOverlay = lazy(() => import("./chat-overlay").then((m) => ({ default: m.ChatOverlay })));

/** What the overlay's layout is read from before the tab has been measured (and where no
 *  layout exists at all). */
const UNMEASURED = { width: 640, height: 480 };

/**
 * A tab's body under its caption: the terminal and, once the tab has a chat, the agent's chat
 * overlay, which covers the whole tab while it is shown. The terminal keeps the same parent
 * element whether or not the chat shows, so opening it never remounts (or re-attaches) the
 * terminal; while the chat covers it the terminal is parked and takes no keys. Flipped to the
 * CLI, the chat stays mounted out of sight, so flipping back keeps its thread, scroll and draft.
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
  const shown = target?.shown === true;
  const hasChat = !!target;
  const ref = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!visible || !hasChat || !el) return;
    // Measured before the first paint, so a narrow tab never shows the wrong layout for a frame.
    const measure = ({ width, height }: { width: number; height: number }) =>
      setSplit((was) => (was.width === width && was.height === height ? was : { width, height }));
    measure(el.getBoundingClientRect());
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) measure(r);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasChat, visible]);
  const size = split.width > 0 ? split : UNMEASURED;
  const style: React.CSSProperties = { position: "absolute", inset: 0 };

  const covered = shown && runningAgent && visible;

  return (
    // `flex-1 min-h-0`: under the caption it takes exactly the height left, never `h-full`
    // (that overflowed the tile by one caption height, see `paneBodyView`).
    <div ref={ref} className="ibx-split flex-1 min-h-0" data-testid={`inbox-split-${tab.id}`}>
      {/* Covered by the chat, the terminal takes no keys and no focus until the chat is hidden. */}
      <div className="ibx-split-term" inert={covered}>
        {children}
      </div>
      {/* Hidden behind the CLI, the chat keeps its layout box (`visibility`, not `display`, so
          its scroll position holds) and takes no keys, clicks or focus. */}
      {target && visible && (
        <div
          data-surface="canvas"
          hidden={!runningAgent}
          className={runningAgent ? "contents" : "hidden"}
          style={shown ? undefined : { visibility: "hidden" }}
          inert={!shown}
        >
          <Suspense fallback={<div className="ibx-ov" style={style} />}>
            <ChatOverlay
              tabId={tab.id}
              sessionId={tab.sessionId}
              teamKey={teamKey}
              composeRequest={target.composeRequest}
              size={size}
              visible={runningAgent && shown}
              style={style}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
