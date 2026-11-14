// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, SquareTerminal, X } from "lucide-react";

import { RemoteServerUpdateAction } from "@/features/viewer/components/remote-server-update";
import { useAgentStatusOf } from "@/features/viewer/hooks/use-agent-status-of";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { agentKeyOfRevision } from "@/features/viewer/lib/agent-rows";
import { formatElapsed } from "@/features/viewer/lib/agent-row-presentation";
import {
  closeAgentInboxRailToTerminal,
  markAgentInboxRailComposeHandled,
  useAgentInboxRailComposeHandled,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";
import { StatusMark } from "@/shared/components/status-mark";
import { useNow } from "@/shared/hooks/use-now";
import { formatKeystrokeDisplay } from "@/shared/lib/shortcuts/keystroke";
import { findShortcutAction } from "@/shared/lib/shortcuts/registry";
import { markOfAgentStatus } from "@/shared/lib/status-mark";
import { agentStatusWords } from "@/shared/lib/terminal-dot-words";
import { useSubagentsOpen } from "@/shared/stores/agent-state-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { markInboxMessageRead, type AgentSessionRow } from "@/tauri/commands";

import type { ConversationMessage } from "../api";
import { goToSession } from "../actions";
import { useAgentConversation } from "../hooks/use-agent-conversation";
import { useAgentPins } from "../hooks/use-agent-pins";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { useInboxSessions } from "../hooks/use-inbox-sessions";
import { useSessionInbox } from "../hooks/use-session-inbox";
import { openAgentFullView, teamAgentPage } from "../lib/agent-full-view";
import { createDeliveryTracker } from "../lib/delivery-marks";
import { overlayLayout, type OverlayRecordField } from "../lib/overlay-layout";
import { HUMAN, msgKey, sameTeam } from "../model";
import { InboxViewProvider, type InboxView } from "./inbox-view-context";
import { GroupChatPane, type GroupRoom } from "./group-chat";
import { Ico, InboxLoading, MessageBody, ReadFailure, StaleNotice } from "./primitives";
import { PinPreview } from "./pin-preview";
import { Conversation } from "./threads-lens";

/**
 * The shortcut that flips a covered tab between its chat and its terminal (and opens or closes a
 * docked chat). One place, so the key can change without touching the overlay.
 */
export const CHAT_TERMINAL_SHORTCUT_ID = "viewer.toggle-agent-inbox";

const NO_ROWS: readonly AgentSessionRow[] = [];

/**
 * An agent's chat on its own terminal tab: the conversation with you (the same thread its full
 * view shows), its pins as previews shaped by the pane, and a one-line composer. Every part
 * reads the pane's width and height through {@link overlayLayout}, so one markup serves a
 * 250 × 250 tile and a 900 × 250 strip. `placement` says whether it docks beside the terminal
 * or covers the tab.
 */
export function ChatOverlay({
  tabId,
  sessionId,
  teamKey,
  composeRequest,
  size,
  placement,
  visible = true,
  style,
}: {
  tabId: string;
  sessionId: string;
  teamKey: string;
  composeRequest: number;
  /** The overlay's own size: what its layout is read from. */
  size: { width: number; height: number };
  placement: "dock" | "cover";
  visible?: boolean;
  style?: React.CSSProperties;
}) {
  const roster = useAgentListProjectionStore((s) => s.sessions);
  const row = roster?.find((r) => r.sessionId === sessionId) ?? null;
  const { data, source, error, reload } = useSessionInbox(sessionId);
  const handle = data?.handle ?? row?.handle ?? "";
  const name = row?.displayName || handle || sessionId;
  const statusRows = useMemo(() => (row ? [row] : NO_ROWS), [row]);
  const statusOf = useAgentStatusOf(statusRows);
  const status = row ? statusOf(row) : null;
  const subagents = useSubagentsOpen(sessionId);
  const sessions = useInboxSessions();
  const rootRef = useRef<HTMLElement>(null);
  const layout = overlayLayout(size.width, size.height);
  const tall = layout.height === "tall";

  // The chat's team is fixed while it shows this session, as the quick chat's is.
  const chatKey = JSON.stringify([teamKey, sessionId]);
  const { messages, home, team, teamMessages, conversation, dir, roles } = useAgentConversation({
    data,
    source,
    handle,
    teamKey,
    chatKey,
  });
  // Queued or Delivered on what you send here, by the kit's rule; the lead is its sessions() row.
  const lead = sessions?.find((s) => s.handle === handle) ?? null;
  const [tracked, setTracked] = useState({ chatKey, tracker: createDeliveryTracker() });
  if (tracked.chatKey !== chatKey) setTracked({ chatKey, tracker: createDeliveryTracker() });
  const tracker = tracked.tracker;
  // What the chat opens on is history: the tracker reads only once the thread has loaded.
  if (data !== null) tracker.observe(conversation, handle, lead);
  const marks = (m: ConversationMessage) => tracker.markOf(m, lead);
  const view: InboxView = useMemo(
    () => ({
      me: HUMAN,
      targets: [handle],
      dir,
      messages: teamMessages,
      roles,
      held: [],
      // Per tab and session: a new session in the tab starts a fresh draft.
      drafts: `tab:${tabId}:${sessionId}`,
      fallbackTeam: team ?? home,
      source,
      // Everything here goes to this agent: no Reply chips to aim elsewhere.
      replyTo: () => {},
      goTo: (key) => void goToSession(key),
    }),
    [handle, dir, teamMessages, roles, tabId, sessionId, team, home, source],
  );

  // On screen, the chat reads what the agent sent you, as the rail did; nothing else is marked.
  const windowShown = useDocumentVisible();
  const marked = useRef(new Set<string>());
  useEffect(() => {
    if (!visible || source !== "live" || !windowShown) return;
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    for (const m of conversation) {
      const k = msgKey(m);
      if (m.from !== handle || !m.unread || marked.current.has(k)) continue;
      marked.current.add(k);
      void markInboxMessageRead(m.team, m.id).catch(() => marked.current.delete(k));
    }
  }, [visible, source, windowShown, conversation, handle]);

  // "Message this agent" from elsewhere focuses the composer once it shows.
  const composeHandled = useAgentInboxRailComposeHandled(sessionId);
  const loaded = data !== null;
  useEffect(() => {
    if (composeRequest <= composeHandled || !loaded) return;
    markAgentInboxRailComposeHandled(sessionId, composeRequest);
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLTextAreaElement>(".ibx-comp textarea")?.focus(),
    );
  }, [composeRequest, composeHandled, loaded, sessionId]);

  // The room this session shares with the rest of its workspace: ⌘⌥G flips the chat to it.
  const workspaceId = lead?.chatWorkspaceId ?? row?.chatWorkspaceId;
  const room: GroupRoom | null = workspaceId
    ? {
        workspaceId,
        sessions: [
          {
            handle,
            name,
            unread: lead?.groupUnread ?? row?.groupUnread ?? 0,
            readId: lead?.groupReadId ?? row?.groupReadId ?? 0,
          },
        ],
      }
    : null;
  const [group, setGroup] = useState<{ session: string; shown: boolean; focus: number }>({
    session: sessionId,
    shown: false,
    focus: 0,
  });
  // Another session starts on its own chat, with no pin open.
  const [openPin, setOpenPin] = useState<number | null>(null);
  if (group.session !== sessionId) {
    setGroup({ session: sessionId, shown: false, focus: 0 });
    setOpenPin(null);
  }
  const groupShown = group.shown && room !== null;
  const groupRequest = useAgentInboxRailStore((s) => s.bySession[sessionId]?.groupRequest ?? 0);
  const groupHandled = useAgentInboxRailStore((s) => s.bySession[sessionId]?.groupHandled ?? 0);
  const roomKnown = sessions !== null;
  const hasRoom = room !== null;
  useEffect(() => {
    if (groupRequest <= groupHandled || !loaded || !roomKnown) return;
    const frame = requestAnimationFrame(() => {
      // A session with no room has nothing to open: the request ends here.
      if (hasRoom) setGroup((g) => ({ ...g, shown: !g.shown, focus: g.shown ? 0 : g.focus + 1 }));
      useAgentInboxRailStore.getState().markGroupHandled(sessionId, groupRequest);
    });
    return () => cancelAnimationFrame(frame);
  }, [groupRequest, groupHandled, loaded, roomKnown, hasRoom, sessionId]);

  // The thread is the saved agent and story the session was launched with, as the engine keys
  // it: the launch's agent, else the one its tab says it runs.
  const { pins } = useAgentPins(
    team ?? home,
    lead?.agent ?? agentKeyOfRevision(row?.agentRevision),
    row?.story ?? lead?.story ?? null,
  );
  const pinTitle = (id: number) => {
    const m = messages.find((x) => x.id === id && (!team || sameTeam(x.team, team)));
    return m?.summary || m?.text.split("\n")[0] || `Pin ${id}`;
  };
  const opened = pins.find((p) => p.messageId === openPin) ?? null;
  const openedMessage = opened
    ? (messages.find((m) => m.id === opened.messageId && (!team || sameTeam(m.team, team))) ?? null)
    : null;
  const pinRefs = useRef(new Map<number, HTMLButtonElement>());
  const closePin = () => {
    const id = openPin;
    setOpenPin(null);
    if (id !== null) pinRefs.current.get(id)?.focus();
  };
  // Open on a tall pane, the pins fold to the line above the sheet; shorter, the sheet takes
  // the chat's place.
  const pinShape = opened && tall ? "line" : layout.pins;
  const sheetInPlace = opened !== null && !tall;

  // The team's own agent page (teams.yml `agent_page:`); a team without one has no Full view.
  const agentPage = useOrgStore((state) =>
    team ? teamAgentPage(state.orgs, team.org, team.team) : null,
  );
  const keyHint = formatKeystrokeDisplay(
    findShortcutAction(CHAT_TERMINAL_SHORTCUT_ID)?.defaultKeystroke ?? "",
  );
  const toTerminal = () =>
    closeAgentInboxRailToTerminal(
      sessionId,
      rootRef.current?.closest("[data-pane-id], [data-pane-active]") ?? null,
    );

  // Covering the tab, the chat takes the keyboard from the terminal it hides: focus lands in
  // its composer once that shows (or on the chat itself while it loads), unless it is already
  // inside it (the chat itself, held while it loads, gives way to the composer).
  useEffect(() => {
    const root = rootRef.current;
    const held = document.activeElement;
    if (placement !== "cover" || !visible || !root || (held !== root && root.contains(held)))
      return;
    const composer = root.querySelector<HTMLTextAreaElement>(".ibx-comp textarea");
    (composer ?? root).focus({ preventScroll: true });
  }, [placement, visible, loaded, groupShown]);

  const now = useNow(visible, 60_000);
  const statusWord = status ? agentStatusWords(status, subagents) : null;
  // The model, cost and files fields wait on a per-agent session record read.
  const recordText: Partial<Record<OverlayRecordField, string | null>> = {
    time: formatElapsed(row?.startedAtMs ?? null, now),
    story: row?.story ?? null,
  };
  const recordParts = [
    ...(layout.statusInRecord && statusWord ? [statusWord] : []),
    ...layout.recordFields.map((f) => recordText[f]).filter((v): v is string => !!v),
  ];
  const record = recordParts.length > 0 && (
    <span className="ibx-ov-record" data-testid="chat-overlay-record">
      {recordParts.join(" · ")}
    </span>
  );
  const button = (label: string, icon: typeof X, onClick: () => void, title = label) => (
    <button type="button" className="ibx-ov-btn" aria-label={label} title={title} onClick={onClick}>
      <Ico icon={icon} sm />
      {!layout.iconButtons && <span>{label}</span>}
    </button>
  );

  return (
    <InboxViewProvider value={view}>
      <aside
        ref={rootRef}
        className="ibx ibx-ov"
        aria-label={`Chat with ${name}`}
        data-testid="chat-overlay"
        data-session-id={sessionId}
        data-placement={placement}
        data-width={layout.width}
        data-height={layout.height}
        data-head={layout.head}
        data-record={layout.record}
        data-pins={pinShape}
        data-avatars={layout.avatars ? "true" : "false"}
        style={{ ...style, fontSize: layout.textPx }}
        onKeyDown={(e) => {
          const t = e.target as HTMLElement;
          if (e.key !== "Escape" || e.defaultPrevented || t.matches("input, textarea")) return;
          e.preventDefault();
          if (opened) closePin();
          else if (groupShown) setGroup((g) => ({ ...g, shown: false }));
          else toTerminal();
        }}
      >
        <header className="ibx-ov-head">
          <div className="ibx-ov-line">
            {status && <StatusMark mark={markOfAgentStatus(status)} />}
            <span className="ibx-ov-name">{name}</span>
            {layout.showKind && row?.role && <span className="ibx-ov-kind">{row.role}</span>}
            {layout.head === "one-line" && !layout.statusInRecord && statusWord && (
              <span className="ibx-ov-now">{statusWord}</span>
            )}
            {layout.head === "one-line" && (
              <RemoteServerUpdateAction sessionId={sessionId} className="ibx-rh-update" />
            )}
            {layout.record === "in-head" && record}
            <span className="ibx-ov-sp" />
            {button(
              "Terminal",
              SquareTerminal,
              toTerminal,
              keyHint ? `Terminal (${keyHint} brings the chat back)` : "Terminal",
            )}
            {agentPage &&
              team &&
              handle &&
              button("Full view", Maximize2, () =>
                openAgentFullView({ org: team.org, team: team.team, handle, page: agentPage }),
              )}
          </div>
          {layout.head === "two-line" && statusWord && (
            <div className="ibx-ov-now">
              {statusWord}
              <RemoteServerUpdateAction sessionId={sessionId} className="ibx-rh-update" />
            </div>
          )}
          {layout.record === "own-line" && record}
        </header>
        {pins.length > 0 && (
          <div className="ibx-ov-pins" data-shape={pinShape} role="group" aria-label="Pinned">
            {pins.map((p) => (
              <PinPreview
                key={p.messageId}
                ref={(el) => {
                  if (el) pinRefs.current.set(p.messageId, el);
                  else pinRefs.current.delete(p.messageId);
                }}
                pin={p}
                shape={pinShape}
                title={pinTitle(p.messageId)}
                tall={tall}
                open={p.messageId === openPin}
                onOpen={() => setOpenPin(p.messageId === openPin ? null : p.messageId)}
              />
            ))}
          </div>
        )}
        {opened && (
          <section
            className="ibx-ov-sheet"
            data-in-place={sheetInPlace ? "true" : "false"}
            aria-label={opened.preview?.shortName || pinTitle(opened.messageId)}
          >
            <div className="ibx-ov-sheet-h">
              <b>{opened.preview?.shortName || pinTitle(opened.messageId)}</b>
              <span className="ibx-ov-sp" />
              <button
                type="button"
                className="ibx-ov-btn"
                aria-label={`Close ${opened.preview?.shortName || pinTitle(opened.messageId)}`}
                onClick={closePin}
              >
                <Ico icon={X} sm />
              </button>
            </div>
            <div className="ibx-ov-sheet-b">
              {openedMessage ? (
                <MessageBody m={openedMessage} liveDashboards />
              ) : (
                <span className="ibx-ov-gone">This view is no longer in the thread.</span>
              )}
            </div>
          </section>
        )}
        {error && data && <StaleNotice error={error} onRetry={() => void reload()} />}
        {!sheetInPlace && (
          // Keyed by session: no draft or recipient carries into another session's chat.
          <div className="ibx-body ibx-ov-chat" key={sessionId}>
            {error && !data ? (
              <ReadFailure what={`${name}'s chat`} error={error} onRetry={() => void reload()} />
            ) : !data ? (
              <InboxLoading what={`${name}'s chat`} />
            ) : groupShown && room ? (
              <GroupChatPane
                room={room}
                onBack={() => setGroup((g) => ({ ...g, shown: false }))}
                focusRequest={group.focus}
                visible={visible}
                human
              />
            ) : (
              <Conversation
                thread={{ key: handle, messages: conversation }}
                request={null}
                defaultTo={handle}
                quick
                marks={marks}
                empty={
                  <div className="ibx-empty" data-testid="chat-overlay-empty">
                    <strong>No messages yet</strong>
                    What you send lands in {name}&apos;s inbox.
                  </div>
                }
              />
            )}
          </div>
        )}
      </aside>
    </InboxViewProvider>
  );
}
