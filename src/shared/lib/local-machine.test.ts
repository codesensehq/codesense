// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  localMachineAndRemoteNoun,
  localMachineLabel,
  localMachineNoun,
  localMachinePhrase,
} from "./local-machine";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

describe("the local machine's name", () => {
  it.each([
    ["MacIntel", "This Mac", "this Mac", "Mac", "Mac and machine"],
    ["Win32", "This computer", "this computer", "computer", "machine"],
    ["Linux x86_64", "This computer", "this computer", "computer", "machine"],
  ])("on %s is %s / %s / %s / %s", (platform, label, phrase, noun, andRemote) => {
    setPlatform(platform);
    expect(localMachineLabel()).toBe(label);
    expect(localMachinePhrase()).toBe(phrase);
    expect(localMachineNoun()).toBe(noun);
    expect(localMachineAndRemoteNoun()).toBe(andRemote);
  });
});
