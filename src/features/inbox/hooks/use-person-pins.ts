// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentPins, type AgentPin, type InboxTeam } from "@/tauri/commands";

import type { ConversationMessage } from "../api";
import { formatClock, msgKey } from "../model";
import {
  pinChooserArrive,
  pinChooserChoose,
  pinChooserOpen,
  pinChooserRoom,
  pinChooserSync,
  type PinChooserState,
} from "../lib/chat-core";
import {
  PIN_CAP,
  REPLACE_FAILED,
  UNDO_FULL,
  UNDO_GONE,
  capNote,
  chooserHeading,
  liveText,
  pinTitleOf,
  pinnedAtLine,
  pinnedMeanwhileText,
  replaceLabel,
  replacedText,
  whoPinned,
} from "../lib/person-pins";

/** A note under one message: the cap, a pin or unpin that failed, the Undo of an unpin or of
 *  a replace, or a line that says why an Undo went away. */
export type PinNote =
  | { mid: string; kind: "cap" | "info"; text: string }
  | {
      mid: string;
      kind: "pin-failed" | "unpin-failed" | "restore-failed" | "undo";
      message: ConversationMessage;
    }
  | {
      mid: string;
      kind: "replaced" | "replace-undo-failed";
      message: ConversationMessage;
      /** The pin that was replaced, to bring back. */
      replaced: AgentPin;
      text: string;
    };

/** One message's Pin, as its action row (or an HTML message's title bar) draws it. */
export type PinState = {
  /** Who pinned it ("you" or the agent's name); null when it isn't pinned. */
  pinnedBy: string | null;
  /** At the cap and not pinned: Pin… opens the chooser of which pin to replace. */
  atCap: boolean;
  /** The accessible name: Pin, Unpin, or Pin… at the cap. */
  label: string;
  /** A pin or unpin of this message is on its way. */
  busy: boolean;
  /** Its chooser is open. */
  choosing: boolean;
  /** At the cap: how many are pinned, for the icon-only Pin…. */
  capCount: number | null;
};

/** One row of the chooser: a pin as the list shows it. */
export type ChooserRow = {
  pin: AgentPin;
  title: string;
  /** "Pinned by Story lead at 13:31". */
  line: string;
  /** Your own pin, drawn as the strip draws it: a quote or a dashboard's name. */
  own: "quote" | "name" | null;
  /** The agent added it while the chooser was open. */
  isNew: boolean;
  /** It can be replaced: not new, or the person has arrived on it since. */
  armed: boolean;
};

/** The chooser under a message at the cap. */
export type PinChooser = {
  mid: string;
  id: string;
  heading: string;
  rows: ChooserRow[];
  /** The row the keys, the pointer (with focus inside) and the strip's mark name. */
  current: number | null;
  /** What changed in the list, or why a choice didn't replace yet. */
  change: string | null;
  /** A replace that failed. */
  error: string | null;
  /** A pin left: there's room now, and a plain Pin pins. */
  room: string | null;
  busy: boolean;
};

export type PersonPins = {
  stateOf(m: ConversationMessage): PinState;
  /** Pin it, unpin it, or (at the cap) open or close its chooser. */
  toggle(m: ConversationMessage): void;
  /** The Undo of the last unpin or replace. */
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
  /** The pin just made, replaced in or restored: marked new until the next click or key press. */
  fresh: number | null;
  /** The open chooser, if any. */
  chooser: PinChooser | null;
  /** Move the chooser's current row (the person arrived on it). */
  chooserMove(messageId: number): void;
  /** Choose a row: replace it, or, on a row new since the chooser opened, arrive first. */
  choose(messageId: number): void;
  /** Pin with the room a pin that left made. */
  pinInRoom(): void;
  /** Close the chooser; focus goes back to Pin…. */
  closeChooser(): void;
  /** The pin the chooser would replace, for the Pinned strip's mark. */
  replacing: number | null;
  /** A message whose Pin should take focus (after a replace or its Undo). */
  focusPin: string | null;
  focusDone(): void;
};

/** The open chooser: chat-core's chooser state (the pins it opened on plus the rows arrived on
 *  since, the list as last drawn, the current row, what changed, a failed replace), under one
 *  message. The kit's chooser runs the same rules. */
