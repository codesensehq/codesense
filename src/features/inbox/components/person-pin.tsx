// SPDX-License-Identifier: MIT
import { useEffect, useRef } from "react";
import { Info, LayoutDashboard, Pin, PinOff, Quote, Replace, TriangleAlert } from "lucide-react";

import type { ConversationMessage } from "../api";
import type { PersonPins, PinChooser as Chooser } from "../hooks/use-person-pins";
import { msgKey } from "../model";
import { Ico } from "./primitives";

/**
 * A message's Pin: in its action row (shown on hover, focus inside the message, or a tap),
 * or always in an HTML message's title bar. Pinned, it is Unpin. At the cap it is Pin…, which
 * opens the chooser of which pin to replace. It keeps focus after a click, so Unpin is one key
 * away, and takes focus back after a replace, its Undo or the chooser's Esc.
 */
export function PinButton({ pins, m }: { pins: PersonPins; m: ConversationMessage }) {
  const state = pins.stateOf(m);
  const pinned = state.pinnedBy !== null;
  const ref = useRef<HTMLButtonElement>(null);
  const mid = msgKey(m);
  const wantsFocus = pins.focusPin === mid;
  useEffect(() => {
    if (!wantsFocus) return;
    ref.current?.focus();
    pins.focusDone();
  }, [wantsFocus, pins]);
  return (
    <button
      ref={ref}
      type="button"
      className="ibx-pin-b"
      aria-label={state.label}
      aria-pressed={pinned}
      aria-disabled={state.busy ? true : undefined}
      aria-expanded={state.atCap ? state.choosing : undefined}
      aria-controls={state.atCap && state.choosing ? pins.chooser?.id : undefined}
      title={state.label}
      data-pin={pinned ? "pinned" : state.atCap ? "cap" : "pin"}
      data-testid="ibx-pin"
      onClick={() => pins.toggle(m)}
    >
      <Ico icon={pinned ? PinOff : Pin} sm />
      <span className="lbl">{pinned ? "Unpin" : state.atCap ? "Pin…" : "Pin"}</span>
      {state.capCount !== null && (
        // Where the label is hidden (the overlay's icon), the cap still shows.
        <span className="ibx-pin-cap" aria-hidden>
          {state.capCount}
        </span>
      )}
    </button>
  );
}

