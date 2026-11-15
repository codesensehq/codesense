// SPDX-License-Identifier: MIT
/**
 * The pin cap is set twice: in the engine (`weft/pins.rs`, which refuses a pin past it) and in the
 * kit's chat-core (the chat's Pin, Pin… and the "3 of 3 pinned" words). This reads the engine's
 * constant from source, so the two can't drift apart unnoticed.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { PIN_CAP } from "./chat-core";

const ENGINE = resolve(__dirname, "../../../../src-tauri/src/weft/pins.rs");

function enginePinCap(): number {
  const match = /pub const PIN_CAP: usize = (\d+);/.exec(readFileSync(ENGINE, "utf-8"));
  if (!match) throw new Error("weft/pins.rs no longer declares PIN_CAP");
  return Number(match[1]);
}

describe("the pin cap", () => {
  it("is the engine's PIN_CAP in the kit's chat-core, which the app and the pages share", () => {
    expect(PIN_CAP).toBe(enginePinCap());
  });
});
