// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { percentile } from "../../scripts/perf-baseline.mjs";

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
 *
 * A second serial `describe` measures two more mock worlds, so a failure there never skips the
 * cases above. `tiles_12` (`?perf=tiles12`, 12 workspaces tiled 4 × 3): the mean frame rate while
 * the window resizes and a divider drags (`fps_12_tiles_resize`) and while the first tile scrolls
 * (`fps_12_tiles_scroll`), after a 1 s idle control, once the tiles have settled, that refuses a page pacing under 30
 * fps; then,
 * on macOS, Playwright WebKit's WebContent memory (`rss_12_tiles_renderer`,
 * `footprint_12_tiles_webcontent`, MiB). `nav_5k` (`?perf=nav5k`, a 5,000-file team): the nav's
 * first paint from the mock's scan answer (`nav_first_paint`) and the p95 of input to the next
 * painted frame while scrolling the fully expanded nav to its end (`nav_scroll`). A failed check
 * throws, so nothing is recorded for that run.
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
type Unit = "ms" | "fps" | "MiB";
/** A recorded sample: the value under the field `scripts/perf-baseline.mjs` reads for its unit. */
type Recorded = { ms?: number; fps?: number; mib?: number; endState: string };
/** Animation frames counted over one timed window. */
type Frames = { frames: number; ms: number; worst: number };
type Ends = "agent" | "team" | "schedule";

