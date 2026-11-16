// SPDX-License-Identifier: MIT
/**
 * In-process counters for the webview's hot paths, read by tests and by hand in the
 * devtools console. They never cross IPC: sending them would add the very churn they
 * measure.
 */
export type WebviewPerfCounter = "structuralCompares" | "liveHubPatches" | "liveHubSorts";

const counts: Record<WebviewPerfCounter, number> = {
  structuralCompares: 0,
  liveHubPatches: 0,
  liveHubSorts: 0,
};

export function countWebviewPerf(counter: WebviewPerfCounter, by = 1): void {
  counts[counter] += by;
}

/** A copy of every counter now. */
export function webviewPerfCounts(): Readonly<Record<WebviewPerfCounter, number>> {
  return { ...counts };
}

export function resetWebviewPerfCounts(): void {
  for (const counter of Object.keys(counts) as WebviewPerfCounter[]) counts[counter] = 0;
}
