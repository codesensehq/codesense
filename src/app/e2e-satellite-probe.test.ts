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

    // happy-dom loads no iframe page, so each frame gets a window of its own here, and a
    // message carries its source as set rather than as the DOM's MessageEvent keeps it.
    const frameWindow = () => {
      const frame = document.createElement("iframe");
      const contentWindow = {} as Window;
      Object.defineProperty(frame, "contentWindow", { value: contentWindow });
      document.body.append(frame);
      return contentWindow;
    };
    const post = (source: unknown, data: unknown) =>
      window.dispatchEvent(Object.assign(new Event("message"), { data, source }));

    it("keeps each probe:result its frames post, and nothing else", () => {
      const frame = frameWindow();
      stop = collectProbeResults();
      post(frame, { type: "probe:result", key: "read", text: "hello" });
      post(frame, { type: "probe:result", key: "push", text: "a.md" });
      post(frame, { type: "probe:other", key: "x", text: "no" });
      post(window, { type: "probe:result", key: "forged", text: "no" });
      post(null, { type: "probe:result", key: "forged", text: "no" });
      expect(window.__CODESENSE_PROBE_RESULTS__).toEqual({ read: "hello", push: "a.md" });
    });

    it("stops listening once removed", () => {
      const frame = frameWindow();
      collectProbeResults()();
      post(frame, { type: "probe:result", key: "read", text: "late" });
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
