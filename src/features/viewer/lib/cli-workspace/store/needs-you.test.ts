// SPDX-License-Identifier: MIT
import { projectSessionStatus } from "@/test/session-projection-fixture";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
beforeEach(() => {
  useAgentListProjectionStore.setState({ sessions: [] });
  for (const [id, status] of Object.entries({
    crashed: "crashed",
    failed: "failed",
    done: "idle",
    thinking: "thinking",
    permission: "paused",
    asking: "awaiting-answer",
    blocked: "paused",
    idleOut: "paused",
    plainError: "failed",
  } as const))
    projectSessionStatus(id, status);
});
import { beforeEach, describe, expect, it } from "vitest";

import { advanceSessionAgent, type SessionAgentInput } from "@/shared/lib/agent-state";
import { selectAgentDots, type SeenSources } from "@/shared/stores/agent-state-store";
import type { TerminalTab, TerminalWireStatus } from "@/shared/stores/viewer-store";
import type { ActivitySnapshot } from "@/tauri/commands";
import {
  isNeedsYouNews,
  NEEDS_YOU_STATUSES,
  type NeedsYouListState,
  selectScopeMarkFacts,
  selectCliNeedsYouKind,
  selectNeedsYouKind,
  selectSessionNeedsYou,
  selectSessionsNeedingYou,
} from "./terminal-tab-selectors";

const hook = (
  event: "UserPromptSubmit" | "Stop" | "PermissionRequest" | "StopFailure",
): SessionAgentInput => ({ tier: 1, signal: { kind: "claude-hook", event } });
const killed: SessionAgentInput = {
  tier: 2,
  signal: { kind: "exited", code: 137 },
  source: "command-end",
};
const thinking = advanceSessionAgent(undefined, hook("UserPromptSubmit"), 1);
const records = {
  crashed: advanceSessionAgent(thinking, killed, 2),
  failed: advanceSessionAgent(thinking, hook("StopFailure"), 2),
  done: advanceSessionAgent(thinking, hook("Stop"), 2),
  thinking,
  permission: advanceSessionAgent(thinking, hook("PermissionRequest"), 2),
  idleOut: thinking,
  // The agent's own ask_user sends the MCP ask-user signal, which sets needs-permission.
  askSignal: advanceSessionAgent(thinking, { tier: 1, signal: { kind: "ask-user" } }, 2),
  askThenApproval: advanceSessionAgent(
    advanceSessionAgent(thinking, { tier: 1, signal: { kind: "ask-user" } }, 2),
    hook("PermissionRequest"),
    3,
  ),
  approvalThenAsk: advanceSessionAgent(
    advanceSessionAgent(thinking, hook("PermissionRequest"), 2),
    { tier: 1, signal: { kind: "ask-user" } },
    3,
  ),
  // The ask closed (ask-resolved) while the approval stayed open.
  approvalAfterAsk: advanceSessionAgent(
    advanceSessionAgent(
      advanceSessionAgent(thinking, hook("PermissionRequest"), 2),
      { tier: 1, signal: { kind: "ask-user" } },
      3,
    ),
    { tier: 1, signal: { kind: "ask-resolved" } },
    4,
  ),
};
const agentDots = selectAgentDots({ bySession: records, exitBySession: {} });
const stored: Record<string, TerminalWireStatus> = {
  blocked: "needs-permission",
  idleOut: "needs-permission",
  plainError: "error",
};
const NOT_SEEN: SeenSources = { stateSince: {}, seenAt: {} };
const state = (extra: Partial<NeedsYouListState> = {}): NeedsYouListState => ({
  aiStatusBySession: stored,
  agentDots,
  pendingAsks: { q1: { sessionId: "asking" } },
  openTabs: {},
  hiddenTabs: {},
  minimizedTabs: {},
  workspaces: {},
  seen: NOT_SEEN,
  ...extra,
});
/** `ids` were looked at after their dot began. */
const seenOnly = (...ids: string[]): SeenSources => ({
  stateSince: Object.fromEntries(ids.map((id) => [id, 1])),
  seenAt: Object.fromEntries(ids.map((id) => [id, 2])),
});
const tab = (id: string): TerminalTab => ({ id: `t-${id}`, name: id, sessionId: id });

