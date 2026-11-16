// SPDX-License-Identifier: MIT
import { expect, test, type Page } from "@playwright/test";

/**
 * Open time of an agent's chat overlay, measured in the browser against the frontend mock
 * backend (`?agents=team` world). This times the frontend only: the mock answers every host
 * call in-process, so the real app's host reads are not part of these numbers.
 *
 * Opt-in, never a CI gate: `MEASURE_OVERLAY_OPEN=1 npm run test:e2e:mock -- chat-overlay-open-time`.
 * That run uses the mock config's dev server: unbundled modules and React's development build,
 * which read pessimistic, most of all under the 4x throttle. For the numbers an open-time bar is
 * judged on, measure a production build of the mock instead:
 *   npx vite build --mode mock
 *   npx vite preview --mode mock --port 5320
 *   BASE_URL=http://localhost:5320 MEASURE_OVERLAY_OPEN=1 npm run test:e2e:mock -- chat-overlay-open-time
 * (with `BASE_URL` set, the config starts no server of its own).
 * `MEASURE_RUNS` (default 10) sets the runs per CPU rate. Each run is a fresh page load: its
 * first open is the cold one, and a second open after closing it is the warm one. Runs repeat
 * at 1x and with the CPU throttled 4x (Chromium's `Emulation.setCPUThrottlingRate`, from
 * before the page loads).
 *
 * The clock is the page's own `performance.now()`, started by the opening click (a capture-phase
 * listener, so before the app handles it) and read once per animation frame:
 *  - `ready`: the first frame where the newest message is drawn and the composer's text box is
 *    enabled;
 *  - `inView`: the first frame where, as well, the newest message lies inside the message list's
 *    view (the open-time bar's "newest message visible"). Watched for `IN_VIEW_CAP_MS` times the
 *    CPU rate; a run where it never happens records null and the gap (px) still left below the
 *    list's edge.
 * Results (each sample, median and p90 in ms) go to the console and to the test's attachments.
 */

const AGENT_TAB = "sess-login-lead";
const MESSAGES = 120;
const NEWEST = `acme/widgets#${MESSAGES}`;
const RUNS = Number(process.env.MEASURE_RUNS ?? 10);
const IN_VIEW_CAP_MS = 3_000;

type Sample = { ready: number; inView: number | null; gap: number };

declare global {
  interface Window {
    __openTime: { done: Promise<Sample> | null };
  }
}

/** A conversation the mock backend doesn't have: `MESSAGES` messages, the newest last. */
async function seedConversation(page: Page) {
  await page.addInitScript(
    ({ count }) => {
      const now = Date.now();
      const make = (handle: string) => ({
        handle,
        roles: [],
        messages: Array.from({ length: count }, (_, i) => {
          const id = i + 1;
          const mine = id % 3 === 0;
          return {
            id,
            team: { org: "acme", team: "widgets" },
            from: mine ? "human" : handle,
            fromName: mine ? "You" : "lead",
            to: mine ? handle : "human",
            toName: mine ? "lead" : "You",
            toRole: null,
            text: `line ${id}: ${"lorem ipsum dolor sit amet ".repeat((id % 4) * 3 + 1)}`,
            contentType: "markdown",
            createdAtMs: now - (count - id) * 60_000,
            inReplyTo: null,
            via: null,
            replyTo: null,
            summary: null,
            unread: false,
            delivery: null,
          };
        }),
      });
      type Internals = { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
      let inner: Internals | undefined;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => inner,
        set: (v: Internals) => {
          const orig = v.invoke.bind(v);
          v.invoke = (cmd, args) =>
            cmd === "list_session_inbox"
              ? Promise.resolve(make(String(args?.handle ?? "x")))
              : orig(cmd, args);
          inner = v;
        },
      });
    },
    { count: MESSAGES },
  );
}

