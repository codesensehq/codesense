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
  await page.goto(`${url}&case=probes`);
  const side = page.frameLocator('iframe[title="Remote side"]');
  await expect(side.locator("#marker")).toHaveText("remote side", { timeout: 30_000 });
  // Its own script ran: the sandbox allows scripts, only the network is closed.
  await expect(side.locator("#marker")).toHaveAttribute("data-ran", "yes");
  await expect(side.locator("#written")).toHaveText("written");
  // Once parsed, the document can't be reopened: that would erase the side's unload report.
  const reopened = await page
    .frames()
    .find((f) => f.url() === "about:srcdoc")!
    .evaluate(() =>
      ["open", "write", "writeln"].map((name) => {
        try {
          (document as any)[name]("<p>x</p>");
          return "allowed";
        } catch (e) {
          return (e as DOMException).name;
        }
      }),
    );
  expect(reopened).toEqual(["SecurityError", "SecurityError", "SecurityError"]);
  const frame = page.frames().find((f) => f.url() === "about:srcdoc")!;
  await expect.poll(() => frame.evaluate(() => (window as any).fetched)).toBe("refused");
  await expect.poll(() => frame.evaluate(() => (window as any).socket)).toBe("refused");
  // A blob worker is a script the policy doesn't list: it never starts, or starts unable to fetch.
  expect(await frame.evaluate(() => (window as any).worker)).toMatch(/refused|started/);
  // Each attempt was stopped by the side's own policy, not by a missing server.
  await expect
    .poll(() => frame.evaluate(() => (window as any).violations as string[]))
    .toEqual(
      expect.arrayContaining([
        expect.stringContaining(`127.0.0.1:${probePort}/fetch`),
        expect.stringContaining(`127.0.0.1:${probePort}/img`),
        expect.stringContaining("x.css"),
        expect.stringContaining(`127.0.0.1:${probePort}/ws`),
      ]),
    );
  // A nested frame and an object report only their origin when blocked; a blob worker, "blob".
  const violations = (await frame.evaluate(() => (window as any).violations)) as string[];
  expect(violations.filter((v) => v === `http://127.0.0.1:${probePort}`).length).toBe(2);
  if ((await frame.evaluate(() => (window as any).worker)) === "started")
    expect(violations).toContain("blob");
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

// The CSP can't stop a side navigating itself: that one GET is the residual channel, and
// the side is torn down on the load it causes, before the page it reached can do more.
for (const [name, path] of [
  ["location.href", "/nav-href"],
  ["a meta refresh", "/nav-refresh"],
  ["a link click", "/nav-click"],
  ["document.open() and then location.href", "/nav-reopen"],
  ["another realm's document.open() and then location.href", "/nav-realm"],
] as const) {
  test(`a side that navigates itself by ${name} sends at most one request and is closed`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto(`${url}&case=${path.slice(5)}`);
    await expect(page.getByTestId("side-frame-left")).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('iframe[title="Remote side"]').count()).toBe(0);
    await page.waitForTimeout(500);
    expect(probeHits.length).toBeLessThanOrEqual(1);
    for (const hit of probeHits) expect(hit).toBe(path);
    // "Show again" draws the side's own content afresh (and it navigates once more).
    probeHits = [];
    await page.getByRole("button", { name: "Show again" }).click();
    await expect(page.getByTestId("side-frame-left")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(probeHits.length).toBeLessThanOrEqual(1);
  });
}