describe("selectSessionNeedsYou / selectNeedsYouKind — anchored to the dot", () => {
  it.each([
    ["asking", "question"],
    ["crashed", "crashed"],
    ["failed", "failed"],
    ["plainError", "failed"],
    ["permission", "permission"],
    ["blocked", "permission"],
    ["idleOut", "permission"],
  ] as const)("%s needs you (%s)", (id, kind) => {
    expect(selectNeedsYouKind(state(), id)).toBe(kind);
    expect(selectSessionNeedsYou(state(), id)).toBe(true);
  });

  it.each(["done", "thinking", "nothing"])("%s does not", (id) => {
    expect(selectNeedsYouKind(state(), id)).toBeNull();
    expect(selectSessionNeedsYou(state(), id)).toBe(false);
  });

  it("a question outranks the dot's reason", () => {
    const s = state({ pendingAsks: { q: { sessionId: "crashed" } } });
    expect(selectNeedsYouKind(s, "crashed")).toBe("question");
  });

  it.each(["done", "failed", "needs-attention"] as const)(
    "an actionable pending question still wins over retained %s",
    (outcome) => {
      expect(
        selectNeedsYouKind(
          state({
            pendingAsks: { current: { sessionId: "permission" } },
            outcomes: { permission: outcome },
          }),
          "permission",
        ),
      ).toBe("question");
    },
  );

  it.each(["current", "recovering", "unavailable"] as const)(
    "native elicitation remains a question while activity is %s",
    (freshness) => {
      const snapshot: ActivitySnapshot = {
        session: "permission",
        identity: { hostBootId: "boot", sessionIncarnation: "pty", invocationId: "run" },
        revision: 1,
        turnGeneration: 1,
        provider: "claude",
        state: "needs-permission",
        reason: "question",
        observed: true,
        limited: false,
        exit: null,
        asks: [],
      };
      const s = state({
        crashes: {
          bySession: records,
          activityBySession: { permission: { snapshot, freshness } },
        },
      });
      expect(selectNeedsYouKind(s, "permission")).toBe("question");
      expect(selectSessionNeedsYou(s, "permission")).toBe(true);
      // Closing an independent MCP ask and observing sibling activity leaves
      // the native question authoritative until that provider wait is answered.
      snapshot.asks = ["independent-ask"];
      expect(selectNeedsYouKind(s, "permission")).toBe("question");
      snapshot.asks = [];
      snapshot.revision += 2;
      expect(selectNeedsYouKind(s, "permission")).toBe("question");
      // Answering the question can expose a different surviving approval.
      snapshot.revision += 1;
      snapshot.reason = undefined;
      expect(selectNeedsYouKind(s, "permission")).toBe("permission");
      snapshot.asks = ["recovered-mcp-ask"];
      expect(selectNeedsYouKind(s, "permission")).toBe("question");
      snapshot.asks = [];
      expect(selectNeedsYouKind(s, "permission")).toBe("permission");
      snapshot.reason = "permission";
      expect(selectNeedsYouKind(s, "permission")).toBe("permission");
      snapshot.reason = "question";
      snapshot.exit = { code: 0, signal: null, requested: false };
      expect(selectNeedsYouKind(s, "permission")).toBe("permission");
    },
  );

  it("the needs-you dot states are needs-permission, crashed and error", () => {
    expect([...NEEDS_YOU_STATUSES].sort()).toEqual(["crashed", "error", "needs-permission"]);
  });
});

