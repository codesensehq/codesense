// SPDX-License-Identifier: MIT
/**
 * The satellite probe route, for the two-window e2e driver and its mock spec: a satellite
 * booted with `?window=<label>&probe=<path>` mounts `SatelliteRoot` with a one-item slice for
 * `<path>` and a renderer that draws only that file's `HtmlViewer`, so a spec drives a real
 * dashboard bridge in a second window. The window's registry entry holds no item; the probe's
 * slice is its own, built here from the query.
 *
 * The dashboard reports what its bridge calls returned by posting
 * `{type: "probe:result", key, text}` to this page; the route keeps each answer in
 * `window.__CODESENSE_PROBE_RESULTS__` (`{key: text}`), so a spec reads it from the top page
 * with a plain `browser.execute` and never enters the cross-origin frame.
 *
 * It also records `painted`, the epoch ms of the first animation frame after the viewer's frame
 * element appears, which the first-paint spec times a window's open against.
 *
 * `main.tsx` starts the satellite's own registry client (`satellite-registry.ts`) before it
 * mounts the probe, so the window reports ready as any satellite does; the probe shows its own
 * slice, not the one the client pulls.
 *
 * `main.tsx` loads this only in `webdriver` and `mock` builds; it is proven absent from the
 * release bundle (`scripts/verify-webdriver-absence.ts`) by its results global and its marker.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { HtmlViewer } from "@/features/dashboard/components/html-viewer";
import { currentWindowLabel } from "@/shared/lib/current-window";
import { basename, dirname, join } from "@/shared/lib/path";
import { TAB_ITEM_KIND } from "@/shared/windows/item-key";
import { SatelliteRoot, type SatelliteContent } from "@/shared/windows/satellite-root";
import type { SliceSource } from "@/shared/windows/slice";

/** The probe route's marker: the attribute value on its root, and the absence check's needle. */
const PROBE_MARKER = "codesense-e2e-satellite-probe";

declare global {
  interface Window {
    __CODESENSE_PROBE_RESULTS__?: Record<string, string>;
  }
}

/** A slice of one tab item, `path`, in team `team`, that never changes. */
export function probeSlice(label: string, team: string, path: string): SliceSource {
  const view = {
    label,
    layoutRef: null,
    items: [{ kind: TAB_ITEM_KIND, team, id: path }],
  };
  return { current: () => view, subscribe: () => () => {} };
}

/**
 * The viewer props for `path`: a file in a `panes/` directory renders as a pane on the `/pane/`
 * route, with reads bound to the sibling `content/` directory (the mock world serves only that
 * route); any other file renders from its own directory as the team content root.
 */
export function probeViewerProps(path: string) {
  const dir = dirname(path);
  if (basename(dir) === "panes") {
    const contentRoot = join(dirname(dir), "content");
    return {
      filePath: path,
      teamContentPath: contentRoot,
      pane: { contentRoot, panesDir: dir, fileName: basename(path) },
    };
  }
  return { filePath: path, teamContentPath: dir, pane: null };
}

/** Keeps each `probe:result` a viewer frame posts to this page. Returns the remover. */
export function collectProbeResults(target: Window = window): () => void {
  const results: Record<string, string> = {};
  target.__CODESENSE_PROBE_RESULTS__ = results;
  const onMessage = (event: MessageEvent) => {
    const frames = [...target.document.querySelectorAll("iframe")];
    if (event.source === null || !frames.some((frame) => frame.contentWindow === event.source))
      return;
    const data = event.data as { type?: unknown; key?: unknown; text?: unknown } | null;
    if (data?.type !== "probe:result" || typeof data.key !== "string") return;
    results[data.key] = String(data.text);
  };
  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}

/**
 * Records in `results.painted` the epoch ms of the first animation frame after an iframe is
 * under `root` (the viewer's frame element, drawn before its document loads). Returns the stop.
 */
export function markFirstFrame(root: Element, results: Record<string, string>): () => void {
  let frame = 0;
  const observer = new MutationObserver(check);
  function check() {
    if (!root.querySelector("iframe")) return;
    observer.disconnect();
    frame = requestAnimationFrame(() => {
      results.painted = String(Date.now());
    });
  }
  observer.observe(root, { childList: true, subtree: true });
  check();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}

function renderProbe(content: SatelliteContent): ReactNode {
  if (!("item" in content) || content.item.kind !== TAB_ITEM_KIND) return null;
  const { item } = content;
  return (
    <HtmlViewer
      {...probeViewerProps(item.id)}
      hostTeamKey={item.team || undefined}
      refreshKey={0}
      visible
    />
  );
}

export function SatelliteProbe({ path }: { path: string }): ReactNode {
  // One source for the window's life, so `SatelliteRoot` installs it once.
  const [source] = useState(() =>
    probeSlice(
      currentWindowLabel(),
      new URLSearchParams(window.location.search).get("team") ?? "",
      path,
    ),
  );
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stopResults = collectProbeResults();
    const results = window.__CODESENSE_PROBE_RESULTS__;
    const stopPaint = root.current && results ? markFirstFrame(root.current, results) : () => {};
    return () => {
      stopPaint();
      stopResults();
    };
  }, []);
  return (
    <div ref={root} data-e2e-probe={PROBE_MARKER} className="contents">
      <SatelliteRoot source={source} renderer={renderProbe} />
    </div>
  );
}
