// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A page launch types its agent's launch line into the bare shell through
 * `launchAgentLineInShell`. For a CLI the host observes (Claude, Codex) that line runs
 * under the activity wrapper (`--activity-exec`, composed trusted-side by
 * `terminal_launch_activity_line`), which is what lets the host see the CLI's first
 * lifecycle hook and so know it is input-ready. A line typed raw is never observed.
 */

const { source, layout } = vi.hoisted(() => ({
  source: {
    writePty: vi.fn(async () => undefined),
    submitPtyLine: vi.fn(async () => ({ submitted: true })),
    terminalLaunchActivityLine: vi.fn(async () => ({ submitted: true })),
    sessionIsIdle: vi.fn(async () => true),
  },
  layout: { target: undefined as undefined | Record<string, unknown> },
}));

vi.mock("@/features/viewer/lib/cli-workspace/transport/terminal-session-source", () => source);
vi.mock("@/features/viewer/lib/cli-workspace/store/viewer-access", () => ({
  getViewerState: () => ({ terminalLayout: {} }),
  selectTabBySessionId: () => ({ exit: undefined }),
}));
vi.mock("@/shared/lib/terminal-layout-projection", async (original) => ({
  ...(await original<typeof import("@/shared/lib/terminal-layout-projection")>()),
  sessionTarget: () => layout.target,
}));

import { launchAgentLineInShell } from "@/shared/lib/agent-session-launcher";

const TARGET = { member: "in-process", session: "s1" };

beforeEach(() => {
  vi.clearAllMocks();
  layout.target = TARGET;
});

describe("the page's agent launch line runs under the activity wrapper", () => {
  it.each([
    ["claude", "'/opt/bin/claude' '--settings' '/tmp/s.json'"],
    ["codex", "'/opt/bin/codex' '--model' 'gpt-5'"],
  ])("a %s line goes through terminalLaunchActivityLine, never raw", async (provider, line) => {
    await expect(launchAgentLineInShell("s1", line)).resolves.toEqual({ ok: true });
    expect(source.terminalLaunchActivityLine).toHaveBeenCalledTimes(1);
    const [target, cli, typed] = source.terminalLaunchActivityLine.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
    ];
    expect(target).toEqual(TARGET);
    expect(cli).toBe(provider);
    // The leading space (kept out of history) and the Enter ride the line; the backend
    // trims both and puts `<helper> --activity-exec <bootstrap> --` in front.
    expect(typed.trim()).toBe(line);
    expect(source.writePty).not.toHaveBeenCalled();
  });

  it("a CLI the wrapper does not observe is typed raw", async () => {
    await launchAgentLineInShell("s1", "'/opt/bin/opencode' '--model' 'x'");
    expect(source.terminalLaunchActivityLine).not.toHaveBeenCalled();
    expect(source.writePty).toHaveBeenCalledTimes(1);
  });

  it("a session the layout does not hold yet falls back to a raw write (unobserved)", async () => {
    layout.target = undefined;
    await launchAgentLineInShell("s1", "'/opt/bin/claude'");
    expect(source.terminalLaunchActivityLine).not.toHaveBeenCalled();
    expect(source.writePty).toHaveBeenCalledTimes(1);
  });
});