declare global {
  interface Window {
    __perf: {
      ends: Record<Ends, (arg: string) => string | null>;
      /** Whether an element is drawn: visible, not inert, with a box. */
      shown: (el: Element | null) => boolean;
      done: Promise<Sample> | null;
      start: { ms: number; endState: string } | null;
      navPaint?: { ms: number; endState: string };
      frames?: { t0: number; stamps: number[]; on: boolean };
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

      window.__perf = { ends: { agent, team, schedule }, shown, done: null, start: null };
      const startFrame = () => {
        // The 5,000-file world's scan stamps its own start (`perf-worlds.ts`); keep it.
        if (window.__perf.start) return;
        const at = performance.now();
        if (shell()) window.__perf.start = { ms: at, endState: "shell" };
        else if (at < cap * 12) requestAnimationFrame(startFrame);
      };
      requestAnimationFrame(startFrame);
      // The nav's first paint: the first frame, after the scan answered, with a file row drawn.
      const navFrame = () => {
        const start = window.__perf.start;
        if (start?.endState === "scan_pipeline_tree") {
          const rows = [
            ...document.querySelectorAll('[role="listitem"][data-filepath*="/file-"]'),
          ].filter(shown);
          if (rows.length) {
            const ms = performance.now() - start.ms;
            window.__perf.navPaint = { ms, endState: `rows:${rows.length}` };
            return;
          }
        }
        if (performance.now() < cap * 12) requestAnimationFrame(navFrame);
      };
      if (new URLSearchParams(location.search).get("perf") === "nav5k") {
        requestAnimationFrame(navFrame);
      }
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

/** An interactive shell has drawn (the start clock stopped). */
const shellReady = (page: Page) =>
  page.waitForFunction(() => !!window.__perf.start, null, { timeout: 60_000 });

/** A fresh context on `url`, once `ready` holds. */
async function freshPage(browser: Browser, url = "/?agents=teams", ready = shellReady) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await installClock(page);
  await page.goto(url);
  await ready(page);
  return { context, page };
}

const results: Record<string, { unit: Unit; samples: Recorded[] }> = {};
/** The sample field `scripts/perf-baseline.mjs` reads for each unit. */
const FIELD = { ms: "ms", fps: "fps", MiB: "mib" } as const;
const record = (key: string, unit: Unit, value: number, endState: string) => {
  results[key] ??= { unit, samples: [] };
  results[key].samples.push({ [FIELD[unit]]: Math.round(value * 10) / 10, endState });
};
const recordMs = (key: string, sample: Sample) => record(key, "ms", sample.ms, sample.endState);

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

let engine = "";

test.beforeAll(({ browserName }) => {
  engine = browserName;
});

// One file for both describes: every key measured in the run.
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

test.describe("perf baseline (measurement)", () => {
  test.skip(!ENABLED, "opt-in: set MEASURE_PERF_BASELINE=1");
  test.describe.configure({ mode: "serial" });

  test("cold_start_mock", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 60_000);
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await freshPage(browser);
      try {
        recordMs("cold_start_mock", (await page.evaluate(() => window.__perf.start))!);
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
        recordMs(
          "open_other_team_agent_cold",
          await timedClick(page, other, "agent", OTHER_SESSION),
        );
        // Warm: back to an agent of the home team, then the other team's agent again.
        await page.locator(agentRow(HOME_TEAM, HOME_AGENT)).scrollIntoViewIfNeeded();
        await page.locator(agentRow(HOME_TEAM, HOME_AGENT)).click();
        await expect(page.getByTestId("identity-menu-team")).toHaveText("default");
        // The label alone isn't enough once agents open without a team switch: wait until no
        // view of the other agent is left on screen.
        await page.waitForFunction((session) => !window.__perf.ends.agent(session), OTHER_SESSION);
        recordMs(
          "open_other_team_agent_warm",
          await timedClick(page, other, "agent", OTHER_SESSION),
        );
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
        recordMs("team_switch", sample);
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
        recordMs(
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

// --- 12 tiles and a 5,000-file nav ------------------------------------------------------------

const TILE_PANELS = '[data-testid^="workspace-panels-"]';
const IDLE_FLOOR_FPS = 30;
const NAV_LIST = '[role="list"]:has([data-filepath])';
const NAV_FILE = (name: string) => `[role="listitem"][data-filepath$="/${name}"]`;
const NAV_WHEEL_PX = 1_000;

/** All 12 tiles are on screen, each with its terminal drawn. */
const tilesReady = (page: Page) =>
  page.waitForFunction(
    (selector) => {
      const { shown } = window.__perf;
      const panels = [...document.querySelectorAll(selector)].filter(shown);
      return panels.length === 12 && panels.every((p) => shown(p.querySelector(".xterm-screen")));
    },
    TILE_PANELS,
    { timeout: 60_000 },
  );

/**
 * Every tile's scrollback has been written and parsed (each scrollbar has a slider, and none has
 * moved for half a second) and the page is quiet (timers fire on time), so a window that opens
 * next samples the page itself and not leftover boot work.
 */
const tilesSettled = (page: Page) =>
  page.evaluate(
    ({ selector, deadline }) =>
      new Promise<void>((resolve, reject) => {
        const start = performance.now();
        let last = "";
        let steady = 0;
        let due = start + 100;
        const poll = () => {
          const now = performance.now();
          const late = now - due;
          due = now + 100;
          const sliders = [...document.querySelectorAll(selector)].map((panel) => {
            const slider = panel.querySelector<HTMLElement>(".scrollbar.vertical .slider");
            return slider && parseFloat(slider.style.height) > 0 ? slider.style.top : "";
          });
          const sig = sliders.join("|");
          const parsed = sliders.length === 12 && sliders.every(Boolean);
          steady = parsed && sig === last && late < 30 ? steady + 1 : 0;
          last = sig;
          if (steady >= 5) return resolve();
          if (now - start > deadline) return reject(new Error("the tiles did not settle in time"));
          setTimeout(poll, 100);
        };
        setTimeout(poll, 100);
      }),
    { selector: TILE_PANELS, deadline: 30_000 },
  );

/** Starts counting animation frames; the window opens now, just before the first input. */
const beginFrames = (page: Page) =>
  page.evaluate(() => {
    const rec = { t0: performance.now(), stamps: [] as number[], on: true };
    window.__perf.frames = rec;
    const frame = () => {
      if (!rec.on) return;
      rec.stamps.push(performance.now());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

/** Closes the window at the next animation frame: frames counted, its length, the worst gap. */
const endFrames = (page: Page): Promise<Frames> =>
  page.evaluate(
    () =>
      new Promise<Frames>((resolve) =>
        requestAnimationFrame(() => {
          const rec = window.__perf.frames!;
          rec.on = false;
          const ms = performance.now() - rec.t0;
          const marks = [rec.t0, ...rec.stamps, rec.t0 + ms];
          const worst = Math.max(...marks.slice(1).map((at, i) => at - marks[i]));
          resolve({ frames: rec.stamps.length, ms, worst });
        }),
      ),
  );

const fpsOf = ({ frames, ms }: Frames) => (frames * 1000) / ms;

/** The first tile's box width and its scrollbar slider's offset (xterm scrolls by the slider). */
const firstTile = (page: Page) =>
  page
    .locator(TILE_PANELS)
    .first()
    .evaluate((panel) => ({
      width: panel.getBoundingClientRect().width,
      slider: (panel.querySelector(".scrollbar.vertical .slider") as HTMLElement | null)?.style.top,
    }));

const MIB = { B: 1 / 1024 ** 2, KB: 1 / 1024, MB: 1, GB: 1024 } as const;

/** The pids and RSS (KiB) of Playwright WebKit's WebContent processes, under its
 *  `ms-playwright/webkit-*` cache. Empty when this isn't macOS. */
function webContentProcesses() {
  if (process.platform !== "darwin") return [];
  return execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .filter((m) => /\/ms-playwright\/webkit-[^/]+\/.*com\.apple\.WebKit\.WebContent/.test(m[3]))
    .map((m) => ({ pid: m[1], rssKiB: Number(m[2]) }));
}

/**
 * The WebContent process of the page just opened: the one WebKit pid that is new since `known`,
 * the pids listed before its browser context opened, with `footprint` read on it. Null when this
 * isn't macOS; no new process, or more than one, is a fault, so another session's page on the
 * same machine is never read as this one.
 */
function webContentMemory(known: Set<string>) {
  if (process.platform !== "darwin") return null;
  const fresh = webContentProcesses().filter((each) => !known.has(each.pid));
  if (fresh.length !== 1) {
    throw new Error(
      `${fresh.length ? "ambiguous" : "no"} WebContent process: ${fresh.length} new since the context opened`,
    );
  }
  const [only] = fresh;
  const text = execFileSync("footprint", [only.pid], { encoding: "utf8" });
  const found = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(text);
  if (!found) throw new Error(`footprint ${only.pid}: no Footprint line`);
  return {
    rssMiB: only.rssKiB / 1024,
    footprintMiB: Number(found[1]) * MIB[found[2] as keyof typeof MIB],
    endState: "playwright-webkit-webcontent mock webcontent:1",
  };
}

test.describe("perf baseline: 12 tiles and a 5,000-file nav (measurement)", () => {
  test.skip(!ENABLED, "opt-in: set MEASURE_PERF_BASELINE=1");
  test.describe.configure({ mode: "serial" });

  test("tiles_12", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 120_000);
    for (let run = 0; run < RUNS; run++) {
      const known = new Set(webContentProcesses().map((each) => each.pid));
      const { context, page } = await freshPage(browser, "/?perf=tiles12", tilesReady);
      try {
        // Guard: the mosaic holds exactly the world's 12 tiles, each terminal drawn.
        await expect(page.locator(TILE_PANELS)).toHaveCount(12);
        await expect(page.locator(`${TILE_PANELS} .xterm-screen`)).toHaveCount(12);

        // Control: a page whose frames don't pace would make any frame rate fiction. It opens
        // once the scrollback is parsed and the page is quiet.
        await tilesSettled(page);
        await beginFrames(page);
        await page.waitForTimeout(1_000);
        const idle = fpsOf(await endFrames(page));
        if (idle < IDLE_FLOOR_FPS) {
          throw new Error(`idle ${idle.toFixed(1)} fps is under ${IDLE_FLOOR_FPS}: not pacing`);
        }

        // Resize: the window steps 1600×950 → 1200×800 and back in 10 steps each, then the
        // divider between the first two columns drags 300 px right over 30 moves.
        const widthBefore = (await firstTile(page)).width;
        // The handle just right of the first tile, in its row.
        const handle = await page
          .locator(TILE_PANELS)
          .first()
          .evaluate((panel) => {
            const tile = panel.getBoundingClientRect();
            const found = [
              ...document.querySelectorAll(
                '[data-slot="resizable-handle"][aria-orientation="vertical"]',
              ),
            ]
              .map((el) => el.getBoundingClientRect())
              .find(
                (box) =>
                  Math.abs(box.x - tile.right) < 4 && box.y < tile.bottom && box.bottom > tile.top,
              );
            return found && { x: found.x + found.width / 2, y: tile.top + tile.height / 2 };
          });
        if (!handle) throw new Error("no divider beside the first tile");
        await beginFrames(page);
        for (let i = 1; i <= 10; i++) {
          await page.setViewportSize({ width: 1600 - 40 * i, height: 950 - 15 * i });
        }
        for (let i = 1; i <= 10; i++) {
          await page.setViewportSize({ width: 1200 + 40 * i, height: 800 + 15 * i });
        }
        const { x, y } = handle;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let i = 1; i <= 30; i++) await page.mouse.move(x + 10 * i, y);
        await page.mouse.up();
        const resize = await endFrames(page);
        const widthAfter = (await firstTile(page)).width;
        if (Math.abs(widthAfter - widthBefore) < 1) {
          throw new Error(`the divider drag left the first tile at ${widthBefore}px`);
        }

        // Scroll: 40 wheel steps of 120 px up the first tile's scrollback.
        const screen = (await page.locator(`${TILE_PANELS} .xterm-screen`).first().boundingBox())!;
        await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
        const sliderBefore = (await firstTile(page)).slider;
        await beginFrames(page);
        for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -120);
        const scroll = await endFrames(page);
        const sliderAfter = (await firstTile(page)).slider;
        if (!sliderBefore || sliderAfter === sliderBefore) {
          throw new Error(
            `the first tile did not scroll (slider ${sliderBefore} -> ${sliderAfter})`,
          );
        }

        const ends = (f: Frames) =>
          `frames:${f.frames} worst:${f.worst.toFixed(1)}ms idle:${idle.toFixed(1)}`;
        // Read before recording, so a memory fault records nothing for this run.
        const memory = webContentMemory(known);
        record("fps_12_tiles_resize", "fps", fpsOf(resize), ends(resize));
        record("fps_12_tiles_scroll", "fps", fpsOf(scroll), ends(scroll));
        if (memory) {
          record("rss_12_tiles_renderer", "MiB", memory.rssMiB, memory.endState);
          record("footprint_12_tiles_webcontent", "MiB", memory.footprintMiB, memory.endState);
        } else if (run === 0) {
          test.info().annotations.push({
            type: "skip",
            description: `memory: WebContent is read on macOS only, not ${process.platform}`,
          });
        }
      } finally {
        await context.close();
      }
    }
  });

  test("nav_5k", async ({ browser }) => {
    test.setTimeout(30_000 + RUNS * 180_000);
    const navReady = (page: Page) =>
      page.waitForFunction(() => !!window.__perf.navPaint, null, { timeout: 60_000 });
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await freshPage(browser, "/?perf=nav5k", navReady);
      try {
        const paint = (await page.evaluate(() => window.__perf.navPaint))!;

        // Open every folder, so scrolling to the end crosses all 5,000 file rows.
        const opened = await page.evaluate(async (list) => {
          const nav = document.querySelector<HTMLElement>(list)!;
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const { shown } = window.__perf;
          nav.scrollTop = 0;
          let clicks = 0;
          for (let guard = 0; guard < 2_000; guard++) {
            await frame();
            const closed = [
              ...nav.querySelectorAll('button.cs-nav-row[aria-expanded="false"]'),
            ].find(shown);
            if (closed) {
              (closed as HTMLElement).click();
              clicks++;
              continue;
            }
            if (nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 1) {
              nav.scrollTop = 0;
              await frame();
              await frame();
              return clicks;
            }
            nav.scrollTop += nav.clientHeight;
          }
          throw new Error("the nav's folders kept opening");
        }, NAV_LIST);
        await expect(page.locator(NAV_FILE("file-00000.md"))).toBeVisible();

        // Scroll to the end: each wheel step's input to the next frame that shows it moved.
        const list = page.locator(NAV_LIST);
        const area = (await list.boundingBox())!;
        await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        const steps: number[] = [];
        for (let guard = 0; guard < 1_000; guard++) {
          const atEnd = await list.evaluate((nav) => {
            if (nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 1) return true;
            const before = nav.scrollTop;
            window.__perf.done = new Promise((resolve, reject) => {
              const onWheel = () => {
                window.removeEventListener("wheel", onWheel, true);
                const start = performance.now();
                const frame = () => {
                  const ms = performance.now() - start;
                  if (nav.scrollTop !== before) return resolve({ ms, endState: "moved" });
                  if (ms > 5_000) return reject(new Error("the nav did not scroll in 5 s"));
                  requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
              };
              window.addEventListener("wheel", onWheel, true);
            });
            return false;
          });
          if (atEnd) break;
          await page.mouse.wheel(0, NAV_WHEEL_PX);
          steps.push((await page.evaluate(() => window.__perf.done!)).ms);
        }
        await expect(page.locator(NAV_FILE("file-04999.md"))).toBeVisible();
        if (!steps.length) throw new Error("the nav was already at its end");
        const p95 = percentile(steps, 0.95);

        record("nav_first_paint", "ms", paint.ms, paint.endState);
        record("nav_scroll", "ms", p95, `steps:${steps.length} opened:${opened}`);
      } finally {
        await context.close();
      }
    }
  });
});
