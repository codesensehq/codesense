// SPDX-License-Identifier: MIT
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { MessageSquare, SquareTerminal } from "lucide-react";

import { InfoTip } from "@/components/ui/tooltip";
import type { CliNeedsKind } from "@/features/viewer/lib/session-status-signals";

export type ChatCliMode = "chat" | "cli";

/** From this measured pane width the segments carry words. */
export const SWITCH_LABELS_FROM_PX = 480;
/** From this measured pane width the key hint shows too. */
export const SWITCH_HINT_FROM_PX = 640;
/** The held-line count stops here ("999+"). */
const HELD_CAP = 999;

/** "214 new", or "999+ new" past the cap. */
export function heldLabel(lines: number): string {
  return `${lines > HELD_CAP ? `${HELD_CAP}+` : lines} new`;
}

const MODES: readonly ChatCliMode[] = ["chat", "cli"];

export interface ChatCliSwitchProps {
  tabId: string;
  /** What the tab shows now: its chat covering the terminal, or the CLI. */
  mode: ChatCliMode;
  /** The person chose `next`: by pointer (the caller moves focus into it) or by arrow key (focus
   *  stays on the switch). */
  onChange: (next: ChatCliMode, how: "pointer" | "keyboard") => void;
  /** The pane's measured width in px: words from 480, the key hint from 640. */
  width: number;
  /** Messages to this tab not yet read: a count on the Chat segment. */
  unread: number;
  /** What the unread count is made of, for the tooltip ("2 messages · 1 in group chat"). */
  unreadDetail?: string;
  /** Lines of output the CLI held back while the chat covered it. */
  heldLines: number;
  /** What the CLI is waiting on (a permission prompt, a startup screen, a question). */
  needs: CliNeedsKind | null;
  /** The key that flips the tab, as displayed ("⌘I"). */
  shortcut: string;
  /** A CLI started by hand that the chat covers once it is Ready: its name ("Claude"). While
   *  the CLI shows, the Chat segment carries a dashed ring and says so, and choosing the CLI
   *  segment again calls `onChange("cli")` to keep the tab there. */
  pendingCover?: string | null;
}

/**
 * The tab caption's Chat | CLI switch: an ARIA radio group. While the chat covers the tab the
 * CLI segment says what it is holding ("214 new", or a dot on icons only) and, when it needs the
 * person, turns to the needs tone ("Input needed", or a ring on icons only).
 */
export function ChatCliSwitch({
  tabId,
  mode,
  onChange,
  width,
  unread,
  unreadDetail,
  heldLines,
  needs,
  shortcut,
  pendingCover = null,
}: ChatCliSwitchProps) {
  const refs = useRef<Partial<Record<ChatCliMode, HTMLButtonElement | null>>>({});
  // An arrow key moves the selection and keeps focus on the switch, on the segment that is now
  // selected once the new mode has rendered.
  const focusNext = useRef<ChatCliMode | null>(null);
  useLayoutEffect(() => {
    if (focusNext.current !== mode) return;
    focusNext.current = null;
    refs.current[mode]?.focus();
  }, [mode]);
  const labels = width >= SWITCH_LABELS_FROM_PX;
  const hint = width >= SWITCH_HINT_FROM_PX && shortcut !== "";
  // What the CLI holds shows only while the chat covers it.
  const covered = mode === "chat";
  const flagged = covered && needs !== null;
  const held = covered && !flagged && heldLines > 0 ? heldLines : 0;

  const pending = mode === "cli" && !!pendingCover;
  const choose = (next: ChatCliMode, how: "pointer" | "keyboard") => {
    // Before the chat first covers a CLI started by hand, choosing the CLI it already shows is
    // the person's choice to stay there: the caller records it, and the chat never covers.
    if (next === mode && !(pending && next === "cli")) return;
    focusNext.current = how === "keyboard" && next !== mode ? next : null;
    onChange(next, how);
  };
  const onArrow = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = MODES.indexOf(mode);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? MODES[(at + 1) % MODES.length]
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? MODES[(at + MODES.length - 1) % MODES.length]
          : e.key === "Home"
            ? MODES[0]
            : e.key === "End"
              ? MODES[MODES.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    choose(next, "keyboard");
  };

  const chatName = unread > 0 ? `Chat, ${unread} unread` : "Chat";
  const cliName = flagged
    ? "CLI, input needed"
    : held > 0
      ? `CLI, ${held} new ${held === 1 ? "line" : "lines"}`
      : "CLI";
  const keys = shortcut ? ` (${shortcut})` : "";
  const chatTip =
    mode === "chat"
      ? "Chat"
      : pending
        ? `Chat covers this tab when ${pendingCover} is Ready.`
        : `Show chat${keys}`;
  const cliTip = flagged
    ? `The CLI needs your input. Show CLI${keys}`
    : held > 0
      ? `Show CLI${keys}. ${held} new ${held === 1 ? "line" : "lines"}. Rendering is paused while the chat shows; nothing is lost.`
      : mode === "cli"
        ? "CLI"
        : `Show CLI${keys}`;

  return (
    <div
      role="radiogroup"
      aria-label="Chat or CLI"
      className="ibx-sw"
      data-labels={labels ? "true" : undefined}
      // The chat that appears under it must not take the focus an arrow key keeps here.
      data-keeps-focus=""
      data-testid={`chat-cli-switch-${tabId}`}
    >
      <InfoTip
        label={unread > 0 && unreadDetail ? `${chatTip}. ${unreadDetail}` : chatTip}
        side="bottom"
      >
        <button
          type="button"
          role="radio"
          ref={(el) => {
            refs.current.chat = el;
          }}
          aria-checked={mode === "chat"}
          aria-label={chatName}
          tabIndex={mode === "chat" ? 0 : -1}
          data-testid={`chat-cli-switch-${tabId}-chat`}
          data-pending={pending ? "true" : undefined}
          aria-description={pending ? chatTip : undefined}
          className="ibx-sw-seg"
          onClick={() => choose("chat", "pointer")}
          onKeyDown={onArrow}
        >
          <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
          {labels && <span>Chat</span>}
          {unread > 0 && (
            <span className="ibx-sw-count" aria-hidden="true">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
          {hint && mode === "cli" && <kbd className="ibx-sw-kbd">{shortcut}</kbd>}
        </button>
      </InfoTip>
      <InfoTip label={cliTip} side="bottom">
        <button
          type="button"
          role="radio"
          ref={(el) => {
            refs.current.cli = el;
          }}
          aria-checked={mode === "cli"}
          aria-label={cliName}
          tabIndex={mode === "cli" ? 0 : -1}
          data-testid={`chat-cli-switch-${tabId}-cli`}
          data-needs={flagged ? "true" : undefined}
          className="ibx-sw-seg"
          onClick={() => choose("cli", "pointer")}
          onKeyDown={onArrow}
        >
          <SquareTerminal size={14} strokeWidth={1.75} aria-hidden />
          {labels && <span>CLI</span>}
          {labels && flagged && <span className="ibx-sw-more">Input needed</span>}
          {labels && held > 0 && <span className="ibx-sw-more">{heldLabel(held)}</span>}
          {!labels && held > 0 && <span className="ibx-sw-dot" data-held-dot aria-hidden="true" />}
          {hint && mode === "chat" && <kbd className="ibx-sw-kbd">{shortcut}</kbd>}
        </button>
      </InfoTip>
    </div>
  );
}
