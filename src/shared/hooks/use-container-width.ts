// SPDX-License-Identifier: MIT
import { useLayoutEffect, useState } from "react";

/**
 * The measured width of one element, kept current with a
 * `ResizeObserver`. Returns a callback ref to put on the element and its width
 * in px (`null` until measured). Layout decisions that depend on the space a
 * pane actually has (not the window) read this; tests stub `ResizeObserver`
 * to set the width (`src/test/resize-observer-stub.ts`).
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): readonly [
  (node: T | null) => void,
  number | null,
] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!node) {
      setWidth(null);
      return;
    }
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setWidth(last.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, width] as const;
}