/** Arms the clock: the next click on `trigger` starts it; frames are read until `inView` or the cap. */
async function arm(page: Page, trigger: string, newest: string, cap: number) {
  await page.evaluate(
    ({ trigger, newest, cap }) => {
      // null: not drawn or composer not enabled yet; otherwise how far (px) the newest message's
      // bottom still sits below the list's visible edge (0 when it is in view).
      const look = () => {
        const chat = document.querySelector('[data-testid="chat-overlay"]');
        const list = chat?.querySelector<HTMLElement>('[data-testid="ibx-msgs"]');
        const last = list?.querySelector<HTMLElement>(`[data-mid="${newest}"]`);
        const input = chat?.querySelector<HTMLTextAreaElement>(
          '[data-testid="ibx-composer"] textarea',
        );
        if (!list || !last || !input || input.disabled) return null;
        const box = list.getBoundingClientRect();
        const row = last.getBoundingClientRect();
        if (row.height <= 0) return null;
        return row.top >= box.top - 1 ? Math.max(0, Math.round(row.bottom - box.bottom - 1)) : 1e6;
      };
      window.__openTime = { done: null };
      const onClick = (event: Event) => {
        const target = event.target as Element | null;
        if (!target?.closest(trigger)) return;
        document.removeEventListener("click", onClick, true);
        const start = performance.now();
        let ready: number | null = null;
        window.__openTime.done = new Promise((resolve) => {
          const frame = () => {
            const at = performance.now() - start;
            const gap = look();
            if (gap !== null && ready === null) ready = at;
            if (gap === 0) return resolve({ ready: ready!, inView: at, gap: 0 });
            if (at > cap && ready !== null) return resolve({ ready, inView: null, gap: gap! });
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      };
      document.addEventListener("click", onClick, true);
    },
    { trigger, newest, cap },
  );
}

async function timedOpen(page: Page, rate: number): Promise<Sample> {
  const trigger = `[data-testid="terminal-grid-caption-inbox-${AGENT_TAB}"]`;
  await arm(page, trigger, NEWEST, IN_VIEW_CAP_MS * rate);
  await page.locator(trigger).click({ timeout: 15_000 * rate });
  return page.evaluate((limit) => {
    const done = window.__openTime.done;
    if (!done) throw new Error("the opening click was not seen");
    return Promise.race([
      done,
      new Promise<Sample>((_, no) =>
        setTimeout(() => no(new Error(`not ready in ${limit / 1000} s`)), limit),
      ),
    ]);
  }, 15_000 * rate);
}

async function closeOverlay(page: Page, wait: number) {
  await page.locator(`[data-testid="terminal-grid-caption-inbox-${AGENT_TAB}"]`).click({
    timeout: wait,
  });
  await expect(page.locator('[data-testid="chat-overlay"]')).toHaveCount(0, { timeout: wait });
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? { median: Math.round(quantile(sorted, 0.5)), p90: Math.round(quantile(sorted, 0.9)) }
    : { median: null, p90: null };
};
const summary = (samples: Sample[]) => {
  const inView = samples.flatMap((s) => (s.inView === null ? [] : [s.inView]));
  return {
    ready: stats(samples.map((s) => s.ready)),
    inView: { ...stats(inView), reached: `${inView.length}/${samples.length}` },
    gapsWhenNotInView: samples.filter((s) => s.inView === null).map((s) => s.gap),
    samples: samples.map((s) => ({
      ready: Math.round(s.ready),
      inView: s.inView === null ? null : Math.round(s.inView),
      gap: s.gap,
    })),
  };
};

test.describe("chat overlay open time (measurement)", () => {
  test.skip(!process.env.MEASURE_OVERLAY_OPEN, "opt-in: set MEASURE_OVERLAY_OPEN=1");

  for (const rate of [1, 4]) {
    test(`cold and warm open at ${rate}x CPU`, async ({ browser, browserName }, testInfo) => {
      test.skip(browserName !== "chromium", "CPU throttling is a Chromium DevTools feature");
      test.setTimeout(60_000 + RUNS * 30_000 * rate);
      const cold: Sample[] = [];
      const warm: Sample[] = [];
      for (let run = 0; run < RUNS; run++) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
        const page = await context.newPage();
        try {
          if (rate !== 1) {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate });
          }
          await seedConversation(page);
          // A throttled CPU boots the dev server's unbundled modules that much slower.
          const wait = 15_000 * rate;
          await page.goto("/?agents=team", { timeout: 60_000 * rate });
          await page.getByRole("button", { name: "Full screen" }).click({ timeout: wait });
          await expect(page.getByTestId(`terminal-grid-caption-inbox-${AGENT_TAB}`)).toBeVisible({
            timeout: wait,
          });
          cold.push(await timedOpen(page, rate));
          await closeOverlay(page, wait);
          warm.push(await timedOpen(page, rate));
        } finally {
          await context.close();
        }
      }
      const result = { rate, runs: RUNS, cold: summary(cold), warm: summary(warm) };
      console.log(`overlay-open-time ${JSON.stringify(result)}`);
      await testInfo.attach(`overlay-open-time-${rate}x.json`, {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
    });
  }
});
