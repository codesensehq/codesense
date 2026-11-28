// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectProbeResults,
  markFirstFrame,
  probeSlice,
  probeViewerProps,
} from "./e2e-satellite-probe";

describe("the satellite probe route", () => {
  it("renders a file in panes/ as a pane bound to the sibling content", () => {
    expect(probeViewerProps("/ctx/default/panes/probe.html")).toEqual({
      filePath: "/ctx/default/panes/probe.html",
      teamContentPath: "/ctx/default/content",
      pane: {
        contentRoot: "/ctx/default/content",
        panesDir: "/ctx/default/panes",
        fileName: "probe.html",
      },
    });
  });

  it("renders any other file from its own directory as the team content root", () => {
    expect(probeViewerProps("/orgs/local/team/content/probe.html")).toEqual({
      filePath: "/orgs/local/team/content/probe.html",
      teamContentPath: "/orgs/local/team/content",
      pane: null,
    });
  });

  it("hands over a one-item slice with no layout", () => {
    const source = probeSlice("pane-x", "o:t", "/a/probe.html");
    expect(source.current()).toEqual({
      label: "pane-x",
      layoutRef: null,
      items: [{ kind: "tab", team: "o:t", id: "/a/probe.html" }],
    });
    expect(source.current()).toBe(source.current());
  });

  describe("results", () => {
    let stop = () => {};
    afterEach(() => {
      stop();
      document.body.innerHTML = "";
    });

    const post = (source: MessageEventSource | null, data: unknown) =>
      window.dispatchEvent(new MessageEvent("message", { data, source }));

    it("keeps each probe:result its frames post, and nothing else", () => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      stop = collectProbeResults();
      post(frame.contentWindow, { type: "probe:result", key: "read", text: "hello" });
      post(frame.contentWindow, { type: "probe:result", key: "push", text: "a.md" });
      post(frame.contentWindow, { type: "probe:other", key: "x", text: "no" });
      post(window, { type: "probe:result", key: "forged", text: "no" });
      post(null, { type: "probe:result", key: "forged", text: "no" });
      expect(window.__CODESENSE_PROBE_RESULTS__).toEqual({ read: "hello", push: "a.md" });
    });

    it("stops listening once removed", () => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      collectProbeResults()();
      post(frame.contentWindow, { type: "probe:result", key: "read", text: "late" });
      expect(window.__CODESENSE_PROBE_RESULTS__).toEqual({});
    });
  });

  describe("first paint", () => {
    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("records the epoch ms of the first animation frame after a frame appears, once", async () => {
      const results: Record<string, string> = {};
      const root = document.createElement("div");
      document.body.append(root);
      const stop = markFirstFrame(root, results);
      await Promise.resolve();
      expect(results.painted).toBeUndefined();
      const before = Date.now();
      root.append(document.createElement("iframe"));
      await vi.waitFor(() => expect(results.painted).toBeDefined());
      const painted = Number(results.painted);
      expect(painted).toBeGreaterThanOrEqual(before);
      root.append(document.createElement("iframe"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(Number(results.painted)).toBe(painted);
      stop();
    });

    it("marks a frame already there when it starts", async () => {
      const results: Record<string, string> = {};
      const root = document.createElement("div");
      root.append(document.createElement("iframe"));
      document.body.append(root);
      const stop = markFirstFrame(root, results);
      await vi.waitFor(() => expect(results.painted).toBeDefined());
      stop();
    });
  });
});
