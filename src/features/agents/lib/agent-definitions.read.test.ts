// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { LiveHub, liveHub, type HubSnapshot } from "@/features/dashboard/lib/live-hub";
import { agentDefinitionsPrepare } from "@/tauri/commands";
import { resetAgentsStoreForTests, useAgentsStore } from "../stores/agents-store";
import {
  applyAgentDefinitions,
  readAgentDefinitions,
  resetAgentDefinitions,
  showAgentDefinitions,
} from "./agent-definitions";

vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  agentDefinitionsPrepare: vi.fn(),
}));
let hub: LiveHub;
afterEach(() => {
  resetAgentDefinitions();
  resetAgentsStoreForTests();
  hub?.dispose();
  vi.restoreAllMocks();
});

it("keeps the newer hub snapshot when a later explicit prepare returns an older revision", async () => {
  const { before, after } = JSON.parse(
    readFileSync("tests/fixtures/agent-definitions-save.json", "utf8"),
  ) as { before: HubSnapshot; after: HubSnapshot };
  let current = before;
  hub = new LiveHub({
    read: async () => current,
    listen: async () => () => {},
    readUi: async () => ({}),
    writeUi: async (_, state) => state,
  });
  vi.spyOn(liveHub, "seed").mockImplementation((view) => hub.seed(view));
  vi.spyOn(liveHub, "snapshot").mockImplementation((...args) => hub.snapshot(...args));
  vi.spyOn(liveHub, "attach").mockImplementation((...args) => hub.attach(...args));
  vi.spyOn(liveHub, "resync").mockImplementation((...args) => hub.resync(...args));
  vi.mocked(agentDefinitionsPrepare).mockResolvedValue(before);
  showAgentDefinitions(true);
  await vi.waitFor(() => expect(useAgentsStore.getState().rows?.length).toBeGreaterThan(0));
  let reply!: (view: HubSnapshot) => void;
  vi.mocked(agentDefinitionsPrepare).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const reading = readAgentDefinitions();
  current = after;
  hub.seed(after);
  applyAgentDefinitions(after);
  const names: string[] = [];
  const off = useAgentsStore.subscribe((state) => {
    names.push(state.rows!.find((row) => row.key.endsWith("/unused-live"))!.name);
  });
  reply(before);
  await reading;
  off();
  expect(names).not.toContain("Agent unused-live");
  expect(
    useAgentsStore.getState().rows!.find((row) => row.key.endsWith("/unused-live"))!.name,
  ).toBe("Saved without any session");
});

it("hiding the catalog hands its prepare's hold to the hub, which releases the latest one on eviction", async () => {
  const { before } = JSON.parse(
    readFileSync("tests/fixtures/agent-definitions-save.json", "utf8"),
  ) as { before: HubSnapshot };
  const release = vi.fn(async (_topic: string, _viewKey: string, _generation: number) => {});
  hub = new LiveHub({
    read: async () => before,
    release,
    listen: async () => () => {},
    readUi: async () => ({}),
    writeUi: async (_, state) => state,
  });
  vi.spyOn(liveHub, "seed").mockImplementation((view) => hub.seed(view));
  vi.spyOn(liveHub, "snapshot").mockImplementation((...args) => hub.snapshot(...args));
  vi.spyOn(liveHub, "attach").mockImplementation((...args) => hub.attach(...args));
  vi.spyOn(liveHub, "resync").mockImplementation((...args) => hub.resync(...args));
  vi.mocked(agentDefinitionsPrepare).mockResolvedValue({ ...before, hold: 1 });
  showAgentDefinitions(true);
  await vi.waitFor(() => expect(useAgentsStore.getState().rows?.length).toBeGreaterThan(0));
  vi.mocked(agentDefinitionsPrepare).mockResolvedValue({ ...before, hold: 2 });
  const seeded = vi.mocked(liveHub.seed).mock.calls.length;
  showAgentDefinitions(false);
  await vi.waitFor(() => expect(vi.mocked(liveHub.seed).mock.calls.length).toBe(seeded + 1));
  expect(release).not.toHaveBeenCalled();
  // The catalog's frame was its last holder: the view leaves the cache with the latest hold.
  resetAgentDefinitions();
  expect(release.mock.calls).toEqual([["agentDefinitions", before.viewKey, 2]]);
});
