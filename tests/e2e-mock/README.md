# Mock browser specs

The specs here run the frontend against its in-browser mock backend
(`playwright.mock.config.ts`), which serves the app with `vite --mode mock`.

## Tile specs

New specs go in `tests/e2e-mock/tiles/`. Two projects run them, one per engine:
`tiles-webkit` (Desktop Safari) and `tiles-chromium` (Desktop Chrome). The older
`chromium` and `webkit` projects leave `tiles/` alone. Only `*.spec.ts` files are
specs, so helpers and fixture pages can sit beside them in `tiles/fixtures/`.

```bash
pnpm exec playwright install chromium webkit
pnpm exec playwright test -c playwright.mock.config.ts --project=tiles-webkit --project=tiles-chromium
```

### Gate tags

Every tile spec carries exactly one gate tag in its title, and runs on both
engines:

| Tag        | Where it runs                                     | What it blocks                      |
| ---------- | ------------------------------------------------- | ----------------------------------- |
| `@p0`      | the **Tile specs** check on every pull request    | the merge                           |
| `@p1`      | **Tile specs** (report only) and the release gate | a release, below 95%                |
| `@nightly` | the nightly run, on WebKit                        | nothing; a red night opens an issue |

```ts
test("a reload keeps the stored count @p0", async ({ page }) => {
  /* ... */
});
```

The **Tile specs** job checks the full list of both projects first, with
`scripts/tile-tags.mjs`: a spec with no gate tag, two of them, or listed for only
one engine fails it.

### The probe dashboard

`tiles/fixtures/probe-dashboard.html` is a pane that counts its own loads, so a
spec can tell a frame that stayed put from one that reloaded or remounted. Each
pane frame gets its own origin, so the probe's `sessionStorage` count survives a
reload but starts again on a remount; the host page counts every load as well.

```ts
import { mountProbe } from "./fixtures/probe";

const probe = await mountProbe(page); // the live-hub harness, the probe in a right-pane slot
await probe.reload();
expect(await probe.counts()).toMatchObject({ inFrame: 1, stored: 2 });
expect(await probe.hostLoads()).toBe(2);
```

`counts()` also returns every message the probe received, other than its own
count requests. Each mount gets its own pane id: the dev server tells every open
page about each pane write, so a shared id would let a parallel test refresh it.

## Specs outside tiles/

The specs already outside `tiles/` stay where they are. The **Node scripts**
check (`scripts/stray-specs.mjs`) fails on a new one that is in neither the
**Mock layout specs** job's hand list (its `Run the mock layout specs` step in
`.github/workflows/tests.yml`) nor `stray-allowlist.txt`. The allowlist may only
shrink: moving a spec into `tiles/` or deleting it, remove its line too.

## The release gate

`.github/workflows/tiles-release.yml` runs the `@p1` tile specs on both engines
when dispatched for a release candidate (Actions → Tile release gate → Run
workflow). It fails when fewer than 95% of the specs passed (a skipped spec
counts as not passed) or when none ran, and lists each failure and skip in the
job summary.

## The nightly run

`.github/workflows/nightly.yml` runs on a schedule and on dispatch, each lane a
job on `macos-15`:

- **Nightly tile specs**: the `@nightly` tile specs on WebKit. With none yet, the
  summary says so.
- **Pane harness (WebKit)**:
  `pnpm exec playwright test -c playwright.pane-harness.config.ts --project=webkit`.
- **Perf baseline**: `perf-baseline.spec.ts` against a production build of the
  mock, then `scripts/perf-baseline.mjs` against the `runner: macos-15` set of
  `tests/fixtures/perf-baseline.json`, never a set measured on another machine.
  Until the spec, the script or that set exists, the lane passes and writes
  `perf lane skipped: <reason>` to its summary.
- **Tile load tests**: the ignored Rust tests named `tiles_load_*`, and no other
  ignored test.

When a scheduled run on `main` fails, **Track the nightly** opens one issue
labelled `nightly`, or comments on it (reopening it if closed) on each later red
night. A dispatched run never writes an issue.

### Recording a perf set

Dispatch the nightly with **record** ticked to measure on `macos-15` and upload
the result instead of comparing. The `perf-baseline` artifact holds
`tests/fixtures/perf-baseline.json` with the new set; commit it in a pull request.

The perf lane runs the harness, then the tool:

```bash
MEASURE_PERF_BASELINE=1 MEASURE_RUNS=5 BASE_URL=http://localhost:5320 \
  PERF_BASELINE_OUT=test-results/perf-baseline-current.json \
  pnpm exec playwright test -c playwright.mock.config.ts --project=webkit --workers=1 \
  tests/e2e-mock/perf-baseline.spec.ts
node scripts/perf-baseline.mjs compare --current test-results/perf-baseline-current.json --runner macos-15
```

`record` in place of `compare` writes the set. The tool exits 0 on a pass (or
with no set for the runner), 1 on a regression and 2 on bad input.
