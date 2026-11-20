// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import {
  backgroundRestoreHint,
  localMachineAndRemoteNoun,
  localMachineLabel,
  localMachineNoun,
  localMachinePhrase,
  quitOnCloseFooter,
  trayPlaceName,
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

describe("where the window comes back from", () => {
  it("on macOS is the Dock, and the item lives in the menu bar", () => {
    setPlatform("MacIntel");
    expect(trayPlaceName()).toBe("menu bar");
    expect(backgroundRestoreHint()).toBe("Click the dock icon to reopen it");
    expect(quitOnCloseFooter()).toMatch(/dock icon reopens it/);
    expect(quitOnCloseFooter()).not.toMatch(/tray/);
  });

  it.each(["Linux x86_64", "Win32"])("on %s is the tray icon's menu", (platform) => {
    setPlatform(platform);
    expect(trayPlaceName()).toBe("tray");
    expect(backgroundRestoreHint()).toBe("Open it again from the tray icon's menu");
    expect(quitOnCloseFooter()).toMatch(/while the terminal server's tray icon shows/);
    expect(quitOnCloseFooter()).toMatch(/with no tray icon, closing the window quits/);
    expect(quitOnCloseFooter()).not.toMatch(/dock/i);
  });
});
