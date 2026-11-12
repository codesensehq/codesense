// SPDX-License-Identifier: MIT
// The overlay's pin strip refreshes on the event the Rust pin list emits; a rename on one
// side must fail here instead of leaving the strip stale.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { AGENT_PINS_CHANGED_EVENT } from "./events";

const pinsSrc = readFileSync(
  resolve(__dirname, "../../src-tauri/src/commands/agent_inbox/pins.rs"),
  "utf-8",
);

describe("agent pins changed-event contract", () => {
  it("the TS event const equals the Rust AGENT_PINS_CHANGED_EVENT literal", () => {
    const match = pinsSrc.match(/AGENT_PINS_CHANGED_EVENT:\s*&str\s*=\s*"([^"]+)"/);
    expect(match, "Rust AGENT_PINS_CHANGED_EVENT const not found").not.toBeNull();
    expect(AGENT_PINS_CHANGED_EVENT).toBe(match![1]);
  });

  it("the payload fields match the Rust PinsChanged struct", () => {
    const body = pinsSrc.match(/pub\(crate\) struct PinsChanged \{([^}]*)\}/);
    expect(body, "Rust PinsChanged struct not found").not.toBeNull();
    const fields = [...body![1].matchAll(/pub (\w+):/g)].map((m) =>
      m[1].replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
    );
    expect(fields).toEqual(["org", "team", "agentId", "storyId"]);
  });
});
