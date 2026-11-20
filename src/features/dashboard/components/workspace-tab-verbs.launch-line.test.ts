// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  submitted: true,
  lines: [] as string[],
  projections: [] as unknown[][],
  execution: undefined as undefined | { argv: string[]; nativeLaunch: string },
}));
vi.mock("@/shared/lib/default-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/default-agent")>()),
  resolveAgentCliPath: vi.fn(async () => "/opt/bin/claude"),
}));
vi.mock("@/shared/lib/agent-session-injection", async (orig) => ({
  ...(await orig<typeof import("@/shared/lib/agent-session-injection")>()),
  injectAgentLine: vi.fn(async (_sid: string, line: string) => {
    h.lines.push(line);
    return h.submitted ? { ok: true } : { ok: false, reason: "not-submitted" };
  }),
}));
vi.mock("@/tauri/commands", async (orig) => ({
  ...(await orig<typeof import("@/tauri/commands")>()),
  projectMcpScopeConfig: vi.fn(async (...args: unknown[]) => {
    h.projections.push(args);
    return {
      extraArgs: ["--mcp-config", `/scope/${String(args[0])}.json`],
      environmentBinding: null,
      ...(h.execution ? { execution: h.execution } : {}),
    };
  }),
  sessionHasLiveAgent: vi.fn(async () => true),
}));

import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { getActiveTeamKey } from "@/shared/lib/team-key";
import { useViewerStore, type Workspace } from "@/shared/stores/viewer-store";
import { resolveAgentCliPath } from "@/shared/lib/default-agent";
import { sessionHasLiveAgent } from "@/tauri/commands";
import {
  makeRealOpenWorkspaceTabDeps,
  makeRealSendToWorkspaceTabDeps,
} from "./workspace-tab-verbs";

const WS = "generic:/work/dir";

/** The verb's real preparation and launch, for one session of `WS`. */
async function start(sessionId: string, workspaceId = WS): Promise<void> {
  const deps = makeRealOpenWorkspaceTabDeps();
  await deps.launchAgent(sessionId, await deps.prepareAgent(workspaceId, sessionId));
}

beforeEach(() => {
  h.execution = undefined;
  h.submitted = true;
  h.lines = [];
  h.projections = [];
  useAgentStateStore.setState({ launchBySession: {} });
  useViewerStore.setState({
    workspaces: {
      [getActiveTeamKey()]: [
        { id: WS, kind: "generic", cwd: "/work/dir", status: "ready" },
      ] as unknown as Workspace[],
    },
  });
});

describe("an agent tab opened by a dashboard verb", () => {
  it("launches with its per-session config and records the exact line", async () => {
    await start("shell-a");
    // No allowlist, the launcher's default args: the bridge and hooks for this session.
    expect(h.projections).toEqual([
      ["shell-a", "/work/dir", null, undefined, [], { binary: "claude", defaultArgs: true }],
    ]);
    expect(h.lines).toEqual([
      "'/opt/bin/claude' '--dangerously-skip-permissions' '--mcp-config' '/scope/shell-a.json'",
    ]);
    expect(useAgentStateStore.getState().launchBySession["shell-a"]).toEqual({
      line: h.lines[0],
      agent: "claude",
      // The panel spawned the shell; a relaunch projects a fresh config for its dir.
      spec: { agentPath: "/opt/bin/claude", configCwd: "/work/dir" },
    });
  });

  it("asks for the agent CLI path at every launch, never a cached one", async () => {
    const resolve = vi.mocked(resolveAgentCliPath);
    resolve.mockClear();
    resolve.mockResolvedValueOnce("/tmp/a/claude").mockResolvedValueOnce("/tmp/b/claude");
    await start("shell-c");
    await start("shell-d");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(h.lines[0]).toContain("'/tmp/a/claude'");
    expect(h.lines[1]).toContain("'/tmp/b/claude'");
  });

  it("records nothing when the line never submitted", async () => {
    h.submitted = false;
    await start("shell-b");
    expect(useAgentStateStore.getState().launchBySession).toEqual({});
  });

  it("an exec projection types no line and records the exec", async () => {
    h.execution = {
      argv: ["/opt/bin/claude", "--dangerously-skip-permissions", "--mcp-config", "/s.json"],
      nativeLaunch: "claude",
    };
    await start("shell-exec");
    expect(h.lines).toEqual([]);
    expect(useAgentStateStore.getState().launchBySession["shell-exec"]).toEqual({
      line: "'/opt/bin/claude' '--dangerously-skip-permissions' '--mcp-config' '/s.json'",
      agent: "claude",
      exec: true,
      spec: {
        agentPath: "/opt/bin/claude",
        configCwd: "/work/dir",
        args: ["--dangerously-skip-permissions", "--mcp-config", "/s.json"],
      },
    });
  });

  it.each([
    ["Win32", true],
    ["MacIntel", false],
    ["Linux x86_64", false],
  ])(
    "a workspace with no folder on %s: refused only where launches exec",
    async (platform, refused) => {
      vi.stubGlobal("navigator", { platform });
      const NO_DIR = "generic:/no-dir";
      useViewerStore.setState({
        workspaces: {
          [getActiveTeamKey()]: [
            { id: NO_DIR, kind: "generic", status: "ready" },
          ] as unknown as Workspace[],
        },
      });
      try {
        const started = start("shell-nodir", NO_DIR);
        if (refused) {
          await expect(started).rejects.toThrow(/^unavailable: /);
          expect(h.lines).toEqual([]);
        } else {
          await started;
          expect(h.lines).toEqual(["'/opt/bin/claude' '--dangerously-skip-permissions'"]);
        }
        expect(h.projections).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("probes the running agent even when its install is no longer available", async () => {
    const resolve = vi.mocked(resolveAgentCliPath);
    resolve.mockResolvedValueOnce("/tmp/codex");
    await start("shell-live");
    resolve.mockClear();
    resolve.mockResolvedValue(null);
    expect(await makeRealSendToWorkspaceTabDeps().agentLive("shell-live")).toBe(true);
    expect(sessionHasLiveAgent).toHaveBeenCalledWith("shell-live", "codex");
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockResolvedValue("/opt/bin/claude");
  });
});

it("page openTab retains its trusted frame before projecting and exposing an agent bridge", async () => {
  const { HTML_BRIDGE_ALLOWLIST: bridge } = await import("./html-bridge");
  const { frameFixture } = await import("../../../../tests/support/fixtures/frame");
  const page = "/parent/content/shared.html";
  const frame = frameFixture({
    documentPath: page,
    contentRoot: "/child/content",
    slot: "right-pane",
  });
  const original = useViewerStore.getState().openTabInWorkspace;
  useViewerStore.setState({ openTabInWorkspace: vi.fn(() => "page-agent") });
  try {
    await bridge.openTab(
      { workspaceId: WS, agent: true },
      { frame, docPath: page, controller: {} as never },
    );
    expect(h.projections[0]?.[5]).toMatchObject({
      frameId: frame.frameId,
      pagePath: page,
      teamKey: getActiveTeamKey(),
    });
    expect(h.lines).toHaveLength(1);
  } finally {
    useViewerStore.setState({ openTabInWorkspace: original });
  }
});