describe("selectCliNeedsYouKind — what the CLI itself is waiting on", () => {
  const snapshot = (reason?: ActivitySnapshot["reason"]): ActivitySnapshot => ({
    session: "permission",
    identity: { hostBootId: "boot", sessionIncarnation: "pty", invocationId: "run" },
    revision: 1,
    turnGeneration: 1,
    provider: "claude",
    state: "needs-permission",
    ...(reason ? { reason } : {}),
    observed: true,
    limited: false,
    exit: null,
    asks: [],
  });
  const withSnapshot = (
    id: string,
    snap: ActivitySnapshot,
    extra: Partial<NeedsYouListState> = {},
  ) =>
    state({
      crashes: {
        bySession: records,
        activityBySession: { [id]: { snapshot: { ...snap, session: id }, freshness: "current" } },
      },
      ...extra,
    });

  it("a permission prompt is the CLI's", () => {
    expect(selectCliNeedsYouKind(state(), "permission")).toBe("permission");
  });

  it("a startup screen is the CLI's", () => {
    projectSessionStatus("booting", "paused", { needsYouKind: "startup" });
    expect(selectCliNeedsYouKind(state(), "booting")).toBe("startup");
  });

  it("a question from the CLI's own status is the CLI's", () => {
    expect(
      selectCliNeedsYouKind(withSnapshot("permission", snapshot("question")), "permission"),
    ).toBe("question");
  });

  it("an ask_user alone is the chat's, not the CLI's", () => {
    expect(selectNeedsYouKind(state(), "asking")).toBe("question");
    expect(selectCliNeedsYouKind(state(), "asking")).toBeNull();
    const ask = withSnapshot("asking", {
      ...snapshot(),
      state: "idle",
      reason: undefined,
      asks: ["a"],
    });
    expect(selectCliNeedsYouKind(ask, "asking")).toBeNull();
  });

  it("with an ask_user and a CLI question both open, the CLI question wins", () => {
    const both = withSnapshot("permission", snapshot("question"), {
      pendingAsks: { q: { sessionId: "permission" } },
    });
    expect(selectCliNeedsYouKind(both, "permission")).toBe("question");
  });

  it("with an ask_user open and the CLI on a permission prompt, the CLI's prompt shows", () => {
    const both = state({ pendingAsks: { q: { sessionId: "permission" } } });
    expect(selectNeedsYouKind(both, "permission")).toBe("question");
    expect(selectCliNeedsYouKind(both, "permission")).toBe("permission");
  });

  it("an ask_user's own signal is not a CLI permission prompt", () => {
    expect(records.askSignal.state).toBe("needs-permission");
    const ask = state({
      pendingAsks: { q: { sessionId: "askSignal" } },
      crashes: { bySession: records },
    });
    expect(selectNeedsYouKind(ask, "askSignal")).toBe("question");
    expect(selectCliNeedsYouKind(ask, "askSignal")).toBeNull();
  });

  it("an ask_user with a hook approval prompt open beside it shows the CLI's permission", () => {
    const both = state({
      pendingAsks: { q: { sessionId: "askThenApproval" } },
      crashes: { bySession: records },
    });
    expect(selectCliNeedsYouKind(both, "askThenApproval")).toBe("permission");
  });

  it("a hook approval then an ask_user: the CLI's permission shows until the ask closes", () => {
    const both = state({
      pendingAsks: { q: { sessionId: "approvalThenAsk" } },
      crashes: { bySession: records },
    });
    expect(selectNeedsYouKind(both, "approvalThenAsk")).toBe("question");
    expect(selectCliNeedsYouKind(both, "approvalThenAsk")).toBe("permission");
  });

  it("the approval's needs-you holds after the ask closes", () => {
    const after = state({ crashes: { bySession: records } });
    expect(selectNeedsYouKind(after, "approvalAfterAsk")).toBe("permission");
    expect(selectCliNeedsYouKind(after, "approvalAfterAsk")).toBe("permission");
  });

  it("an ask_user with a scraped approval prompt open beside it shows the CLI's permission", () => {
    // The scrape reaches the store as the wire status; no ask-user signal is on the record.
    const both = state({
      pendingAsks: { q: { sessionId: "idleOut" } },
      crashes: { bySession: records },
    });
    expect(selectCliNeedsYouKind(both, "idleOut")).toBe("permission");
  });

  it("clears when the CLI's question is answered", () => {
    const answered = { ...snapshot("question"), state: "working" } as ActivitySnapshot;
    expect(selectCliNeedsYouKind(withSnapshot("permission", answered), "permission")).toBe(
      "permission",
    );
    const gone = { ...snapshot("question"), exit: { code: 0, signal: null, requested: false } };
    expect(selectCliNeedsYouKind(withSnapshot("asking", gone), "asking")).toBeNull();
  });

  it.each(["crashed", "failed", "done", "thinking", "nothing"])("%s is not a CLI prompt", (id) => {
    expect(selectCliNeedsYouKind(state(), id)).toBeNull();
  });
});

