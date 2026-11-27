// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Frontend perf baselines: open another team's agent (cold and warm), switch team, open a tab
 * and start the app, timed in the browser against a production build of the mock backend
 * (`?agents=teams` world, two open teams in two orgs). Frontend only: the mock answers every
 * host call in-process.
 *
 * Opt-in, never a CI gate. Without `MEASURE_PERF_BASELINE=1` every case skips and nothing is
 * written. Measure a production build on WebKit, the engine the app ships:
 *   npx vite build --mode mock
 *   npx vite preview --mode mock --port 5320
 *   MEASURE_PERF_BASELINE=1 MEASURE_RUNS=5 BASE_URL=http://localhost:5320 \
 *   PERF_BASELINE_OUT=test-results/perf-baseline-current.json \
 *   npx playwright test -c playwright.mock.config.ts --project=webkit --workers=1 \
 *     tests/e2e-mock/perf-baseline.spec.ts
 * then `node scripts/perf-baseline.mjs compare|record --current <that file> --runner <name>`.
 * `MEASURE_RUNS` (default 5, at least 3) is the samples per key; each sample is a fresh browser
 * context. Only `MEASURE_PERF_BASELINE=1` turns it on (`=0` or any other value skips).
 * `PERF_BASELINE_OUT` (default `test-results/perf-baseline-current.json`) gets every key
 * measured in the run, with each sample's ms and the end state it stopped on.
 *
 * The clock is the page's own `performance.now()`, started by the click (a capture-phase
 * listener, so before the app handles it) and read once per animation frame until the end
 * check holds. A click on an agent in the left bar ends at the first frame where exactly one
 * `END_STATES` row matches that agent: none within 5 s fails "no end state matched", two fail
 * "ambiguous", and one that already holds before the click fails the sample rather than timing a
 * frame. A change that moves where that click lands adds its row here, in the same change.
 */

const ENABLED = process.env.MEASURE_PERF_BASELINE === "1";
const MIN_RUNS = 3;

/** `MEASURE_RUNS` as a whole number of at least 3; anything else stops the run before it starts. */
function runs() {
  const text = process.env.MEASURE_RUNS ?? "5";
  if (!/^\d+$/.test(text) || Number(text) < MIN_RUNS) {
    throw new Error(`MEASURE_RUNS must be a whole number of at least ${MIN_RUNS}, not "${text}"`);
  }
  return Number(text);
}
const RUNS = ENABLED ? runs() : 0;
const OUT = process.env.PERF_BASELINE_OUT ?? "test-results/perf-baseline-current.json";
const END_CAP_MS = 5_000;
const VIEWPORT = { width: 1600, height: 950 };

const OTHER_TEAM = "abacus/labs:riverside";
const OTHER_AGENT = "SV-3#lead";
const OTHER_SESSION = "sess-sv-lead";
const HOME_TEAM = "acme/widgets:default";
const HOME_AGENT = "BUG-142#lead";
const agentRow = (team: string, handle: string) =>
  `[data-row-key='agent:${JSON.stringify([team, handle])}']`;

type Sample = { ms: number; endState: string };
type Ends = "agent" | "team" | "schedule";

declare global {
  interface Window {
    __perf: {
      ends: Record<Ends, (arg: string) => string | null>;
      done: Promise<Sample> | null;
      start: { ms: number; endState: string } | null;
    };
  }
}

/**
 * Installed before the app loads: the end checks, and the start clock (from navigation start to
 * the first frame of an interactive shell).
 */
