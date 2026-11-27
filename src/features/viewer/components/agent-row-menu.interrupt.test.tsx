// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTreeNode } from "@/features/viewer/lib/agent-list-view";
import type { AgentSessionRow } from "@/tauri/commands";
import type { IdentityMenuKit } from "./agent-identity-menus";

const interruptAgent = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/interrupt-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/interrupt-agent")>()),
  interruptAgent,
}));
vi.mock("@/features/viewer/lib/agent-inbox-actions", () => ({
  useAgentChatEligible: () => false,
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
  kind: "terminal",
  handle: "h",
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
      onReveal={() => {}}
      onTogglePin={() => {}}
      onStop={onStop}
    />,
  );
  const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
  return { labels, onStop };
}

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

  it.each([
    ["headless", { kind: "headless" }],
    ["opencode", { agentRevision: "builtin/opencode@1" }],
    ["ended", { alive: false }],
    ["session-less", { sessionId: null }],
    ["shell", { hasAgent: false }],
    ["hasAgent absent", { hasAgent: undefined }],
  ])("is absent on a %s row", (_name, patch) => {
    const { labels } = open({ ...liveClaude, ...patch } as AgentSessionRow, true);
    expect(labels).not.toContain("Interrupt");
  });

  it("adds Interrupt and nothing else to the menu", () => {
    const cases = [true, false].map((hasTab) => {
      const withIt = open(liveClaude, hasTab).labels;
      cleanup();
      const without = open({ ...liveClaude, hasAgent: false }, hasTab).labels;
      cleanup();
      return [withIt.filter((l) => l !== "Interrupt"), without];
    });
    for (const [a, b] of cases) expect(a).toEqual(b);
  });
});
