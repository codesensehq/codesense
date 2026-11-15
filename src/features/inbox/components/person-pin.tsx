// SPDX-License-Identifier: MIT
import { Info, Pin, PinOff, TriangleAlert } from "lucide-react";

import type { ConversationMessage } from "../api";
import type { PersonPins } from "../hooks/use-person-pins";
import { msgKey } from "../model";
import { Ico } from "./primitives";

/**
 * A message's Pin: in its action row (shown on hover, focus inside the message, or a tap),
 * or always in an HTML message's title bar. Pinned, it is Unpin. At the cap it is dimmed
 * ahead of time (aria-disabled, still focusable) and says why; a click says whose pins fill
 * the list. It keeps focus after a click, so Unpin is one key away.
 */
export function PinButton({ pins, m }: { pins: PersonPins; m: ConversationMessage }) {
  const state = pins.stateOf(m);
  const pinned = state.pinnedBy !== null;
  return (
    <button
      type="button"
      className="ibx-pin-b"
      aria-label={state.label}
      aria-pressed={pinned}
      aria-disabled={state.atCap || state.busy ? true : undefined}
      title={state.label}
      data-pin={pinned ? "pinned" : state.atCap ? "cap" : "pin"}
      data-testid="ibx-pin"
      onClick={() => pins.toggle(m)}
    >
      <Ico icon={pinned ? PinOff : Pin} sm />
      <span className="lbl">{pinned ? "Unpin" : "Pin"}</span>
    </button>
  );
}

/** Under a message: who pinned it, and its note (the cap, a failure, or Undo). */
export function PinFoot({ pins, m }: { pins: PersonPins; m: ConversationMessage }) {
  const { pinnedBy } = pins.stateOf(m);
  const note = pins.note?.mid === msgKey(m) ? pins.note : null;
  return (
    <>
      {pinnedBy !== null && (
        <div className="ibx-pin-tag" data-testid="ibx-pin-tag">
          <Ico icon={Pin} sm />
          <span>
            Pinned by <b>{pinnedBy}</b>
          </span>
        </div>
      )}
      {note?.kind === "cap" && (
        <div className="ibx-pin-note" role="note" data-testid="ibx-pin-note" data-kind="cap">
          <Ico icon={Info} sm />
          <span>{note.text}</span>
          <button type="button" className="ibx-pin-act" onClick={() => pins.showPins()}>
            Show pins
          </button>
        </div>
      )}
      {note?.kind === "undo" && (
        <div className="ibx-pin-note" role="note" data-testid="ibx-pin-note" data-kind="undo">
          <Ico icon={PinOff} sm />
          <span>Unpinned.</span>
          <button type="button" className="ibx-pin-act" onClick={() => pins.undo()}>
            Undo
          </button>
        </div>
      )}
      {note &&
        (note.kind === "pin-failed" ||
          note.kind === "unpin-failed" ||
          note.kind === "restore-failed") && (
          <div
            className="ibx-pin-note danger"
            role="alert"
            data-testid="ibx-pin-note"
            data-kind={note.kind}
          >
            <Ico icon={TriangleAlert} sm />
            <span>
              {note.kind === "unpin-failed" ? "Couldn't unpin." : "Couldn't pin."} Try again. If it
              keeps failing, reload the page.
            </span>
            <button type="button" className="ibx-pin-act" onClick={() => pins.retry()}>
              Try again
            </button>
          </div>
        )}
    </>
  );
}

/** The polite live region that says each pin, unpin, Undo and cap note. */
export function PinLive({ pins }: { pins: PersonPins }) {
  return (
    <div className="ibx-sr" role="status" aria-live="polite" data-testid="ibx-pin-live">
      {pins.live}
    </div>
  );
}