/** Under a message: who pinned it, its chooser at the cap, and its note (a failure, an Undo). */
export function PinFoot({ pins, m }: { pins: PersonPins; m: ConversationMessage }) {
  const { pinnedBy } = pins.stateOf(m);
  const mid = msgKey(m);
  const note = pins.note?.mid === mid ? pins.note : null;
  const chooser = pins.chooser?.mid === mid ? pins.chooser : null;
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
      {chooser && <PinChooser pins={pins} chooser={chooser} />}
      {note?.kind === "cap" && (
        <div className="ibx-pin-note" role="note" data-testid="ibx-pin-note" data-kind="cap">
          <Ico icon={Info} sm />
          <span>{note.text}</span>
          <button type="button" className="ibx-pin-act" onClick={() => pins.showPins()}>
            Show pins
          </button>
        </div>
      )}
      {note?.kind === "info" && (
        <div className="ibx-pin-note" role="note" data-testid="ibx-pin-note" data-kind="info">
          <Ico icon={Info} sm />
          <span>{note.text}</span>
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
      {note?.kind === "replaced" && (
        <div className="ibx-pin-note" role="note" data-testid="ibx-pin-note" data-kind="replaced">
          <Ico icon={Replace} sm />
          <span>{note.text}</span>
          <button type="button" className="ibx-pin-act" onClick={() => pins.undo()}>
            Undo
          </button>
        </div>
      )}
      {note &&
        (note.kind === "pin-failed" ||
          note.kind === "unpin-failed" ||
          note.kind === "restore-failed" ||
          note.kind === "replace-undo-failed") && (
          <div
            className="ibx-pin-note danger"
            role="alert"
            data-testid="ibx-pin-note"
            data-kind={note.kind}
          >
            <Ico icon={TriangleAlert} sm />
            <span>
              {note.kind === "unpin-failed"
                ? "Couldn't unpin."
                : note.kind === "replace-undo-failed"
                  ? "Couldn't undo the replace."
                  : "Couldn't pin."}{" "}
              Try again. If it keeps failing, reload the page.
            </span>
            <button type="button" className="ibx-pin-act" onClick={() => pins.retry()}>
              Try again
            </button>
          </div>
        )}
    </>
  );
}

/**
 * At the cap, under the message: which pin to replace. One row is current: the arrow keys,
 * Home and End move it (handled here, so the thread's own keys never see them), and with focus
 * inside, the pointer arriving on a row moves it too. Enter or a click replaces; a row the agent
 * added since the chooser opened must be arrived on first. Tab reaches Cancel; Esc closes.
 */
function PinChooser({ pins, chooser }: { pins: PersonPins; chooser: Chooser }) {
  const root = useRef<HTMLDivElement>(null);
  const change = useRef<HTMLDivElement>(null);
  const rows = chooser.rows;
  const at = rows.findIndex((r) => r.pin.messageId === chooser.current);
  const rowEl = (id: number) =>
    root.current?.querySelector<HTMLElement>(`[data-pin-id="${id}"]`) ?? null;
  const goTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    pins.chooserMove(row.pin.messageId);
    rowEl(row.pin.messageId)?.focus();
  };
  // Focus goes to the current row; when the row the person was on left, to the change line.
  const currentKey = chooser.current ?? (chooser.change ? `change:${chooser.change}` : null);
  useEffect(() => {
    if (chooser.room) return;
    if (chooser.current !== null) rowEl(chooser.current)?.focus();
    else if (chooser.change) change.current?.focus();
    // Moves when the current row or the change does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, chooser.room]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const fromChange = e.target === change.current;
    const step =
      e.key === "ArrowDown"
        ? fromChange
          ? 0
          : at + 1
        : e.key === "ArrowUp"
          ? fromChange
            ? rows.length - 1
            : at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? rows.length - 1
              : null;
    if (step !== null) {
      e.preventDefault();
      e.stopPropagation();
      goTo(step);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      pins.closeChooser();
    }
  };
  const headId = `${chooser.id}-h`;
  return (
    <div
      ref={root}
      id={chooser.id}
      className="ibx-pin-chooser"
      role="group"
      aria-labelledby={headId}
      aria-busy={chooser.busy || undefined}
      data-testid="ibx-pin-chooser"
      onKeyDown={onKeyDown}
    >
      <div className="hd" id={headId}>
        {chooser.heading}
      </div>
      {chooser.room ? (
        <div className="room">
          <span>{chooser.room}</span>
          <button type="button" className="ibx-pin-act" onClick={() => pins.pinInRoom()}>
            Pin
          </button>
        </div>
      ) : (
        <>
          {chooser.change && (
            <div
              ref={change}
              className="chg"
              tabIndex={-1}
              role="status"
              data-testid="ibx-pin-change"
            >
              {chooser.change}
            </div>
          )}
          <div className="rows">
            {rows.map((row) => {
              const current = row.pin.messageId === chooser.current;
              const status = row.pin.preview?.status;
              return (
                <button
                  key={row.pin.messageId}
                  type="button"
                  className="choice"
                  data-testid="ibx-pin-choice"
                  data-pin-id={row.pin.messageId}
                  data-current={current || undefined}
                  data-new={row.isNew || undefined}
                  data-own={row.own ?? undefined}
                  tabIndex={current || (chooser.current === null && row === rows[0]) ? 0 : -1}
                  onPointerEnter={() => {
                    // The pointer moves the current row only while focus is in the chooser.
                    if (root.current?.contains(document.activeElement)) goTo(rows.indexOf(row));
                  }}
                  onClick={() => {
                    // A click on a row that isn't current only arrives on it: what replaces
                    // is always the row the mark, "Replace" and Enter name. A row new since
                    // the chooser opened says so as it arrives.
                    if (!row.armed) {
                      pins.choose(row.pin.messageId);
                      rowEl(row.pin.messageId)?.focus();
                      return;
                    }
                    if (!current) return goTo(rows.indexOf(row));
                    pins.choose(row.pin.messageId);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    pins.choose(row.pin.messageId);
                  }}
                >
                  {row.own ? (
                    <span className="dot own" aria-hidden>
                      <Ico icon={row.own === "quote" ? Quote : LayoutDashboard} sm />
                    </span>
                  ) : (
                    <span className="dot" data-status={status ?? "none"} aria-hidden />
                  )}
                  <span className="t">{row.title}</span>
                  {row.pin.preview?.value && <b className="v">{row.pin.preview.value}</b>}
                  {row.isNew && <span className="new">New</span>}
                  <span className="by">{row.line}</span>
                  {current && row.armed && <span className="go">Replace</span>}
                </button>
              );
            })}
          </div>
          {chooser.error && (
            <div className="ibx-pin-note danger" role="alert">
              <Ico icon={TriangleAlert} sm />
              <span>{chooser.error}</span>
            </div>
          )}
        </>
      )}
      <button type="button" className="ibx-pin-act cancel" onClick={() => pins.closeChooser()}>
        Cancel
      </button>
    </div>
  );
}

/** The polite live region that says each pin, unpin, replace, Undo and cap note. */
export function PinLive({ pins }: { pins: PersonPins }) {
  return (
    <div className="ibx-sr" role="status" aria-live="polite" data-testid="ibx-pin-live">
      {pins.live}
    </div>
  );
}
