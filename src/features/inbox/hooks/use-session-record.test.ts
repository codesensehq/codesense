// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { formatCost, modelLabel } from "./use-session-record";

describe("the record line's words", () => {
  it("says a model as people do, and any other id as it is", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5-5-20261101")).toBe("Sonnet 5.5");
    expect(modelLabel("gpt-5.5-codex")).toBe("gpt-5.5-codex");
  });
  it("says a cost to the cent, and a fraction of a cent as under one", () => {
    expect(formatCost(1.255)).toBe("$1.25");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.003)).toBe("<$0.01");
    expect(formatCost(20.7)).toBe("$20.70");
  });
});
