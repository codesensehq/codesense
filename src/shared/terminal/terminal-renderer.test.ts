// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import {
  chooseRenderer,
  createTerminalRendererGate,
  isLinuxPlatform,
  parseRendererOverride,
  probeRuns,
  rendererLogLine,
  type RenderProbeVerdict,
  type TerminalRendererKind,
} from "./terminal-renderer";

describe("the renderer choice", () => {
  it("is DOM on Linux and WebGL elsewhere, unless overridden", () => {
    expect(chooseRenderer(null, true)).toBe("dom");
    expect(chooseRenderer(null, false)).toBe("webgl");
    for (const linux of [true, false]) {
      expect(chooseRenderer("dom", linux)).toBe("dom");
      expect(chooseRenderer("webgl", linux)).toBe("webgl");
    }
  });

  it("probes only on Linux, and an override skips the probe", () => {
    expect(probeRuns(null, true)).toBe(true);
    expect(probeRuns(null, false)).toBe(false);
    expect(probeRuns("dom", true)).toBe(false);
    expect(probeRuns("webgl", true)).toBe(false);
  });

  it("reads the override and the platform", () => {
    expect(parseRendererOverride("dom")).toBe("dom");
    expect(parseRendererOverride("webgl")).toBe("webgl");
    expect(parseRendererOverride("canvas")).toBeNull();
    expect(parseRendererOverride(null)).toBeNull();
    expect(parseRendererOverride(undefined)).toBeNull();
    expect(isLinuxPlatform("Linux aarch64")).toBe(true);
    expect(isLinuxPlatform("Linux x86_64")).toBe(true);
    expect(isLinuxPlatform("MacIntel")).toBe(false);
    expect(isLinuxPlatform("Win32")).toBe(false);
    expect(isLinuxPlatform("Linux armv8l; Android")).toBe(false);
    expect(isLinuxPlatform("")).toBe(false);
  });

  it("says what it chose in one line", () => {
    expect(rendererLogLine({ renderer: "dom", probe: "blank" })).toBe(
      "terminal renderer: dom (probe: blank)",
    );
    expect(rendererLogLine({ renderer: "webgl", probe: "skipped" })).toBe(
      "terminal renderer: webgl (probe: skipped)",
    );
    expect(rendererLogLine({ renderer: "dom", probe: "skipped", override: "dom" })).toBe(
      "terminal renderer: dom (probe: skipped), CODESENSE_TERMINAL_RENDERER=dom",
    );
  });
});

describe("the renderer gate", () => {
  function gate(opts: {
    override?: TerminalRendererKind | null;
    linux: boolean;
    probe?: () => Promise<RenderProbeVerdict>;
  }) {
    const log = vi.fn();
    const probe = vi.fn(opts.probe ?? (async (): Promise<RenderProbeVerdict> => "ok"));
    const g = createTerminalRendererGate({
      override: () => opts.override ?? null,
      linux: () => opts.linux,
      probe,
      log,
    });
    return { g, log, probe };
  }

  it("off Linux allows WebGL at once, without a probe, and logs once", () => {
    const { g, log, probe } = gate({ linux: false });
    expect(g.allowsWebgl()).toBe(true);
    expect(g.allowsWebgl()).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([["terminal renderer: webgl (probe: skipped)"]]);
  });

  it.each(["ok", "blank", "error"] as const)(
    "on Linux keeps DOM from the first call and logs the probe's %s once",
    async (verdict) => {
      const { g, log, probe } = gate({ linux: true, probe: async () => verdict });
      expect(g.allowsWebgl()).toBe(false);
      expect(g.choice).toEqual({ renderer: "dom", probe: "pending" });
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
      expect(g.allowsWebgl()).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(`terminal renderer: dom (probe: ${verdict})`);
    },
  );

  it("a probe that throws is logged as an error", async () => {
    const { g, log } = gate({
      linux: true,
      probe: async () => {
        throw new Error("no GL");
      },
    });
    expect(g.allowsWebgl()).toBe(false);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("terminal renderer: dom (probe: error)"),
    );
  });

  it.each([
    ["dom", false],
    ["webgl", true],
  ] as const)("the override %s skips the probe on Linux", (override, webgl) => {
    const { g, log, probe } = gate({ linux: true, override });
    expect(g.allowsWebgl()).toBe(webgl);
    expect(probe).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      [`terminal renderer: ${override} (probe: skipped), CODESENSE_TERMINAL_RENDERER=${override}`],
    ]);
  });
});
