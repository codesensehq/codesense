// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENTS_CSS = readFileSync(resolve(__dirname, "agents.css"), "utf-8");

const block = (selector: string): string | undefined =>
  new RegExp(`^${selector}\\s*\\{([^}]*)\\}`, "m").exec(AGENTS_CSS)?.[1];

describe("agents.css secondary ink tokens", () => {
  it("defines muted at 76% and faint at 70% once, for both themes", () => {
    const scope = block("\\.cs-agents,\\s*\\.cs-agent-identity");
    expect(scope).toContain("--ag-muted: color-mix(in oklab, var(--ag-text) 76%, var(--ag-bg));");
    expect(scope).toContain("--ag-faint: color-mix(in oklab, var(--ag-text) 70%, var(--ag-bg));");
    // The scope's two declarations plus the two `.ag-quick-send` re-points, and no others.
    expect(AGENTS_CSS.match(/^\s*--ag-(muted|faint):/gm)).toHaveLength(4);
  });

  it("keeps the quick-send overlay re-points", () => {
    const quickSend = block("\\.ag-quick-send");
    expect(quickSend).toContain("--ag-muted: var(--theme-text-overlay-muted)");
    expect(quickSend).toContain("--ag-faint: var(--ag-muted)");
  });

  it("keeps the chat body's inbox faint pointed at the list token", () => {
    expect(block("\\.ag-chat-body")).toContain("--ibx-faint: var(--ag-faint)");
  });
});