type Open = PinChooserState<AgentPin> & {
  mid: string;
  message: ConversationMessage;
};

/**
 * The person pins a chat's messages into its agent thread (saved agent + story) in `team`'s
 * store, and unpins them, with an Undo. `pins` is the thread's list and `apply` shows the list
 * a call returned. The cap is shared with the agent: at the cap Pin… opens a chooser under the
 * message, and one choice replaces that pin in its place, with one Undo for both. Undo lasts
 * until the next pin, unpin or Esc; nothing here runs on a timer.
 */
export function usePersonPins({
  team,
  agentId,
  storyId,
  pins,
  apply,
  sender,
  labelOf,
  titleOf,
  ownOf = () => null,
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
  /** A pin's name as the Pinned strip shows it. */
  titleOf: (pin: AgentPin) => string;
  /** How the strip draws a pin sent without a preview (the person's own). */
  ownOf?: (pin: AgentPin) => "quote" | "name" | null;
  onShowPins: () => void;
}): PersonPins | null {
  const [note, setNote] = useState<PinNote | null>(null);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [focusPin, setFocusPin] = useState<string | null>(null);
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
  // The list as it stands when an async call settles, for the note a refused Undo shows.
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const thread = team && agentId ? { team, agentId, storyId } : null;

  // The chooser follows the live list: it says what changed, and the row the person was on
  // stops being current if it left. If the agent pinned this message, it closes.
  useEffect(() => {
    if (!open) return;
    const next = pinChooserSync(open, pins, open.message.id, titleOf);
    if (!next) return;
    if ("pinned" in next) {
      setOpen(null);
      setNote({
        mid: open.mid,
        kind: "info",
        text: pinnedMeanwhileText(whoPinned(next.pinned.pinnedBy, labelOf)),
      });
      return;
    }
    setOpen(next.state);
    // `open` is replaced here; only the list drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);

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
      } catch (error) {
        // An Undo refused because the list filled meanwhile says so, as a Pin at the cap
        // does: a retry could not succeed.
        if (
          op === "restore" &&
          /at most \d+ pins/.test(String((error as Error)?.message ?? error))
        ) {
          const text = capNote(pinsRef.current, labelOf);
          setNote({ mid, kind: "cap", text });
          setLive(text);
          return false;
        }
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

  /** Replace `old` with message `m`, in its place. */
  const replace = async (m: ConversationMessage, old: AgentPin) => {
    if (!thread || !open) return;
    const mid = msgKey(m);
    setBusy(mid);
    try {
      const r = await agentPins(thread.team, thread.agentId, thread.storyId, {
        op: "replace",
        messageId: m.id,
        replaces: old.messageId,
      });
      if (r.status !== "pins") throw new Error(r.message);
      apply(r.pins);
      const text = replacedText(whoPinned(old.pinnedBy, labelOf), titleOf(old));
      setOpen(null);
      setNote({ mid, kind: "replaced", message: m, replaced: old, text });
      setLive(text);
      setFresh(m.id);
      setFocusPin(mid);
    } catch {
      // Nothing changed: the chooser stays on its row and says so. A list that moved on
      // reaches the chooser through the change event.
      setOpen((o) => (o ? { ...o, error: REPLACE_FAILED } : o));
    } finally {
      setBusy(null);
    }
  };

  /** One Undo for a replace: the new pin goes and the old one comes back, in one step. */
  const undoReplace = async (n: Extract<PinNote, { kind: "replaced" | "replace-undo-failed" }>) => {
    if (!thread) return;
    setBusy(n.mid);
    try {
      const r = await agentPins(thread.team, thread.agentId, thread.storyId, {
        op: "restore",
        messageId: n.replaced.messageId,
        replacing: n.message.id,
      });
      if (r.status !== "pins") {
        // The engine refused: the list has no room for the old pin, or its message is gone.
        // Retrying can't help, so Undo goes away and the note says which, from the list.
        const text = pinsRef.current.length >= PIN_CAP ? UNDO_FULL : UNDO_GONE;
        setNote({ mid: n.mid, kind: "info", text });
        setLive(text);
        return;
      }
      apply(r.pins);
      setNote(null);
      setLive(liveText("restored", titleOf(n.replaced), r.pins.length));
      setFresh(n.replaced.messageId);
      setFocusPin(n.mid);
    } catch {
      // The call didn't reach the engine: it can be tried again.
      setNote({ ...n, kind: "replace-undo-failed" });
    } finally {
      setBusy(null);
    }
  };

  if (!thread) return null;
  const pinOf = (m: ConversationMessage) => (sameThreadTeam(m, team) ? byId.get(m.id) : undefined);
  const full = pins.length >= PIN_CAP;
  const chooser: PinChooser | null = open
    ? {
        mid: open.mid,
        id: `ibx-pin-chooser-${open.mid.replace(/[^\w-]/g, "_")}`,
        heading: chooserHeading(pins.length),
        rows: full
          ? pins.map((pin) => {
              const isNew = !open.known.has(pin.messageId);
              return {
                pin,
                title: titleOf(pin),
                own: pin.preview ? null : ownOf(pin),
                line: pinnedAtLine(whoPinned(pin.pinnedBy, labelOf), formatClock(pin.pinnedAtMs)),
                isNew,
                armed: !isNew,
              };
            })
          : [],
        current: full ? open.current : null,
        change: open.change,
        error: open.error,
        room: pinChooserRoom(pins.length),
        busy: busy === open.mid,
      }
    : null;
  const openFor = (m: ConversationMessage) => {
    setNote(null);
    setOpen({ ...pinChooserOpen(pins), mid: msgKey(m), message: m });
  };
  return {
    stateOf(m) {
      const pin = pinOf(m);
      const atCap = !pin && full;
      return {
        pinnedBy: pin ? whoPinned(pin.pinnedBy, labelOf) : null,
        atCap,
        label: pin ? "Unpin" : atCap ? replaceLabel(pins.length) : "Pin",
        busy: busy === msgKey(m),
        choosing: open?.mid === msgKey(m),
        capCount: atCap ? pins.length : null,
      };
    },
    toggle(m) {
      if (busy) return;
      const pin = pinOf(m);
      if (pin) return void call(m, "unpin", m.id);
      if (open?.mid === msgKey(m)) {
        setOpen(null);
        return;
      }
      if (full) return openFor(m);
      void call(m, "pin", m.id);
    },
    undo() {
      if (busy || !note) return;
      if (note.kind === "replaced" || note.kind === "replace-undo-failed") {
        void undoReplace(note);
        return;
      }
      if (note.kind !== "undo") return;
      if (full) {
        const text = capNote(pins, labelOf);
        setNote({ mid: note.mid, kind: "cap", text });
        setLive(text);
        return;
      }
      void call(note.message, "restore", note.message.id);
    },
    retry() {
      if (busy || !note) return;
      if (note.kind === "replace-undo-failed") return void undoReplace(note);
      if (
        note.kind !== "pin-failed" &&
        note.kind !== "unpin-failed" &&
        note.kind !== "restore-failed"
      )
        return;
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
    chooser,
    chooserMove(messageId) {
      setOpen((o) => (o ? pinChooserArrive(o, messageId) : o));
    },
    choose(messageId) {
      if (!open || busy) return;
      const pin = pins.find((p) => p.messageId === messageId);
      if (!pin) return;
      const chosen = pinChooserChoose(open, pin, titleOf);
      // A pin the agent added a moment ago is never replaced unseen: the person arrives first.
      if (!chosen.replace) {
        setOpen(chosen.state);
        return;
      }
      void replace(open.message, pin);
    },
    pinInRoom() {
      if (!open || busy) return;
      const m = open.message;
      setOpen(null);
      void call(m, "pin", m.id).then((ok) => ok && setFocusPin(msgKey(m)));
    },
    closeChooser() {
      if (!open) return;
      setFocusPin(open.mid);
      setOpen(null);
    },
    replacing: chooser?.current ?? null,
    focusPin,
    focusDone() {
      setFocusPin(null);
    },
  };
}

/** A message is in the thread's store when it was read from the thread's team. */
function sameThreadTeam(m: ConversationMessage, team: InboxTeam | null) {
  return !team || !m.team || (m.team.org === team.org && m.team.team === team.team);
}
