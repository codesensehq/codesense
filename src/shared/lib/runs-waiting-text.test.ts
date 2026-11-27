// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { runsWaitingText } from "./runs-waiting-text";

describe("runsWaitingText", () => {
  it("counts one run, several runs, and caps at 99+", () => {
    expect(runsWaitingText(1)).toBe("1 run waiting");
    expect(runsWaitingText(2)).toBe("2 runs waiting");
    expect(runsWaitingText(99)).toBe("99 runs waiting");
    expect(runsWaitingText(100)).toBe("99+ runs waiting");
    expect(runsWaitingText(250)).toBe("99+ runs waiting");
  });
});
