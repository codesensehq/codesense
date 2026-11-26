// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { GIF_PROVIDER_IDS, GIF_PROVIDERS } from "./gif-providers";

describe("GIF_PROVIDERS", () => {
  it("names each provider once, with the search placeholder each requires", () => {
    expect(GIF_PROVIDER_IDS).toEqual(["giphy", "klipy"]);
    expect(Object.keys(GIF_PROVIDERS).sort()).toEqual([...GIF_PROVIDER_IDS].sort());
    expect(GIF_PROVIDERS.giphy.searchPlaceholder).toBe("Search GIPHY");
    expect(GIF_PROVIDERS.klipy.searchPlaceholder).toBe("Search KLIPY");
    expect(GIF_PROVIDERS.giphy.poweredBy).toBe("Powered By GIPHY");
    expect(GIF_PROVIDERS.klipy.poweredBy).toBe("Powered by KLIPY");
  });

  it("links each provider's terms over https and names its key source", () => {
    for (const id of GIF_PROVIDER_IDS) {
      const info = GIF_PROVIDERS[id];
      expect(new URL(info.termsUrl).protocol).toBe("https:");
      expect(info.keySource).toContain(info.name);
      expect(info.pings).toContain(info.name);
      expect(info.pings).toContain(
        "removing the key stops the pings and deletes the id; replacing the key gives the new key a new id.",
      );
    }
  });
});
