// SPDX-License-Identifier: MIT
import { forwardRef } from "react";
import { LayoutDashboard, Quote } from "lucide-react";

import type { AgentPin, AgentPinChart, AgentPinStatus } from "@/tauri/commands";

import type { OverlayPinShape } from "../lib/overlay-layout";

/** How many key lines each shape shows (a tile on a pane 600+ tall shows 2). */
const LINES: Record<OverlayPinShape, number> = { tiles: 1, rows: 2, rail: 1, line: 0 };

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A pin whose view stopped answering keeps its last values, greyed, and says since when. */
export const pinStopped = (pin: AgentPin) => pin.preview?.status === "not-updating";

/** The status the dot's colour shows, in words for a screen reader. A stopped pin says it in
 *  its visible text instead. */
const STATUS_WORD: Partial<Record<AgentPinStatus, string>> = {
  "on-track": "on track",
  running: "running",
  "needs-you": "needs you",
};

function Chart({ chart }: { chart: AgentPinChart }) {
  if (chart.kind === "progress")
    return (
      <span className="ibx-pk-viz prog" role="img" aria-label={chart.label}>
        <i style={{ width: `${chart.percent}%` }} />
      </span>
    );
  if (chart.kind === "segments")
    return (
      <span className="ibx-pk-viz" role="img" aria-label={chart.label}>
        {chart.segments.map((s, i) => (
          <i key={i} data-status={s} />
        ))}
      </span>
    );
  const total = chart.parts.reduce((n, p) => n + p.value, 0) || 1;
  return (
    <span className="ibx-pk-viz stack" role="img" aria-label={chart.label}>
      {chart.parts.map((p, i) => (
        <i key={i} style={{ flexGrow: p.value / total }} title={p.label} />
      ))}
    </span>
  );
}

/**
 * What a pin sent without a preview (the person's) shows of its message: a quote card for
 * text (its first sentence as the title, then who said it, when and who pinned it, then the
 * rest quoted), or a name card for HTML ("Dashboard from <sender> · <time>").
 */
export type OwnPinCard =
  | { kind: "quote"; meta: string; rest: string }
  | { kind: "name"; meta: string };

/**
 * One pin, drawn as the preview its agent sent: a status dot, its short name (else `title`),
 * the headline value, and by `shape` a small chart and key lines. A pin with no preview draws
 * its message instead (`own`), marked by a glyph where the status dot goes. A button: it
 * opens the pinned view in the overlay's sheet.
 */
export const PinPreview = forwardRef<
  HTMLButtonElement,
  {
    pin: AgentPin;
    shape: OverlayPinShape;
    /** The pinned message's own name, for a pin sent without a short name. */
    title: string;
    tall: boolean;
    open: boolean;
    onOpen: () => void;
    /** The message's own card, for a pin with no preview. */
    own?: OwnPinCard | null;
    /** Just pinned: it drops in and glows once, or with reduced motion keeps a still wash
     *  and the word New, until the next click or key press. */
    fresh?: boolean;
    /** The pin the open chooser's current row would replace: marked, and said. */
    replacing?: boolean;
  }
>(function PinPreview(
  { pin, shape, title, tall, open, onOpen, own = null, fresh = false, replacing = false },
  ref,
) {
  const isNew = {
    ...(fresh ? { "data-new": "true" } : {}),
    ...(replacing ? { "data-replacing": "true" } : {}),
  };
  const newWord = (
    <>
      {fresh && <span className="ibx-pk-new">New</span>}
      {replacing && <span className="sr-only">, will be replaced</span>}
    </>
  );
  if (!pin.preview && own) {
    const Glyph = own.kind === "quote" ? Quote : LayoutDashboard;
    return (
      <button
        ref={ref}
        type="button"
        className="ibx-pk own"
        data-shape={shape}
        data-own={own.kind}
        data-testid={`chat-overlay-pin-${pin.messageId}`}
        aria-expanded={open}
        onClick={onOpen}
        {...isNew}
      >
        <Glyph className="ibx-pk-g" aria-hidden size={12} />
        <span className="ibx-pk-t">{title}</span>
        {newWord}
        {shape !== "line" && (
          <span className="ibx-pk-ls">
            <span className="ibx-pk-l ibx-pk-meta">{own.meta}</span>
            {own.kind === "quote" && own.rest && shape !== "rail" && (
              <span className="ibx-pk-l ibx-pk-q">&ldquo;{own.rest}&rdquo;</span>
            )}
          </span>
        )}
      </button>
    );
  }
  const p = pin.preview ?? {};
  const stopped = pinStopped(pin);
  const name = p.shortName || title;
  const lines = (p.lines ?? []).slice(0, shape === "tiles" && tall ? 2 : LINES[shape]);
  // The one-line strip says only "stopped", so the chip keeps to one row; the time is in the
  // other shapes and the sheet.
  const since = !stopped
    ? null
    : shape === "line" || !pin.previewAtMs
      ? "stopped"
      : `stopped ${hhmm(pin.previewAtMs)}`;
  const statusWord = !stopped && p.status ? STATUS_WORD[p.status] : undefined;
  return (
    <button
      ref={ref}
      type="button"
      className="ibx-pk"
      data-shape={shape}
      data-status={stopped ? "stopped" : (p.status ?? "none")}
      data-testid={`chat-overlay-pin-${pin.messageId}`}
      aria-expanded={open}
      onClick={onOpen}
      {...isNew}
    >
      <span className="ibx-pk-d" aria-hidden />
      <span className="ibx-pk-t">{name}</span>
      {statusWord && <span className="sr-only">, {statusWord},</span>}
      {newWord}
      {p.value && (
        <span className="ibx-pk-v">
          <b>{p.value}</b>
          {p.unit && shape !== "line" && <span className="u">{p.unit}</span>}
        </span>
      )}
      {since && <span className="ibx-pk-s">{since}</span>}
      {p.chart && shape !== "line" && <Chart chart={p.chart} />}
      {lines.length > 0 && (
        <span className="ibx-pk-ls">
          {lines.map((l, i) => (
            <span key={i} className="ibx-pk-l">
              {l}
            </span>
          ))}
        </span>
      )}
    </button>
  );
});
