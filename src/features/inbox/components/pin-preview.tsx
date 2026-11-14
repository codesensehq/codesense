// SPDX-License-Identifier: MIT
import { forwardRef } from "react";

import type { AgentPin, AgentPinChart } from "@/tauri/commands";

import type { OverlayPinShape } from "../lib/overlay-layout";

/** How many key lines each shape shows (a tile on a pane 600+ tall shows 2). */
const LINES: Record<OverlayPinShape, number> = { tiles: 1, rows: 2, rail: 1, line: 0 };

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A pin whose view stopped answering keeps its last values, greyed, and says since when. */
export const pinStopped = (pin: AgentPin) => pin.preview?.status === "not-updating";

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
 * One pin, drawn as the preview its agent sent: a status dot, its short name (else `title`),
 * the headline value, and by `shape` a small chart and key lines. A button: it opens the pinned
 * view in the overlay's sheet.
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
  }
>(function PinPreview({ pin, shape, title, tall, open, onOpen }, ref) {
  const p = pin.preview ?? {};
  const stopped = pinStopped(pin);
  const name = p.shortName || title;
  const lines = (p.lines ?? []).slice(0, shape === "tiles" && tall ? 2 : LINES[shape]);
  const since = stopped && pin.previewAtMs ? `stopped ${hhmm(pin.previewAtMs)}` : null;
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
    >
      <span className="ibx-pk-d" aria-hidden />
      <span className="ibx-pk-t">{name}</span>
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
