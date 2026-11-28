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
- **Frame media specs (WebKit)**: the four `native audio|video loads …` specs
  in `tests/frame-security/hostile.spec.ts`, on macOS WebKit. See below.

### Frame security specs on Linux WebKit

The pull request job **Frame security specs** runs on `ubuntu-24.04`, and its
guard reporter fails a run that skipped any spec. One skip is let through:
Playwright's Linux WebKit build doesn't have Safari's media codecs (Playwright's
[browser docs](https://playwright.dev/docs/browsers#webkit) recommend WebKit on
macOS for media playback), and its native audio and video loads end with status
0 there. So the four native media specs skip on Linux WebKit under the reason
`LINUX_WEBKIT_MEDIA_SKIP` in
`tests/frame-security/support/fixture-guard.mjs`. The guard accepts that skip
only on Linux, only on WebKit, only for those four titles and only with that
exact reason. Any other skip, including a quarantined hostile spec, still fails
the run. The nightly's **Frame media specs (WebKit)** job runs the four on
`macos-15` every night, so they are still proven each night.

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

`record` in place of `compare` writes the set. Exit codes are listed under
"Measuring the perf baselines".

### Measuring the perf baselines

`perf-baseline.spec.ts` is opt-in and never a gate. It runs only with
`MEASURE_PERF_BASELINE=1`; `0` or any other value skips every case and writes
nothing. Measure a production build on WebKit (`--project=webkit --workers=1`).
Build and serve it with `npx vite build --mode mock` and
`npx vite preview --mode mock --port 5320`, and point `BASE_URL` at the preview
(`http://localhost:5320`). Without `BASE_URL` the config starts `dev:mock`, and a
dev build must not be recorded as a set.

- `MEASURE_RUNS`: samples per key, a whole number of at least 3 (default 5). Any
  other value stops the run before it starts.
- `PERF_BASELINE_OUT`: where the measured file goes (default
  `test-results/perf-baseline-current.json`). It holds every key measured in the
  run, with each sample's time and the end state it stopped on.

`END_STATES` in the spec is a list of rows, not a setting. Each row says when a
click on an agent in the left bar has drawn its first usable frame. Exactly one
row must match; none within 5 s or two at once fails the sample. To add an end
state, add a row to `END_STATES` in the spec; the change that adds the agent
overlay or the tiles adds its row in the same commit.

Then compare the file with a runner's recorded set, or record it as that set:

```bash
node scripts/perf-baseline.mjs compare --current <file> --runner <name>
node scripts/perf-baseline.mjs record  --current <file> --runner <name>
```

Both take an optional `--baseline <file>` (default
`tests/fixtures/perf-baseline.json`); `record` rewrites that file in place.

Exit codes: 0 when every compared key passes or the runner has no set (the tool
prints `perf lane skipped: no <runner> rows`), 1 on a regression, 2 on bad input
(a bad file, a missing key, fewer than 3 samples, an engine mismatch, a bad
argument) or any unexpected error.

The open-time budget, opening another team's agent within 200 ms p95 of the
click, is the `budget` block of `tests/fixtures/perf-baseline.json`: on its
runner (`m1`), `compare` fails a budget key whose current p95 is over it with
exit 1, and `record` prints the same `FAIL` lines without failing.

`record` replaces only that runner's set. Keys listed in `M1_ONLY_KEYS`
(`scripts/perf-baseline.mjs`) belong to the `m1` set alone: CI never writes
them, and `record` drops them for any other runner.
