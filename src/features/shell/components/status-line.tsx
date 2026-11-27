// SPDX-License-Identifier: MIT
import { useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { ScopedPortal } from "@/shared/lib/warm-scopes/owning-scope";
import {
  dismissStatusLine,
  pauseStatusLine,
  resumeStatusLine,
  runStatusLineAction,
  useStatusLine,
  type StatusLineAction,
  type StatusLineEntry,
} from "@/shared/stores/status-line-store";
import { StatusLineWaitingMenu } from "./status-line-waiting-menu";

/**
 * The status line in the title bar: the one line any feature or agent posts to
 * (`postStatusLine`), its action, the "+N waiting ▾" menu of waiting offers, and the one polite
 * live region every line is announced in. The only subscriber to the status line store, mounted
 * with no props, so a post re-renders this and nothing else in the title bar. With nothing posted
 * it renders nothing in the bar; the live region sits empty at the end of `body`.
 */
export function StatusLine() {
  const { line, waiting, held, announcements } = useStatusLine();
  return (
    <>
      {line && <Line line={line} waiting={held ? [] : waiting} />}
      <ScopedPortal container={document.body}>
        <div role="status" aria-live="polite" aria-label="status line" className="sr-only">
          {announcements.map((a) => (
            <p key={a.seq}>{a.text}</p>
          ))}
        </div>
      </ScopedPortal>
    </>
  );
}

function Line({ line, waiting }: { line: StatusLineEntry; waiting: readonly StatusLineEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  // The element that had focus before focus entered the line, to return it to.
  const returnFocus = useRef<HTMLElement | null>(null);

  // The last element focused outside the line, for when focus enters it.
  const lastOutside = useRef<Element | null>(null);

  // Hover and focus pause the timer only while this line is mounted.
  useLayoutEffect(
    () => () => {
      resumeStatusLine("hover");
      resumeStatusLine("focus");
    },
    [],
  );

  useEffect(() => {
    lastOutside.current = document.activeElement;
    const onFocusIn = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) lastOutside.current = e.target as Element;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);

  const onFocus = (e: FocusEvent) => {
    if (!ref.current?.contains(e.relatedTarget as Node | null)) {
      const before = e.relatedTarget ?? lastOutside.current;
      returnFocus.current =
        before instanceof HTMLElement && before !== document.body ? before : null;
    }
    pauseStatusLine("focus");
  };
  const onBlur = (e: FocusEvent) => {
    if (!ref.current?.contains(e.relatedTarget as Node | null)) resumeStatusLine("focus");
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Esc in the waiting menu closes the menu, which is portaled outside the line.
    if (e.key !== "Escape" || !ref.current?.contains(e.target as Node)) return;
    if (line.key === "hint") return;
    e.preventDefault();
    dismissStatusLine(line.id);
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Status line"
      data-testid="status-line"
      onPointerEnter={() => pauseStatusLine("hover")}
      onPointerLeave={() => resumeStatusLine("hover")}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className="flex h-6 min-w-0 max-w-[32rem] flex-shrink items-center gap-2 overflow-hidden rounded-md bg-muted pr-1 pl-2.5 text-sm whitespace-nowrap text-foreground"
    >
      <LineBody key={line.id} line={line} returnFocus={returnFocus} />
      {waiting.length > 0 && <StatusLineWaitingMenu waiting={waiting} />}
    </div>
  );
}

/**
 * One line's text and action, keyed by the line so that when a line closes under focus, focus
 * returns to the element that had it before focus entered the line, else `body`.
 */
function LineBody({
  line,
  returnFocus,
}: {
  line: StatusLineEntry;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  // Its own node: a closing line's cleanup runs while this is still in the document, before
  // React detaches the line's ref.
  const body = useRef<HTMLSpanElement>(null);
  useLayoutEffect(
    () => () => {
      const container = body.current?.parentElement;
      if (!container?.contains(document.activeElement)) return;
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back?.isConnected && !container.contains(back)) back.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    },
    [returnFocus],
  );

  return (
    <span ref={body} className="contents">
      <span className="min-w-0 truncate">{line.text}</span>
      {line.action && (
        <ActionButton action={line.action} onRun={() => runStatusLineAction(line.id)} />
      )}
    </span>
  );
}

function ActionButton({ action, onRun }: { action: StatusLineAction; onRun: () => void }) {
  return (
    <button
      type="button"
      onClick={onRun}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded px-1 font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {action.label}
      {action.keyHint && " "}
      {action.keyHint && (
        <kbd className="rounded border border-border px-1 font-mono text-[10px] font-normal text-foreground">
          {action.keyHint}
        </kbd>
      )}
    </button>
  );
}
