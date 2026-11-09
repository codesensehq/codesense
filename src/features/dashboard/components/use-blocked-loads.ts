// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";

import type { DocProblem } from "./html-viewer";

/** A page that keeps retrying a blocked host cannot grow the list past this. */
const KEPT_BLOCKS = 50;
/** Reported loads remembered per document, so a row that scrolled out never comes back. */
const SEEN_BLOCKS = 1000;

/**
 * The loads a frame's content policy blocked, once each, for hosts that show no other doc
 * problems. A new `documentKey` starts an empty list.
 */
export function useBlockedLoads(documentKey?: string): {
  blocked: DocProblem[];
  /** Distinct blocks since the last dismiss, including rows the list no longer keeps. */
  total: number;
  onDocProblem: (problem: DocProblem) => void;
  dismiss: () => void;
} {
  const [blocked, setBlocked] = useState<DocProblem[]>([]);
  const [total, setTotal] = useState(0);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    seen.current = new Set();
    setBlocked([]);
    setTotal(0);
  }, [documentKey]);
  const onDocProblem = useCallback((problem: DocProblem) => {
    if (problem.kind !== "csp") return;
    if (seen.current.has(problem.message) || seen.current.size >= SEEN_BLOCKS) return;
    seen.current.add(problem.message);
    setBlocked((previous) => [...previous.slice(1 - KEPT_BLOCKS), problem]);
    setTotal((count) => count + 1);
  }, []);
  const dismiss = useCallback(() => {
    setBlocked([]);
    setTotal(0);
  }, []);
  return { blocked, total, onDocProblem, dismiss };
}
