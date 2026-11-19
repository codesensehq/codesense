// SPDX-License-Identifier: MIT
import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { getPlatformCaps } = vi.hoisted(() => ({ getPlatformCaps: vi.fn() }));
vi.mock("@/tauri/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tauri/commands")>()),
  getPlatformCaps,
}));

import { restorePlatform, setPlatform } from "@/test/platform";
import { useConfigStore } from "@/shared/stores/config-store";
import { resetPlatformCaps } from "./__test-utils__/platform-caps";
import {
  CAPABILITY_KEYS,
  notYetAvailableSentence,
  platformName,
  useCapability,
  type CapabilityKey,
} from "./capabilities";

interface TableRow {
  key: string;
  reason: string;
  scope?: string;
  macos: unknown;
  linux: unknown;
  windows: unknown;
}
const TABLE: TableRow[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../src-tauri/platform-caps.json"), "utf8"),
);

afterEach(() => {
  resetPlatformCaps();
  restorePlatform();
  getPlatformCaps.mockReset();
});

function Probe({ cap }: { cap: CapabilityKey }) {
  const { on, reason } = useCapability(cap);
  return <span data-testid={`cap-${cap}`}>{on ? "on" : `off: ${reason}`}</span>;
}

describe("useCapability", () => {
  it("reads the startup answer once, however many consumers ask", async () => {
    getPlatformCaps.mockResolvedValue([
      { key: "remote-machines", on: false, reason: "connecting is not built here" },
      { key: "mcp-bridge", on: true, reason: null },
    ]);
    const load = useConfigStore.getState().loadPlatformCaps;
    await Promise.all([load(), load()]);
    render(
      <>
        <Probe cap="remote-machines" />
        <Probe cap="mcp-bridge" />
        <Probe cap="remote-machines" />
      </>,
    );
    await load();
    expect(screen.getAllByTestId("cap-remote-machines").map((el) => el.textContent)).toEqual([
      "off: connecting is not built here",
      "off: connecting is not built here",
    ]);
    expect(screen.getByTestId("cap-mcp-bridge")).toHaveTextContent("on");
    expect(getPlatformCaps).toHaveBeenCalledTimes(1);
  });

  it("reads every capability as on before the answer lands, and when the read fails", async () => {
    getPlatformCaps.mockRejectedValue(new Error("no backend"));
    render(<Probe cap="remote-machines" />);
    expect(screen.getByTestId("cap-remote-machines")).toHaveTextContent("on");
    await useConfigStore.getState().loadPlatformCaps();
    await waitFor(() => expect(getPlatformCaps).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("cap-remote-machines")).toHaveTextContent("on");
  });

  it("knows every product capability in platform-caps.json, in its order", () => {
    expect(CAPABILITY_KEYS).toEqual(
      TABLE.filter((row) => row.scope !== "test").map((row) => row.key),
    );
  });
});

describe("the not-yet-available sentence", () => {
  it("names the OS and ends with the capability's reason", () => {
    setPlatform("Win32");
    expect(platformName()).toBe("Windows");
    expect(notYetAvailableSentence({ on: false, reason: "agents can't reach it" })).toBe(
      "Not yet available on Windows: agents can't reach it.",
    );
    setPlatform("Linux x86_64");
    expect(notYetAvailableSentence({ on: false, reason: null })).toBe(
      "Not yet available on Linux.",
    );
    setPlatform("MacIntel");
    expect(platformName()).toBe("macOS");
  });

  it("reads plainly for the reasons people see, true for every OS that has them off", () => {
    for (const key of ["mcp-bridge", "remote-machines"]) {
      const row = TABLE.find((r) => r.key === key)!;
      // The sentence already says "not yet"; a reason that says it again doubles it.
      expect(row.reason).not.toMatch(/\byet\b/i);
      // No transport or implementation terms, and nothing that names one OS.
      expect(row.reason).not.toMatch(
        /socket|pipe|MCP|bridge|IPC|sidecar|daemon|unix|windows|linux|macos/i,
      );
      expect(row.reason).toMatch(/this platform/);
    }
  });
});
