// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAllAgentRowsStore } from "@/features/agents/lib/agent-names";
import type { AgentTreeNode } from "@/features/viewer/lib/agent-list-view";
import type { AgentSessionRow } from "@/tauri/commands";
import type { IdentityMenuKit } from "./agent-identity-menus";

const interruptAgent = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/interrupt-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/interrupt-agent")>()),
  interruptAgent,
}));
vi.mock("@/features/viewer/lib/agent-inbox-actions", () => ({
  useAgentChatEligible: () => true,
}));

import { RowMenu } from "./agent-row-menu";

const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const kit = {
  Sub: Pass,
  SubTrigger: Pass,
  SubContent: Pass,
  RadioGroup: Pass,
  RadioItem: Pass,
  Separator: () => <hr />,
  Label: Pass,
  Shortcut: () => null,
  Item: ({ children, onSelect, disabled }) => (
    <button role="menuitem" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
} as IdentityMenuKit;

const liveClaude = {
  sessionId: "s1",
  alive: true,
  hasAgent: true,
  kind: "dashboard-launched",
  handle: "h",
  machineId: null,
  launchedBy: "lead",
  agentRevision: "builtin/claude@1",
} as unknown as AgentSessionRow;

function open(row: AgentSessionRow, hasTab: boolean, onStop = vi.fn()) {
  const node = { row, story: null, workspace: null, children: [] } as unknown as AgentTreeNode;
  render(
    <RowMenu
      kit={kit}
      node={node}
      rowTeam="o/t"
      label="Ann"
      choice={undefined}
      holds={[]}
      hasTab={hasTab}
      headless={row.kind === "headless"}
      offlineMachine={null}
      viaName="Lead"
      pinLabel="Pin"
      pinHint="Pin it"
      onQuickView={() => {}}
      onReveal={() => {}}
      onSelectHandle={() => {}}
      onHideTab={() => {}}
      onTogglePin={() => {}}
      onMessage={() => {}}
      onOpenInbox={() => {}}
      onOpenStory={() => {}}
      onLaunchUnder={() => {}}
      onStop={onStop}
    />,
  );
  const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
  return { labels, onStop };
}

beforeEach(() => useAllAgentRowsStore.setState({ rows: null, error: null }));
afterEach(() => {
  cleanup();
  interruptAgent.mockClear();
});

describe("RowMenu Interrupt", () => {
  it("follows Go to terminal on a live Claude row, and interrupts once without stopping", () => {
    const { labels, onStop } = open(liveClaude, true);
    expect(labels[labels.indexOf("Go to terminal") + 1]).toBe("Interrupt");
    fireEvent.click(screen.getByRole("menuitem", { name: "Interrupt" }));
    expect(interruptAgent).toHaveBeenCalledTimes(1);
    expect(interruptAgent).toHaveBeenCalledWith(liveClaude, "claude");
    expect(onStop).not.toHaveBeenCalled();
  });

  it("follows Show on a live Claude row with no tab", () => {
    const { labels } = open(liveClaude, false);
    expect(labels[labels.indexOf("Show") + 1]).toBe("Interrupt");
  });

  it("is the only addition to the whole menu, in today's order", () => {
    const today = (reveal: string, tab: boolean) => [
      "Quick view",
      reveal,
      "Go to Lead",
      ...(tab ? ["Hide tab"] : []),
      "Pin",
      "Message in inbox",
      "Open inbox",
      "Open story",
      "Launch agent under Ann…",
      "Stop…",
    ];
    for (const [hasTab, reveal] of [
      [true, "Go to terminal"],
      [false, "Show"],
    ] as const) {
      const { labels } = open(liveClaude, hasTab);
      cleanup();
      const withoutIt = labels.filter((l) => l !== "Interrupt");
      expect(withoutIt.slice(0, today(reveal, hasTab).length)).toEqual(today(reveal, hasTab));
      const { labels: plain } = open({ ...liveClaude, hasAgent: false }, hasTab);
      cleanup();
      expect(withoutIt).toEqual(plain);
      expect(labels.length).toBe(plain.length + 1);
    }
  });

  it.each([
    ["headless", { kind: "headless" }],
    ["opencode", { agentRevision: "builtin/opencode@1" }],
    ["ended", { alive: false }],
    ["session-less", { sessionId: null }],
    ["shell", { hasAgent: false }],
    ["hasAgent absent", { hasAgent: undefined }],
    ["on a remote machine", { machineId: "m-1" }],
  ])("is absent on a %s row", (_name, patch) => {
    const { labels } = open({ ...liveClaude, ...patch } as AgentSessionRow, true);
    expect(labels).not.toContain("Interrupt");
  });
});

describe("RowMenu Interrupt runtime", () => {
  const savedRow = {
    ...liveClaude,
    agentRevision: "acme/web/helper@3",
    detected: { cli: null, dot: null },
  } as unknown as AgentSessionRow;
  const withDefinition = (runtime: string) =>
    useAllAgentRowsStore.setState({
      rows: [{ key: "acme/web/helper", runtime, scope: "team" }] as never,
      error: null,
    });

  it("uses a starter's own runtime", () => {
    open({ ...liveClaude, agentRevision: "builtin/codex@1" } as AgentSessionRow, true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Interrupt" }));
    expect(interruptAgent).toHaveBeenCalledWith(expect.anything(), "codex");
  });

  it("uses a saved agent's definition runtime", () => {
    withDefinition("codex");
    open(savedRow, true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Interrupt" }));
    expect(interruptAgent).toHaveBeenCalledWith(expect.anything(), "codex");
  });

  it("offers nothing on a saved agent whose runtime has no key", () => {
    withDefinition("hermes");
    expect(open(savedRow, true).labels).not.toContain("Interrupt");
  });

  it("uses the detected CLI of a hand-started agent", () => {
    const hand = {
      ...liveClaude,
      agentRevision: undefined,
      detected: { cli: "codex", dot: null },
    } as unknown as AgentSessionRow;
    open(hand, true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Interrupt" }));
    expect(interruptAgent).toHaveBeenCalledWith(expect.anything(), "codex");
  });

  it.each(["aider", "gemini", "cursor-agent"])(
    "offers nothing on a hand-started %s terminal",
    (cli) => {
      const hand = {
        ...liveClaude,
        agentRevision: undefined,
        detected: { cli, dot: null },
      } as unknown as AgentSessionRow;
      expect(open(hand, true).labels).not.toContain("Interrupt");
    },
  );

  it("offers nothing on a saved agent whose definition has not loaded and whose CLI is unknown", () => {
    expect(open(savedRow, true).labels).not.toContain("Interrupt");
  });
});
