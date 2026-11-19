// SPDX-License-Identifier: MIT
/**
 * Where a roster session runs is read from the row's shape, never its label. The
 * wire omits `machine` and `machineId` when they are none: a remote session has a
 * `machineId`, a local one has a `machine` (the app's "This Mac") and no `machineId`,
 * and a row with neither is unknown.
 */
import { afterEach, describe, expect, it } from "vitest";

import { render } from "@/test-utils";
import type { SessionListRow } from "@/tauri/commands";
import { instancesByAgent } from "@/features/agents/lib/agent-running";
import { WorkspaceChatMessageRow } from "@/features/workspace-chat/components/workspace-chat-message-row";
import { restorePlatform, setPlatform } from "@/test/platform";

import { chatIdentity } from "./components/group-chat";
import { sessionMentionDetail } from "./components/composer";
import { MachineTag } from "./components/primitives";
import { buildDirectory, machineLabel, participant, sendCheck } from "./model";

afterEach(restorePlatform);

/** A roster row as the wire sends it: absent keys are left out, never `null`. */
function wireRow(handle: string, extra: Partial<SessionListRow> = {}): SessionListRow {
  return {
    handle,
    displayName: handle,
    state: "idle",
    launchedBy: null,
    unread: 0,
    oldestUnreadAt: null,
    agent: "builtin/claude",
    ...extra,
  } as SessionListRow;
}

const LOCAL = wireRow("here", { machine: "This Mac" });
const REMOTE = wireRow("there", { machine: "Build box", machineId: "box" });
const UNKNOWN = wireRow("nowhere");
const dir = () => buildDirectory([LOCAL, REMOTE, UNKNOWN], []);

/** The machine tag the inbox and the chat show beside a session's name. */
function tags(handle: string): { inbox: string | null; chat: string | null } {
  const d = dir();
  const inbox = render(<MachineTag k={handle} dir={d} />).container.textContent || null;
  const { container } = render(
    <WorkspaceChatMessageRow
      identity={chatIdentity({ dir: d, me: "human" }, handle, handle)}
      message={{
        messageId: 1,
        from: handle,
        fromName: handle,
        createdAtMs: 0,
        text: "hi",
        workspaceId: "ws",
        kind: "chat",
      }}
      isLead={false}
      isHuman={false}
      avatarGlyph="A"
      roleColour="#fff"
    />,
  );
  return { inbox, chat: container.querySelector(".ibx-mtag")?.textContent ?? null };
}

describe.each([
  ["MacIntel", "This Mac"],
  ["Win32", "This computer"],
])("roster locality on %s", (platform, local) => {
  it("a local session, shaped as the wire sends it, shows no machine tag in the inbox or the chat", () => {
    setPlatform(platform);
    expect(participant(dir(), "here")).toMatchObject({ where: "local" });
    expect(participant(dir(), "here").machine).toBeUndefined();
    expect(tags("here")).toEqual({ inbox: null, chat: null });
    expect(machineLabel(participant(dir(), "here"))).toBe(local);
  });

  it("a session with a machine id shows its machine", () => {
    setPlatform(platform);
    expect(participant(dir(), "there")).toMatchObject({ where: "remote", machine: "Build box" });
    expect(tags("there")).toEqual({ inbox: "Build box", chat: "Build box" });
    expect(machineLabel(participant(dir(), "there"))).toBe("Build box");
  });

  it("a session with neither field is unknown and names no machine", () => {
    setPlatform(platform);
    const p = participant(dir(), "nowhere");
    expect(p.where).toBe("unknown");
    expect(machineLabel(p)).toBe("");
    expect(tags("nowhere")).toEqual({ inbox: null, chat: null });
    expect(sessionMentionDetail(p)).toBe("idle");
    const offline = buildDirectory([wireRow("nowhere", { state: "offline" })], []);
    expect(sendCheck("nowhere", offline, [])).toEqual({
      kind: "offline",
      hint: "Delivered when its machine reconnects",
    });
  });

  it("a session only a message mentions is unknown", () => {
    setPlatform(platform);
    const d = buildDirectory(
      [],
      [
        {
          id: 1,
          team: { org: "acme", team: "backend" },
          from: "gone-1",
          fromName: "Gone",
          to: "human",
          toName: "human",
          toRole: null,
          text: "bye",
          contentType: "plain",
          createdAtMs: 0,
          archivedAtMs: null,
          inReplyTo: null,
          via: null,
          replyTo: null,
          summary: null,
          unread: false,
          delivery: null,
          kind: "update",
        },
      ],
    );
    expect(participant(d, "gone-1").where).toBe("unknown");
  });

  it("a saved agent's running sessions name only a remote machine", () => {
    setPlatform(platform);
    const byAgent = instancesByAgent({ sessions: [LOCAL, REMOTE], startedAt: {} });
    const machines = (byAgent.get("builtin/claude") ?? []).map((i) => [i.handle, i.machine]);
    expect(Object.fromEntries(machines)).toEqual({ here: null, there: "Build box" });
  });
});