describe("the seen rule", () => {
  it("seen never takes a stuck agent off needs-you: a seen crash or failure still needs you", () => {
    const s = state({ seen: seenOnly("crashed", "failed", "permission", "asking") });
    expect(selectSessionNeedsYou(s, "crashed")).toBe(true);
    expect(selectSessionNeedsYou(s, "failed")).toBe(true);
    expect(selectSessionNeedsYou(s, "permission")).toBe(true);
    expect(selectSessionNeedsYou(s, "asking")).toBe(true);
    expect(selectSessionNeedsYou(s, "done")).toBe(false);
  });

  it("a crash dismissed from its pane no longer needs you", () => {
    projectSessionStatus("crashed", "done", { crashId: "dismissed" });
    const s = state({
      crashes: {
        bySession: { crashed: records.crashed },
      },
    });
    expect(selectNeedsYouKind(s, "crashed")).toBeNull();
    expect(selectNeedsYouKind(s, "failed")).toBe("failed");
  });

  it("only an unseen crash or failure is news; a question or permission always is", () => {
    expect(isNeedsYouNews({ kind: "blocked", seen: true })).toBe(true);
    expect(isNeedsYouNews({ kind: "blocked", seen: false })).toBe(true);
    expect(isNeedsYouNews({ kind: "question", seen: true })).toBe(true);
    expect(isNeedsYouNews({ kind: "permission", seen: true })).toBe(true);
    expect(isNeedsYouNews({ kind: "crashed", seen: true })).toBe(false);
    expect(isNeedsYouNews({ kind: "failed", seen: true })).toBe(false);
    expect(isNeedsYouNews({ kind: "crashed", seen: false })).toBe(true);
  });
});

