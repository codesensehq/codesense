// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState } from "react";

import { agentPins, type AgentPin, type InboxTeam } from "@/tauri/commands";

import type { ConversationMessage } from "../api";
import { msgKey } from "../model";
import { PIN_CAP, capLabel, capNote, liveText, pinTitleOf, whoPinned } from "../lib/person-pins";

/** A note under one message: the cap, a pin or unpin that failed, or the Undo of an unpin. */
export type PinNote =
  | { mid: string; kind: "cap"; text: string }
  | {
      mid: string;
      kind: "pin-failed" | "unpin-failed" | "restore-failed" | "undo";
      message: ConversationMessage;
    };

/** One message's Pin, as its action row (or an HTML message's title bar) draws it. */
export type PinState = {
  /** Who pinned it ("you" or the agent's name); null when it isn't pinned. */
  pinnedBy: string | null;
  /** At the cap and not pinned: Pin is dimmed (aria-disabled, still focusable). */
  atCap: boolean;
  /** The accessible name: Pin, Unpin, or the cap. */
  label: string;
  /** A pin or unpin of this message is on its way. */
  busy: boolean;
};

export type PersonPins = {
  stateOf(m: ConversationMessage): PinState;
  /** Pin it, unpin it, or (at the cap) say whose pins fill the list. */
  toggle(m: ConversationMessage): void;
  /** The Undo of the last unpin. */
  undo(): void;
  /** Try the failed pin, unpin or Undo again. */
  retry(): void;
  /** Esc: close the note and end the Undo. */
  dismiss(): void;
  /** Show pins: move focus to the Pinned block. */
  showPins(): void;
  note: PinNote | null;
  /** What the polite live region says now. */
  live: string;
  /** The pin just made or restored: marked new until the next click or key press. */
  fresh: number | null;
};

/**
 * The person pins a chat's messages into its agent thread (saved agent + story) in `team`'s
 * store, and unpins them, with an Undo. `pins` is the thread's list and `apply` shows the list
 * a call returned. The cap is shared with the agent: at the cap every Pin is dimmed and a
 * click says whose pins fill the list; nothing is replaced. Undo lasts until the next pin,
 * unpin or Esc; nothing here runs on a timer.
 */
export function usePersonPins({
  team,
  agentId,
  storyId,
  pins,
  apply,
  sender,
  labelOf,
  onShowPins,
}: {
  team: InboxTeam | null;
  agentId: string | null;
  storyId: string | null;
  pins: AgentPin[];
  apply: (pins: AgentPin[]) => void;
  /** Who sent a message, by name, for an HTML message's fallback title. */
  sender: (m: ConversationMessage) => string;
  labelOf: (from: string) => string;
  onShowPins: () => void;
}): PersonPins | null {
  const [note, setNote] = useState<PinNote | null>(null);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  // The new pin stays marked until the person's next click or key press: input events, no timer.
  useEffect(() => {
    if (fresh === null) return;
    const clear = () => setFresh(null);
    window.addEventListener("keydown", clear, { capture: true, once: true });
    window.addEventListener("pointerdown", clear, { capture: true, once: true });
    return () => {
      window.removeEventListener("keydown", clear, { capture: true });
      window.removeEventListener("pointerdown", clear, { capture: true });
    };
  }, [fresh]);
  const byId = useMemo(() => new Map(pins.map((p) => [p.messageId, p])), [pins]);
  const thread = team && agentId ? { team, agentId, storyId } : null;

  const call = useCallback(
    async (
      m: ConversationMessage,
      op: "pin" | "unpin" | "restore",
      messageId: number,
    ): Promise<boolean> => {
      if (!thread) return false;
      const mid = msgKey(m);
      setBusy(mid);
      try {
        const r = await agentPins(thread.team, thread.agentId, thread.storyId, { op, messageId });
        if (r.status !== "pins") throw new Error(r.message);
        apply(r.pins);
        const done = op === "pin" ? "pinned" : op === "unpin" ? "unpinned" : "restored";
        setLive(liveText(done, pinTitleOf(m, sender(m)), r.pins.length));
        setNote(op === "unpin" ? { mid, kind: "undo", message: m } : null);
        setFresh(op === "unpin" ? null : messageId);
        return true;
      } catch {
        const kind =
          op === "unpin" ? "unpin-failed" : op === "restore" ? "restore-failed" : "pin-failed";
        setNote({ mid, kind, message: m });
        return false;
      } finally {
        setBusy(null);
      }
    },
    // `thread` is named by its fields; its object identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread?.team.org, thread?.team.team, thread?.agentId, thread?.storyId, apply, sender],
  );

  if (!thread) return null;
  const pinOf = (m: ConversationMessage) => (sameThreadTeam(m, team) ? byId.get(m.id) : undefined);
  const full = pins.length >= PIN_CAP;
  return {
    stateOf(m) {
      const pin = pinOf(m);
      const atCap = !pin && full;
      return {
        pinnedBy: pin ? whoPinned(pin.pinnedBy, labelOf) : null,
        atCap,
        label: pin ? "Unpin" : atCap ? `Pin (${capLabel(pins.length)})` : "Pin",
        busy: busy === msgKey(m),
      };
    },
    toggle(m) {
      if (busy) return;
      const pin = pinOf(m);
      if (pin) return void call(m, "unpin", m.id);
      if (full) {
        const text = capNote(pins, labelOf);
        setNote({ mid: msgKey(m), kind: "cap", text });
        setLive(text);
        return;
      }
      void call(m, "pin", m.id);
    },
    undo() {
      if (note?.kind !== "undo" || busy) return;
      void call(note.message, "restore", note.message.id);
    },
    retry() {
      if (busy || !note || note.kind === "cap" || note.kind === "undo") return;
      const op =
        note.kind === "unpin-failed" ? "unpin" : note.kind === "restore-failed" ? "restore" : "pin";
      void call(note.message, op, note.message.id);
    },
    dismiss() {
      setNote(null);
    },
    showPins() {
      setNote(null);
      onShowPins();
    },
    note,
    live,
    fresh,
  };
}

/** A message is in the thread's store when it was read from the thread's team. */
function sameThreadTeam(m: ConversationMessage, team: InboxTeam | null) {
  return !team || !m.team || (m.team.org === team.org && m.team.team === team.team);
}
