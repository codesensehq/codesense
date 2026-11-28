// SPDX-License-Identifier: MIT
/**
 * The satellite probe route, for the two-window e2e driver and its mock spec: a satellite
 * booted with `?window=<label>&probe=<path>` mounts `SatelliteRoot` with a one-item slice for
 * `<path>` and a renderer that draws only that file's `HtmlViewer`, so a spec drives a real
 * dashboard bridge in a second window with no registry entry behind it.
 *
 * The dashboard reports what its bridge calls returned by posting
 * `{type: "probe:result", key, text}` to this page; the route keeps each answer in
 * `window.__CODESENSE_PROBE_RESULTS__` (`{key: text}`), so a spec reads it from the top page
 * with a plain `browser.execute` and never enters the cross-origin frame.
 *
 * It also records `painted`, the epoch ms of the first animation frame after the viewer's frame
 * element appears, which the first-paint spec times a window's open against.
 *
 * It also runs the registry client (listen, pull, `window_ready`), so its registry entry
 * stops being pending once it has mounted, as a satellite's should. The slices it pulls are
 * dropped: the probe shows its own.
 *
 * `main.tsx` loads this only in `webdriver` and `mock` builds; it is proven absent from the
 * release bundle (`scripts/verify-webdriver-absence.ts`) by its results global and its marker.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { HtmlViewer } from "@/features/dashboard/components/html-viewer";
import { currentWebviewWindow, currentWindowLabel } from "@/shared/lib/current-window";
import { logger } from "@/shared/lib/logger";
import { basename, dirname, join } from "@/shared/lib/path";
import { safeUnlisten } from "@/shared/lib/tauri-listeners";
import { TAB_ITEM_KIND } from "@/shared/windows/item-key";
import { createSliceHolder, startRegistryClient } from "@/shared/windows/registry-client";
import { SatelliteRoot, type SatelliteContent } from "@/shared/windows/satellite-root";
import type { SliceSource } from "@/shared/windows/slice";
import { WINDOW_SLICE_EVENT, type WindowSlice } from "@/shared/windows/window-slice";
import { windowGetSlice, windowReady } from "@/tauri/commands";

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

/** Starts the registry client for `label`; returns its stop. */
function reportReady(label: string): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  startRegistryClient(
    {
      label,
      listen: async (handler) => {
        const off = await currentWebviewWindow().listen<WindowSlice>(WINDOW_SLICE_EVENT, (event) =>
          handler(event.payload),
        );
        return () => safeUnlisten(off);
      },
      getSlice: windowGetSlice,
      ready: windowReady,
    },
    createSliceHolder(() => {}),
  ).then(
    (off) => {
      if (stopped) off();
      else unlisten = off;
    },
    (e) => logger.warn("windows", `probe registry client did not start: ${String(e)}`),
  );
  return () => {
    stopped = true;
    unlisten?.();
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
  useEffect(() => reportReady(currentWindowLabel()), []);
  return (
    <div ref={root} data-e2e-probe={PROBE_MARKER} className="contents">
      <SatelliteRoot source={source} renderer={renderProbe} />
    </div>
  );
}
