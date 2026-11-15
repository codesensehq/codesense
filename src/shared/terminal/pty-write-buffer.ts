// SPDX-License-Identifier: MIT
import { cancelResilientRaf, resilientRaf } from "@/shared/lib/resilient-raf";

export interface PtyWriteBuffer {
  /** Append data and schedule a frame flush if none is pending. */
  append(data: string): void;
  /** Write everything appended so far now, cancelling the pending frame
   *  (detach, unmount, or before anything else is written to the terminal). */
  flush(): void;
  /** Take pending bytes without writing them. */
  take(): string;
  /** Discard output only when its private authority has retired. */
  discard(): void;
}

export interface PtyOutputRing {
  append(data: string, seqEnd: number): boolean;
  resize(cols: number, rows: number, resizeGen: number): void;
  drain(): { events: PtyOutputEvent[]; overflowed: boolean };
  clear(): void;
}

export type PtyOutputEvent =
  | { kind: "output"; data: string; seqEnd: number }
  | { kind: "resize"; cols: number; rows: number; resizeGen: number };

/** Keep a bounded UTF-8 tail while a terminal is parked. */
export function createPtyOutputRing(maxBytes: number): PtyOutputRing {
  const encoder = new TextEncoder();
  let events: PtyOutputEvent[] = [];
  let bytes = 0;
  let overflowed = false;

  return {
    append(data, seqEnd) {
      if (overflowed) return true;
      const chunk = encoder.encode(data);
      if (chunk.byteLength === 0) return false;
      if (chunk.byteLength > maxBytes || bytes + chunk.byteLength > maxBytes) {
        overflowed = true;
        events = [];
        bytes = 0;
        return true;
      }
      const last = events.at(-1);
      if (last?.kind === "output") {
        last.data += data;
        last.seqEnd = seqEnd;
      } else events.push({ kind: "output", data, seqEnd });
      bytes += chunk.byteLength;
      return false;
    },
    resize(cols, rows, resizeGen) {
      if (overflowed) return;
      events.push({ kind: "resize", cols, rows, resizeGen });
      if (events.length > 1024) {
        overflowed = true;
        events = [];
        bytes = 0;
      }
    },
    drain() {
      const result = { events, overflowed };
      events = [];
      bytes = 0;
      overflowed = false;
      return result;
    },
    clear() {
      events = [];
      bytes = 0;
      overflowed = false;
    },
  };
}

/**
 * An animation-frame write coalescer: every `append()` inside one frame reaches
 * `write` as a single call, cutting per-call overhead during heavy output. It
 * only coalesces, it never drops: the frame is scheduled through `resilientRaf`,
 * so a hidden document still flushes (on a timer), and `flush` writes whatever
 * is pending at once.
 */
export function createPtyWriteBuffer(write: (data: string) => void): PtyWriteBuffer {
  let buffer = "";
  let frame = 0;

  const writePending = () => {
    if (!buffer) return;
    try {
      write(buffer);
    } catch {
      // A failed write must not escape the frame callback; keep the bytes so the
      // next flush retries them in order.
      return;
    }
    buffer = "";
  };

  return {
    append(data: string) {
      buffer += data;
      if (frame === 0) {
        frame = resilientRaf(() => {
          frame = 0;
          writePending();
        });
      }
    },
    take() {
      if (frame !== 0) cancelResilientRaf(frame);
      frame = 0;
      const pending = buffer;
      buffer = "";
      return pending;
    },
    discard() {
      if (frame !== 0) cancelResilientRaf(frame);
      frame = 0;
      buffer = "";
    },
    flush() {
      if (frame !== 0) {
        cancelResilientRaf(frame);
        frame = 0;
      }
      writePending();
    },
  };
}
