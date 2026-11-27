// SPDX-License-Identifier: MIT
import { useEffect, type RefObject } from "react";
import { currentWebview } from "@/shared/lib/current-window";
import { dropPositionHitsElement } from "@/shared/lib/drag-drop-hit-test";

/** Route webview-global OS drops to the visible, granted pane under the cursor. */
export function usePaneFileDrop({
  frame,
  origin,
  enabled,
  readyRef,
}: {
  frame: HTMLIFrameElement | null;
  origin: string | undefined;
  enabled: boolean;
  readyRef: RefObject<boolean>;
}): void {
  useEffect(() => {
    if (!enabled || !frame || !origin) return;
    let active = true;
    let inside = false;
    const drag = (phase: "enter" | "over" | "leave") =>
      frame.contentWindow?.postMessage({ type: "codesense:file-drag", phase }, origin);
    const leave = () => {
      if (!inside) return;
      inside = false;
      drag("leave");
    };
    const unlisten = currentWebview().onDragDropEvent(({ payload }) => {
      if (!active) return;
      if (payload.type === "leave") {
        leave();
        return;
      }
      if (
        !readyRef.current ||
        !frame.isConnected ||
        !dropPositionHitsElement(payload.position, frame)
      ) {
        leave();
        return;
      }
      if (payload.type === "drop") {
        if (payload.paths.length > 0) {
          frame.contentWindow?.postMessage(
            { type: "codesense:file-drop", paths: payload.paths },
            origin,
          );
        }
        leave();
      } else {
        drag(inside ? "over" : "enter");
        inside = true;
      }
    });
    return () => {
      active = false;
      leave();
      void unlisten.then((fn) => fn());
    };
  }, [enabled, frame, origin, readyRef]);
}
