// SPDX-License-Identifier: MIT
/**
 * The agent chat overlay's layout for a pane size: the design's breakpoint table as one
 * function, so the overlay reads its pane's width and height and every size gets its own
 * layout from the same markup.
 */

export type OverlayWidth = "XS" | "S" | "M" | "L";
export type OverlayHeight = "short" | "medium" | "tall";
/** How the pins are drawn: side-by-side tiles, rows, a column beside the chat, or chips. */
export type OverlayPinShape = "tiles" | "rows" | "rail" | "line";
export type OverlayRecordField = "model" | "cost" | "files" | "time" | "story";

export interface OverlayLayout {
  width: OverlayWidth;
  height: OverlayHeight;
  head: "one-line" | "two-line";
  /** The agent's kind shows in the head from 400 × 600. */
  showKind: boolean;
  /** Under 400 wide in a one-line head, the status word leads the record line. */
  statusInRecord: boolean;
  record: "own-line" | "in-head";
  recordFields: OverlayRecordField[];
  pins: OverlayPinShape;
  /** Button labels fold into icons under 480 wide. */
  iconButtons: boolean;
  avatars: boolean;
  textPx: 12 | 13;
}

export function overlayLayout(w: number, h: number): OverlayLayout {
  const width: OverlayWidth = w < 320 ? "XS" : w < 480 ? "S" : w < 820 ? "M" : "L";
  const height: OverlayHeight = h < 360 ? "short" : h < 600 ? "medium" : "tall";
  const short = height === "short";
  const oneLine = short || (w < 480 && h < 600);
  const pins: OverlayPinShape =
    w >= 480 && h >= 360
      ? "tiles"
      : w < 480 && h >= 600
        ? "rows"
        : short && w >= 640
          ? "rail"
          : "line";
  const recordFields = (["model", "cost", "files", "time", "story"] as const).filter(
    (f) => !(f === "time" && w < 480) && !(f === "files" && w < 400) && !(f === "model" && w < 300),
  );
  return {
    width,
    height,
    head: oneLine ? "one-line" : "two-line",
    showKind: w >= 400 && h >= 600,
    statusInRecord: oneLine && w < 400,
    record: short && w >= 640 ? "in-head" : "own-line",
    recordFields,
    pins,
    iconButtons: w < 480,
    avatars: width !== "XS" && !short,
    textPx: w >= 400 && h >= 480 ? 13 : 12,
  };
}

/** The narrowest a chip of the one-line strip gets: its dot, 4 characters of its name, its
 *  value and padding. */
const PIN_CHIP_FLOOR_PX = 110;
/** The strip's horizontal padding and the gap between chips. */
const PIN_LINE_PAD_PX = 20;
const PIN_LINE_GAP_PX = 4;

/** Whether the one-line strip of `count` pins wraps on a `width` pane: it keeps to one row,
 *  names shortened, while every chip fits at its floor, and wraps rather than drop a pin. */
export function pinLineWraps(width: number, count: number): boolean {
  if (count < 2) return false;
  return count * PIN_CHIP_FLOOR_PX + (count - 1) * PIN_LINE_GAP_PX > width - PIN_LINE_PAD_PX;
}

/** The docked overlay's width. */
export const OVERLAY_DOCK_WIDTH = 420;

/** Where the overlay goes on a terminal tab: docked on the right when the tab is 840+ wide
 *  and 360+ tall (the terminal reflows beside it), else over the whole tab. */
export function overlayPlacement(
  tabWidth: number,
  tabHeight: number,
): { mode: "dock"; width: number } | { mode: "cover" } {
  return tabWidth >= 2 * OVERLAY_DOCK_WIDTH && tabHeight >= 360
    ? { mode: "dock", width: OVERLAY_DOCK_WIDTH }
    : { mode: "cover" };
}
