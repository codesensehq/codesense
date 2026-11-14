// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mockDependencyStatus } from "@/app/mock/fixtures";
import type { AgentBinaryStatus, DependencyStatus } from "@/tauri/commands";

const KIT = readFileSync(
  join(process.cwd(), "src-tauri/src/http/routes/dashboard_kit/kit.js"),
  "utf8",
);

type Agent = Partial<AgentBinaryStatus> & { available: boolean };
type Runtime = { id: string; version: string | null; autoPick: boolean };
type Kit = {
  runtimes(options?: {
    lastUsed?: string;
  }): Promise<{ list: Runtime[]; pick: string | null; resolving: boolean }>;
};

const ABSENT: AgentBinaryStatus = {
  available: false,
  path: null,
  resolving: false,
  version: null,
  source: null,
  shadowed: [],
  qualified: null,
  supported: null,
};

/** The app's mock status with every registered CLI absent, then `agents` laid over it. */
const status = (agents: Record<string, Agent>): DependencyStatus => ({
  ...mockDependencyStatus,
  agents: Object.fromEntries([
    ...Object.keys(mockDependencyStatus.agents).map((id) => [id, ABSENT]),
    ...Object.entries(agents).map(([id, a]) => [id, { ...ABSENT, ...a }]),
  ]),
});

function load(dependencyStatus: unknown): Kit {
  const w = window as unknown as Record<string, unknown>;
  delete w.codesense;
  delete w.__csKitCore;
  delete w.CS;
  w.codesense = {
    getDependencyStatus: () => Promise.resolve(dependencyStatus),
    has: () => true,
  };
  new Function(KIT)();
  return (w.codesense as { kit: Kit }).kit;
}

describe("kit.runtimes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("lists installed runtimes as Claude, Codex, OpenCode, with Hermes last", async () => {
    const kit = load(
      status({
        hermes: { available: true },
        opencode: { available: true, version: "2.1.4" },
        codex: { available: true },
        claude: { available: true, version: "2.0.1" },
      }),
    );
    const { list, pick } = await kit.runtimes();
    expect(list.map((r) => r.id)).toEqual(["claude", "codex", "opencode", "hermes"]);
    expect(list[0].version).toBe("2.0.1");
    expect(pick).toBe("claude");
  });

  it("puts the last used runtime first", async () => {
    const kit = load(
      status({
        claude: { available: true },
        codex: { available: true },
        opencode: { available: true },
      }),
    );
    const { list, pick } = await kit.runtimes({ lastUsed: "opencode" });
    expect(list.map((r) => r.id)).toEqual(["opencode", "claude", "codex"]);
    expect(pick).toBe("opencode");
  });

  it("leaves out runtimes that are missing or still resolving, and says some are resolving", async () => {
    const kit = load(
      status({
        claude: { available: false },
        codex: { available: false, resolving: true },
        opencode: { available: true },
      }),
    );
    const { list, pick, resolving } = await kit.runtimes();
    expect(list.map((r) => r.id)).toEqual(["opencode"]);
    expect(pick).toBe("opencode");
    expect(resolving).toBe(true);
  });

  it("reports resolving rather than an empty result while the app still looks for the CLIs", async () => {
    const kit = load(
      status({
        claude: { available: false, resolving: true },
        codex: { available: false, resolving: true },
      }),
    );
    expect(await kit.runtimes()).toEqual({ list: [], pick: null, resolving: true });
  });

  it("reads the app's mock status as is", async () => {
    const { list, resolving } = await load(mockDependencyStatus).runtimes();
    expect(list[0].id).toBe("claude");
    expect(resolving).toBe(false);
  });

  it("never auto-picks Hermes, even when it was last used or is the only one", async () => {
    const kit = load(status({ hermes: { available: true }, claude: { available: true } }));
    const used = await kit.runtimes({ lastUsed: "hermes" });
    expect(used.list.map((r) => r.id)).toEqual(["hermes", "claude"]);
    expect(used.list[0].autoPick).toBe(false);
    expect(used.pick).toBe("claude");

    const only = await load(status({ hermes: { available: true } })).runtimes();
    expect(only.list.map((r) => r.id)).toEqual(["hermes"]);
    expect(only.pick).toBeNull();
  });

  it("returns an empty list with no CLI installed and none resolving", async () => {
    expect(await load(status({})).runtimes()).toEqual({ list: [], pick: null, resolving: false });
  });

  it("ignores an unknown lastUsed", async () => {
    const kit = load(status({ claude: { available: true }, codex: { available: true } }));
    const { list } = await kit.runtimes({ lastUsed: "nope" });
    expect(list.map((r) => r.id)).toEqual(["claude", "codex"]);
  });
});
