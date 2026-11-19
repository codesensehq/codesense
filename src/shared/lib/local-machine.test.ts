// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { localMachineLabel, localMachineNoun, localMachinePhrase } from "./local-machine";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

describe("the local machine's name", () => {
  it.each([
    ["MacIntel", "This Mac", "this Mac", "Mac"],
    ["Win32", "This computer", "this computer", "computer"],
    ["Linux x86_64", "This computer", "this computer", "computer"],
  ])("on %s is %s / %s / %s", (platform, label, phrase, noun) => {
    setPlatform(platform);
    expect(localMachineLabel()).toBe(label);
    expect(localMachinePhrase()).toBe(phrase);
    expect(localMachineNoun()).toBe(noun);
  });
});
