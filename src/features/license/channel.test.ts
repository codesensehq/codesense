// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";

import { downloadUrl, isBetaChannel, readBuildChannel } from "./channel";

describe("readBuildChannel", () => {
  afterEach(() => {
    delete window.__CODESENSE_CHANNEL__;
    delete window.__CODESENSE_PUBLIC_HOST__;
  });

  it("reads a beta channel and its public host", () => {
    window.__CODESENSE_CHANNEL__ = "beta";
    window.__CODESENSE_PUBLIC_HOST__ = "codesense.ai";
    expect(readBuildChannel()).toEqual({ channel: "beta", publicHost: "codesense.ai" });
    expect(isBetaChannel(readBuildChannel())).toBe(true);
  });

  it("reads the staging channel", () => {
    window.__CODESENSE_CHANNEL__ = "beta-staging";
    window.__CODESENSE_PUBLIC_HOST__ = "staging.example.invalid";
    expect(readBuildChannel()).toEqual({
      channel: "beta-staging",
      publicHost: "staging.example.invalid",
    });
  });

  it("uses the current build's public host for manual downloads", () => {
    expect(downloadUrl()).toBe("https://codesense.ai/download");
    window.__CODESENSE_CHANNEL__ = "beta";
    window.__CODESENSE_PUBLIC_HOST__ = "codesense.ai";
    expect(downloadUrl()).toBe("https://codesense.ai/download");
    window.__CODESENSE_CHANNEL__ = "beta-staging";
    window.__CODESENSE_PUBLIC_HOST__ = "preview.example.invalid";
    expect(downloadUrl()).toBe("https://preview.example.invalid/download");
  });

  it("treats the internal channel, a missing injection and an unknown value as internal", () => {
    expect(readBuildChannel().channel).toBe("internal");
    window.__CODESENSE_CHANNEL__ = "internal";
    expect(isBetaChannel(readBuildChannel())).toBe(false);
    window.__CODESENSE_CHANNEL__ = "nightly";
    expect(readBuildChannel().channel).toBe("internal");
  });
});
