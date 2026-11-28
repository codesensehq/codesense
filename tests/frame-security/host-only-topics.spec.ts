// SPDX-License-Identifier: MIT
import { shimSource } from "../support/page-shim";
import { expect, test, type Page } from "../support/quarantine-playwright";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";

// The topics only the host reads, as `HOST_ONLY_TOPICS` in the Rust live hub names them: a page
// never subscribes to, pages, leaves or writes one, even with every verb admitted.
const HUB = "src-tauri/src/live_hub";
const topicConsts = new Map(
  [
    ...readFileSync(resolve(HUB, "groups.rs"), "utf8").matchAll(
      /pub const (\w+): &str = "([^"]+)";/g,
    ),
  ].map((m) => [m[1], m[2]] as const),
);
const listed = /pub const HOST_ONLY_TOPICS: \[&str; \d+\] = \[([^\]]*)\];/.exec(
  readFileSync(resolve(HUB, "projection.rs"), "utf8"),
);
const HOST_ONLY = (listed?.[1] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => topicConsts.get(entry.split("::").pop() ?? "") ?? entry.replace(/^"|"$/g, ""));
if (HOST_ONLY.length === 0) throw new Error("no host-only topics found in HOST_ONLY_TOPICS");
const VERBS = ["subscribe", "page", "unsubscribe", "setUiState"];
type Outcome = { verb: string; topic: string; ok: boolean; error?: string };

let frames: Server;
let vite: ViteDevServer;
let url: string;
let framePort: number;
test.beforeAll(async () => {
  test.setTimeout(60_000);
  const shim = shimSource();
  // The page asks for every verb on every host-only topic, then for `sessions` as a control.
  const calls = [
    ...HOST_ONLY.flatMap((topic) => VERBS.map((verb) => [verb, topic])),
    ["subscribe", "sessions"],
  ];
  frames = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><script>window.__codesenseProxy={token:"topics"};${shim}</script><script>
codesense.ready();
Promise.all(${JSON.stringify(calls)}.map(function(c){
  return codesense.invoke(c[0],{topic:c[1],cursor:"c",patch:{}}).then(
    function(){return {verb:c[0],topic:c[1],ok:true}},
    function(e){return {verb:c[0],topic:c[1],ok:false,error:String(e&&e.message||e)}});
})).then(function(r){window.outcomes=r});
</script>`,
    );
  });
  await new Promise<void>((done) => frames.listen(0, "127.0.0.1", done));
  framePort = (frames.address() as { port: number }).port;
  vite = await createViteServer({
    configFile: false,
    plugins: [tailwindcss()],
    root: process.cwd(),
    server: { port: 0, host: "localhost" },
    resolve: { alias: { "@": resolve("src") } },
    esbuild: { jsx: "automatic" },
    logLevel: "error",
  });
  await vite.listen();
  url = `http://localhost:${(vite.httpServer!.address() as { port: number }).port}/tests/frame-security/fixtures/host-only-topics.html`;
});
test.afterAll(async () => {
  await vite?.close();
  await new Promise<void>((done) => (frames ? frames.close(() => done()) : done()));
});

async function outcomes(page: Page): Promise<Outcome[] | undefined> {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  return frame ? frame.evaluate(() => (window as any).outcomes) : undefined;
}

test("a page is refused every host-only topic and none reaches the live hub", async ({ page }) => {
  test.setTimeout(60_000);
  expect(HOST_ONLY).toEqual(["group", "groups"]);
  await page.addInitScript((port) => {
    (window as any).framePort = port;
  }, framePort);
  await page.goto(url);
  await expect.poll(() => outcomes(page), { timeout: 30_000 }).toBeDefined();
  const results = (await outcomes(page))!;

  const refused = results.filter((r) => HOST_ONLY.includes(r.topic));
  expect(refused).toHaveLength(HOST_ONLY.length * VERBS.length);
  for (const r of refused) {
    expect(r.ok, `${r.verb} ${r.topic}`).toBe(false);
    expect(r.error).toContain(`denied: ${r.verb}: ${r.topic} is a host-only topic`);
  }
  // The control: an ordinary topic still subscribes through the same host.
  expect(results.find((r) => r.topic === "sessions")).toEqual({
    verb: "subscribe",
    topic: "sessions",
    ok: true,
  });

  const calls: [string, any][] = await page.evaluate(() => (window as any).calls);
  const live = calls.filter(([command]) => command.startsWith("live_hub_"));
  expect(live.some(([, args]) => HOST_ONLY.includes(args?.topic))).toBe(false);
  expect(
    live.some(([command, args]) => command === "live_hub_subscribe" && args.topic === "sessions"),
  ).toBe(true);
});