describe("selectSessionsNeedingYou — every resolvable tab, once, oldest first", () => {
  const WS = { a: [{ id: "w1" }], b: [{ id: "w3" }] };
  const list = (teamKey?: string | null, extra: Partial<NeedsYouListState> = {}) =>
    selectSessionsNeedingYou(
      state({
        workspaces: WS,
        // The terminal layout's indexes: w1 open, w2 minimized, and a
        // record-less bucket whose only tab is Hidden.
        openTabs: {
          a: {
            w1: [tab("done"), tab("permission"), tab("crashed")],
            gone: [],
          },
          b: { w3: [tab("blocked")] },
        },
        hiddenTabs: { a: { w1: [tab("asking"), tab("crashed")], gone: [tab("plainError")] } },
        minimizedTabs: { a: { w2: [tab("idleOut")] } },
        pendingAsks: { q1: { sessionId: "asking" } },
        seen: { stateSince: { crashed: 30, permission: 20, idleOut: 10 }, seenAt: {} },
        ...extra,
      }),
      teamKey,
    );
  const row = (
    sessionId: string,
    workspaceId: string,
    kind: string,
    hidden = false,
    seen = false,
  ) => ({ sessionId, teamKey: "a", workspaceId, tabId: `t-${sessionId}`, hidden, kind, seen });

  it("walks open, minimized and Hidden tabs, skips orphans, marks Hidden, orders by when", () => {
    expect(list("a")).toEqual([
      row("idleOut", "w2", "permission"),
      row("permission", "w1", "permission"),
      row("crashed", "w1", "crashed"),
      row("asking", "w1", "question", true),
    ]);
  });

  it("a truly orphaned bucket is not listed", () => {
    const rows = list("a");
    // Hidden tab "plainError" sits under "gone": no record, no live tabs.
    expect(rows.map((r) => r.sessionId)).not.toContain("plainError");
  });

  // SW-CR-6 R3 (B5): a record-less openTabs bucket with LIVE tabs — produced for
  // stale layout keys / MCP-opened stories whose record didn't materialize —
  // must be skipped (not surfaced as a hidden-agent row); hidden-by-default
  // agent surfaces are retired. Pins the branch where the old visit() returned
  // `hidden:true` for `!records.has(wsId)`.
  it("a record-less openTabs bucket with live tabs is skipped (orphan — no hidden-agent row)", () => {
    const rows = list("a", {
      openTabs: {
        a: {
          w1: [tab("done"), tab("permission"), tab("crashed")],
          "stale-ws": [tab("plainError")],
          gone: [],
        },
        b: { w3: [tab("blocked")] },
      },
    });
    expect(rows.map((r) => r.sessionId)).not.toContain("plainError");
    expect(rows.map((r) => r.workspaceId)).not.toContain("stale-ws");
  });

  it("a seen crash and a seen permission both stay, marked seen", () => {
    const rows = list("a", {
      seen: {
        stateSince: { crashed: 30, permission: 20 },
        seenAt: { crashed: 31, permission: 21 },
      },
    });
    expect(rows.find((r) => r.sessionId === "crashed")?.seen).toBe(true);
    expect(rows.find((r) => r.sessionId === "permission")?.seen).toBe(true);
  });

  it("every team when no team is given; one team when it is", () => {
    expect(list().map((r) => r.sessionId)).toContain("blocked");
    expect(
      list(null)
        .map((r) => r.teamKey)
        .sort(),
    ).toEqual(["a", "a", "a", "a", "b"]);
    expect(list("b").map((r) => r.sessionId)).toEqual(["blocked"]);
    expect(list("nope")).toEqual([]);
  });
});

describe("selectScopeMarkFacts — the one roll-up over sessions", () => {
  const sources = { aiStatusBySession: stored };
  const agent = (seen: SeenSources) => ({
    ...seen,
    bySession: records,
    exitBySession: {},
  });
  const top = (seen: SeenSources, ids: string[]) =>
    selectScopeMarkFacts(
      sources,
      agentDots,
      agent(seen),
      ids.map((sessionId) => ({ sessionId })),
    ).mark;

  it("needs you outranks a crash, a crash outranks work, seen or not", () => {
    // the finer `permission` mark replaced the generic `needs` roll-up
    // key. Rank order is unchanged (needs-you > crash > work).
    expect(top(NOT_SEEN, ["crashed", "thinking", "permission"])).toBe("permission");
    expect(top(NOT_SEEN, ["crashed", "thinking"])).toBe("crashed");
    expect(top(seenOnly("crashed"), ["crashed", "thinking"])).toBe("crashed");
    expect(top(NOT_SEEN, ["failed", "thinking"])).toBe("error");
  });

  it("a finished turn reads ready, seen or not, and never outranks work", () => {
    expect(top(NOT_SEEN, ["done"])).toBe("ready");
    expect(top(seenOnly("done"), ["done"])).toBe("ready");
    // A thinking session's roll-up is `thinking` (no tool open), not the
    // generic pre-WC-7 `working`.
    expect(top(NOT_SEEN, ["done", "thinking"])).toBe("thinking");
  });
});
