// SPDX-License-Identifier: MIT
import { expect, test } from "../support/quarantine-playwright";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";

let probe: Server;
let probePort: number;
let probeHits: string[];
let vite: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  test.setTimeout(60_000);
  probe = createServer((req, res) => {
    probeHits.push(req.url ?? "");
    res.setHeader("access-control-allow-origin", "*");
    res.end("probe");
  });
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  probePort = (probe.address() as { port: number }).port;
  vite = await createViteServer({
    configFile: false,
    root: process.cwd(),
    server: { port: 0, host: "localhost" },
    resolve: { alias: { "@": resolve("src") } },
    esbuild: { jsx: "automatic" },
    logLevel: "error",
  });
  await vite.listen();
  url = `http://localhost:${(vite.httpServer!.address() as { port: number }).port}/tests/frame-security/fixtures/rendered-side.html?probe=${probePort}`;
});
test.afterAll(async () => {
  await vite?.close();
  await new Promise<void>((done) => (probe ? probe.close(() => done()) : done()));
});
test.beforeEach(() => {
  probeHits = [];
});

test("a remote diff side renders and runs inline, but makes no request of its own", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // The browser reports a load it then blocks as a request that failed: the
  // side's attempts may show up there, never as one that got an answer.
  const outward = (u: string) => /127\.0\.0\.1|file:|x\.css/.test(u);
  const answered: string[] = [];
  const failed = new Map<string, string>();
  page.on("requestfinished", (r) => outward(r.url()) && answered.push(r.url()));
  page.on(
    "requestfailed",
    (r) => outward(r.url()) && failed.set(r.url(), r.failure()?.errorText ?? ""),
  );
  await page.goto(url);
  const side = page.frameLocator('iframe[title="Remote side"]');
  await expect(side.locator("#marker")).toHaveText("remote side", { timeout: 30_000 });
  // Its own script ran: the sandbox allows scripts, only the network is closed.
  await expect(side.locator("#marker")).toHaveAttribute("data-ran", "yes");
  const frame = page.frames().find((f) => f.url() === "about:srcdoc")!;
  await expect.poll(() => frame.evaluate(() => (window as any).fetched)).toBe("refused");
  // Each attempt was stopped by the side's own policy, not by a missing server.
  await expect
    .poll(() => frame.evaluate(() => (window as any).violations as string[]))
    .toEqual(
      expect.arrayContaining([
        expect.stringContaining(`127.0.0.1:${probePort}/fetch`),
        expect.stringContaining(`127.0.0.1:${probePort}/img`),
        expect.stringContaining("x.css"),
      ]),
    );
  // An opaque origin: the side can't read the app page around it.
  expect(await frame.evaluate(() => origin)).toBe("null");
  expect(
    await frame.evaluate(() => {
      try {
        return parent.document.title;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
  await page.waitForTimeout(500);
  expect(probeHits).toEqual([]);
  expect(answered).toEqual([]);
  for (const [u, reason] of failed) if (!u.startsWith("file:")) expect(reason, u).toBe("csp");
});
