// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { SAMPLE_DAY } from "./sample-day";

const day = SAMPLE_DAY;
const sessions = new Set(day.agents.map((agent) => agent.session));
const handles = new Set(day.agents.map((agent) => agent.handle));

describe("the 14:02 sample day", () => {
  it("names every session, handle and work item once", () => {
    expect(sessions.size).toBe(day.agents.length);
    expect(handles.size).toBe(day.agents.length);
    expect(new Set(day.workItems.map((item) => item.id)).size).toBe(day.workItems.length);
    for (const item of day.workItems) expect(item.id).toMatch(/^wi_[0-9a-f]{16}$/);
  });

  it("records every launcher as a handle, a routine or a person", () => {
    for (const agent of day.agents) {
      const by = agent.launchedBy;
      if (by === null) continue;
      if (by.startsWith("routine:")) {
        // The routine's full key, as `routine_launcher` records it.
        expect(by, agent.name).toMatch(/^routine:[^/\s]+\/[^/\s]+\/[^/\s]+$/);
        continue;
      }
      expect(handles, `${agent.name} launched by ${by}`).toContain(by);
    }
  });

  it("gives a launched worker its launcher's work item, and a shell none", () => {
    const byHandle = new Map(day.agents.map((agent) => [agent.handle, agent]));
    const items = new Set(day.workItems.map((item) => item.id));
    for (const agent of day.agents) {
      if (agent.shell || agent.startedByYou) {
        expect(agent.workItem, agent.name).toBeNull();
        continue;
      }
      if (agent.workItem !== null) expect(items, agent.name).toContain(agent.workItem);
      const launcher = agent.launchedBy ? byHandle.get(agent.launchedBy) : undefined;
      if (launcher?.workItem) expect(agent.workItem, agent.name).toBe(launcher.workItem);
    }
    for (const item of day.workItems) {
      const lead = day.agents.find((agent) => agent.session === item.leadSession);
      expect(lead?.workItem, item.id).toBe(item.id);
    }
  });

  it("states the counts the frames draw", () => {
    const listed = day.agents.filter((agent) => agent.registered);
    const needs = new Set(day.expect.needsYou.map((item) => item.session));
    const live = listed.filter((agent) => agent.state !== "ended");
    expect({
      needsYou: live.filter((agent) => needs.has(agent.session)).length,
      busy: live.filter((agent) => agent.state === "busy" && !needs.has(agent.session)).length,
      idle: live.filter((agent) => agent.state === "idle" && !needs.has(agent.session)).length,
      endedToday: listed.filter((agent) => agent.state === "ended").length,
    }).toEqual(day.expect.listStatus);
    expect(day.agents.reduce((sum, agent) => sum + agent.spendToday, 0)).toBe(
      day.expect.spendToday,
    );
    expect(day.leadChanges.branches.reduce((sum, branch) => sum + branch.files, 0)).toBe(
      day.expect.leadChangedFiles,
    );
    const unread: Record<string, number> = {};
    for (const card of day.inbox) if (!card.read) unread[card.from] = (unread[card.from] ?? 0) + 1;
    expect(unread).toEqual(day.expect.unreadByAgent);
  });

  it("keeps the expected set to live sessions, and the FYI out of it", () => {
    for (const item of day.expect.needsYou) expect(sessions).toContain(item.session);
    const fyi = day.inbox.filter((card) => card.kind === "update");
    expect(fyi).toHaveLength(1);
    expect(day.expect.needsYou.map((item) => item.id)).not.toContain(
      `inbox:${fyi[0].org}/${fyi[0].team}/${fyi[0].messageId}`,
    );
  });
});