function installClock(page: Page) {
  return page.addInitScript(
    ({ cap }) => {
      const shown = (el: Element | null): el is HTMLElement => {
        if (!el || !(el as HTMLElement).checkVisibility?.({ visibilityProperty: true })) {
          return false;
        }
        if (el.closest("[inert]")) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      // Whether `root` has painted any `selector` match (a message, a terminal screen).
      const drawn = (root: Element, selector: string) =>
        [...root.querySelectorAll(selector)].some(shown);
      /**
       * Where a click on an agent in the left bar lands. Each row says when its view of
       * `session` has drawn its first usable frame; exactly one may match.
       */
      const END_STATES: { name: string; ready: (session: string) => boolean }[] = [
        {
          // Today: the agent's team becomes the active one and its tab shows. The lead opens on
          // its terminal (the drawn xterm screen), or on its chat (newest message drawn and an
          // enabled composer).
          name: "team-switch",
          ready: (session) => {
            const tab = document.querySelector(`[data-testid="terminal-tab-${session}"]`);
            if (!shown(tab) || tab.getAttribute("aria-selected") !== "true") return false;
            const term = document.querySelector(`[data-terminal-session-id="${session}"]`);
            if (shown(term) && shown(term.querySelector(".xterm-screen"))) return true;
            const chat = document.querySelector(
              `[data-testid="chat-overlay"][data-session-id="${session}"]`,
            );
            const input = chat?.querySelector<HTMLTextAreaElement>(
              '[data-testid="ibx-composer"] textarea',
            );
            return shown(chat) && !!input && !input.disabled && drawn(chat, "[data-mid]");
          },
        },
        {
          // The agent opens in an overlay over the current team: its transcript drawn (a message
          // painted) and its send box enabled.
          name: "agent-overlay",
          ready: (session) => {
            const overlay = document.querySelector(
              `[data-testid="agent-overlay"][data-session-id="${session}"]`,
            );
            const input = overlay?.querySelector<HTMLTextAreaElement>(
              '[data-testid="ibx-composer"] textarea',
            );
            return shown(overlay) && !!input && !input.disabled && drawn(overlay, "[data-mid]");
          },
        },
        {
          // The agent's tile is focused in the tiled workspace and has drawn its content: a
          // painted message or a painted terminal screen, never an empty tile.
          name: "tile",
          ready: (session) => {
            const tile = document.querySelector(
              `[data-session-id="${session}"][data-focused="true"]`,
            );
            return shown(tile) && drawn(tile, "[data-mid], .xterm-screen");
          },
        },
      ];
      const agent = (session: string) => {
        const matched = END_STATES.filter((row) => row.ready(session)).map((row) => row.name);
        if (matched.length > 1) throw new Error(`ambiguous: ${matched.join(", ")}`);
        return matched[0] ?? null;
      };
      // The team view after a switch: the named team is active and its tab's terminal is drawn.
      const team = (name: string) => {
        const label = document.querySelector('[data-testid="identity-menu-team"]');
        if (label?.textContent?.trim() !== name) return null;
        const tabs = document.querySelectorAll(
          '[role="tab"][aria-selected="true"][data-testid^="terminal-tab-"]',
        );
        const anyDrawn = [...tabs].some((tab) => {
          const session = tab.getAttribute("data-testid")!.slice("terminal-tab-".length);
          const term = document.querySelector(`[data-terminal-session-id="${session}"]`);
          return shown(tab) && shown(term) && shown(term.querySelector(".xterm-screen"));
        });
        return anyDrawn ? "team-view" : null;
      };
      // A live tab: the routines schedule, with its first row painted.
      const schedule = () =>
        shown(document.querySelector('[data-testid="schedule-view"] [data-testid="schedule-row"]'))
          ? "schedule-row"
          : null;
      // An interactive shell: the identity menu, an agent row and a drawn terminal.
      const shell = () =>
        shown(document.querySelector('[data-testid="identity-menu-trigger"]')) &&
        shown(document.querySelector(".ag-row:not(.ag-ghost)")) &&
        [...document.querySelectorAll("[data-terminal-session-id] .xterm-screen")].some(shown)
          ? "shell"
          : null;

      window.__perf = { ends: { agent, team, schedule }, done: null, start: null };
      const startFrame = () => {
        const at = performance.now();
        if (shell()) window.__perf.start = { ms: at, endState: "shell" };
        else if (at < cap * 12) requestAnimationFrame(startFrame);
      };
      requestAnimationFrame(startFrame);
    },
    { cap: END_CAP_MS },
  );
}

/**
 * Times one click on `trigger`, until `ends(arg)` names the end state it stopped on. A sample whose
 * end state already holds when the click lands is refused: it would time about one frame.
 */
async function timedClick(page: Page, trigger: string, ends: Ends, arg: string): Promise<Sample> {
  await page.locator(trigger).scrollIntoViewIfNeeded();
  await page.evaluate(
    ({ trigger, ends, arg, cap }) => {
      window.__perf.done = null;
      const onClick = (event: Event) => {
        if (!(event.target as Element | null)?.closest(trigger)) return;
        document.removeEventListener("click", onClick, true);
        const refuse = (err: unknown) => {
          window.__perf.done = Promise.reject(err);
          window.__perf.done.catch(() => {});
        };
        let before: string | null;
        try {
          before = window.__perf.ends[ends](arg);
        } catch (err) {
          return refuse(err);
        }
        if (before) return refuse(new Error(`end state ${before} already shown before the click`));
        const start = performance.now();
        window.__perf.done = new Promise((resolve, reject) => {
          const frame = () => {
            const ms = performance.now() - start;
            let endState: string | null;
            try {
              endState = window.__perf.ends[ends](arg);
            } catch (err) {
              return reject(err);
            }
            if (endState) return resolve({ ms, endState });
            if (ms > cap) return reject(new Error(`no end state matched in ${cap / 1000} s`));
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      };
      document.addEventListener("click", onClick, true);
    },
    { trigger, ends, arg, cap: END_CAP_MS },
  );
  await page.locator(trigger).click();
  return page.evaluate(() => {
    if (!window.__perf.done) throw new Error("the click was not seen");
    return window.__perf.done;
  });
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await installClock(page);
  await page.goto("/?agents=teams");
  await page.waitForFunction(() => !!window.__perf.start, null, { timeout: 60_000 });
  return { context, page };
}

const results: Record<string, { unit: "ms"; samples: Sample[] }> = {};
const record = (key: string, sample: Sample) => {
  results[key] ??= { unit: "ms", samples: [] };
  results[key].samples.push({ ms: Math.round(sample.ms * 10) / 10, endState: sample.endState });
};

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

test.describe("perf baseline (measurement)", () => {
  test.skip(!ENABLED, "opt-in: set MEASURE_PERF_BASELINE=1");
  test.describe.configure({ mode: "serial" });
  let engine = "";

  test.beforeAll(({ browserName }) => {
    engine = browserName;
  });

  test.afterAll(() => {
    if (!Object.keys(results).length) return;
    const file = {
      engine,
      runs: RUNS,
      commit: commit(),
      date: new Date().toISOString().slice(0, 10),
      throttle: "none",
      keys: results,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`perf-baseline wrote ${OUT}: ${Object.keys(results).join(", ")}`);
  });

  test("cold_start_mock", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 60_000);
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await freshPage(browser);
      try {
        record("cold_start_mock", (await page.evaluate(() => window.__perf.start))!);
      } finally {
        await context.close();
      }
    }
  });

  test("open_other_team_agent", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 60_000);
    const other = agentRow(OTHER_TEAM, OTHER_AGENT);
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await freshPage(browser);
      try {
        // Cold: the first click after load mounts the other team's view.
        record("open_other_team_agent_cold", await timedClick(page, other, "agent", OTHER_SESSION));
        // Warm: back to an agent of the home team, then the other team's agent again.
        await page.locator(agentRow(HOME_TEAM, HOME_AGENT)).scrollIntoViewIfNeeded();
        await page.locator(agentRow(HOME_TEAM, HOME_AGENT)).click();
        await expect(page.getByTestId("identity-menu-team")).toHaveText("default");
        // The label alone isn't enough once agents open without a team switch: wait until no
        // view of the other agent is left on screen.
        await page.waitForFunction((session) => !window.__perf.ends.agent(session), OTHER_SESSION);
        record("open_other_team_agent_warm", await timedClick(page, other, "agent", OTHER_SESSION));
      } finally {
        await context.close();
      }
    }
  });

  test("team_switch", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 60_000);
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await freshPage(browser);
      try {
        // The other team is the only team of the other org: its org row switches to it.
        await page.getByTestId("identity-menu-trigger").click();
        const sample = await timedClick(
          page,
          `[data-testid="org-switcher-row-${OTHER_TEAM.split(":")[0]}"]`,
          "team",
          OTHER_TEAM.split(":")[1]!,
        );
        record("team_switch", sample);
      } finally {
        await context.close();
      }
    }
  });

  test("tab_open", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 60_000);
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await freshPage(browser);
      try {
        await page.getByTestId("identity-menu-trigger").click();
        record(
          "tab_open",
          await timedClick(page, '[data-testid="identity-menu-routines"]', "schedule", ""),
        );
      } finally {
        await context.close();
      }
    }
  });

  // Last, so a failure here never skips a measured case.
  test("a click whose end state already shows is refused, not timed", async ({ browser }) => {
    const { context, page } = await freshPage(browser);
    try {
      const other = agentRow(OTHER_TEAM, OTHER_AGENT);
      await timedClick(page, other, "agent", OTHER_SESSION);
      await expect(timedClick(page, other, "agent", OTHER_SESSION)).rejects.toThrow(
        "end state team-switch already shown before the click",
      );
    } finally {
      await context.close();
    }
  });
});
