// SPDX-License-Identifier: MIT
/**
 * The GIF providers' strings are written once, in gif-providers.ts. Two copies can't import it: the
 * kit chat bundle's table (`GIF_PROVIDER_COPY` in chat/copy.js, which the GIF picker reads) and the
 * Inbox pane's attribution map (`GIF_POWERED_BY`, under sent GIFs and in the lightbox); a third,
 * the dashboard catalog's inbox description, quotes the attributions. Any drift in any fails here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GIF_PROVIDER_IDS, GIF_PROVIDERS } from "./gif-providers";

const ROOT = resolve(__dirname, "../../..");
const COPY_JS = resolve(ROOT, "src-tauri/src/http/routes/dashboard_kit/chat/copy.js");
const CATALOG_RS = resolve(ROOT, "src-tauri/src/dashboard_publish/catalog.rs");
const PANE = readFileSync(
  resolve(ROOT, "src/features/shell/right-pane/__fixtures__/inbox-pane.html"),
  "utf8",
);

type ProviderCopy = Record<string, { name: string; searchPlaceholder: string; poweredBy: string }>;

// The pane's map is a plain object literal of string pairs: read it as JSON.
function panePoweredBy(): Record<string, string> {
  const literal = /const GIF_POWERED_BY = (\{[^}]*\});/.exec(PANE)?.[1];
  if (!literal) throw new Error("inbox-pane.html has no GIF_POWERED_BY map");
  return JSON.parse(literal.replace(/(\w+):/g, '"$1":')) as Record<string, string>;
}

describe("GIF provider strings", () => {
  it("the kit chat table names each provider, its placeholder and its attribution as gif-providers.ts does", async () => {
    const { GIF_PROVIDER_COPY } = (await import(/* @vite-ignore */ COPY_JS)) as {
      GIF_PROVIDER_COPY: ProviderCopy;
    };
    expect(Object.keys(GIF_PROVIDER_COPY).sort()).toEqual([...GIF_PROVIDER_IDS].sort());
    for (const id of GIF_PROVIDER_IDS) {
      const { name, searchPlaceholder, poweredBy } = GIF_PROVIDERS[id];
      expect(GIF_PROVIDER_COPY[id], id).toEqual({ name, searchPlaceholder, poweredBy });
    }
  });

  it("the Inbox pane's attribution map is gif-providers.ts's poweredBy, for every provider", () => {
    expect(panePoweredBy()).toEqual(
      Object.fromEntries(GIF_PROVIDER_IDS.map((id) => [id, GIF_PROVIDERS[id].poweredBy])),
    );
  });

  it("the dashboard catalog quotes each provider's poweredBy, and no other attribution", () => {
    const catalog = readFileSync(CATALOG_RS, "utf8");
    const quoted = [...catalog.matchAll(/powered by \w+/gi)].map((m) => m[0]);
    expect([...new Set(quoted)].sort()).toEqual(
      GIF_PROVIDER_IDS.map((id) => GIF_PROVIDERS[id].poweredBy).sort(),
    );
  });

  it("the pane writes no provider attribution outside that map", () => {
    const script = PANE.slice(PANE.indexOf("<script>"));
    const lines = script.split("\n").filter((line) => !line.includes("GIF_POWERED_BY = "));
    for (const id of GIF_PROVIDER_IDS) {
      const { poweredBy, name } = GIF_PROVIDERS[id];
      for (const line of lines.filter((line) => !line.trim().startsWith("//"))) {
        expect(line.toLowerCase(), line).not.toContain(poweredBy.toLowerCase());
        expect(line, line).not.toMatch(new RegExp(`["'][^"']*(via|by) ${name}`, "i"));
      }
    }
  });
});
