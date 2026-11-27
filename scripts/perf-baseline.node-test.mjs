// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compare,
  formatBaseline,
  percentile,
  run,
  spread,
  summarize,
  upsertSet,
} from "./perf-baseline.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO, "tests/fixtures/perf-baseline.json");

// --- maths -----------------------------------------------------------------------------------

test("percentiles use the nearest rank: p50 of 5 is the 3rd value, p95 the max, p5 the min", () => {
  const five = [50, 10, 40, 20, 30];
  assert.equal(percentile(five, 0.5), 30);
  assert.equal(percentile(five, 0.95), 50);
  assert.equal(percentile(five, 0.05), 10);
  // Unsorted input is sorted first and not changed in place.
  assert.deepEqual(five, [50, 10, 40, 20, 30]);
  // An even count takes the lower middle value.
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([7], 0.95), 7);
  assert.throws(() => percentile([], 0.5), /no samples/);
});

test("summarize gives p50 and p95 for a time key, p50 and p5 for an fps key", () => {
  assert.deepEqual(summarize({ unit: "ms", samples: [12, 10, 14, 11, 13] }), {
    unit: "ms",
    p50: 12,
    p95: 14,
  });
  assert.deepEqual(summarize({ unit: "fps", samples: [58, 60, 55, 59, 57] }), {
    unit: "fps",
    p50: 58,
    p5: 55,
  });
});

test("spread is (max - min) / median, with the absolute range beside it", () => {
  assert.deepEqual(spread([100, 95, 105, 98, 102]), { ratio: 0.1, range: 10 });
});

// --- fixtures --------------------------------------------------------------------------------

const ms = (samples, endState = "team-switch") => ({
  unit: "ms",
  samples: samples.map((value) => ({ ms: value, endState })),
});

/** A measured file as the spec writes it. */
function current(keys, overrides = {}) {
  return {
    engine: "webkit",
    runs: 5,
    commit: "abc1234",
    date: "2026-11-27",
    throttle: "none",
    keys,
    ...overrides,
  };
}

const setKey = (p50, p95 = p50, extra = {}) => ({
  unit: "ms",
  p50,
  p95,
  samples: [p50, p50, p50, p50, p95],
  endState: "team-switch",
  ...extra,
});

function baseline({ keys = ["open_cold"], sets } = {}) {
  return {
    compare: { keys, tolerancePercent: 20, floor: { ms: 17, fps: 3 } },
    sets: sets ?? [
      {
        runner: "m1",
        engine: "webkit",
        runs: 5,
        commit: "m1sha00",
        date: "2026-11-27",
        throttle: "none",
        keys: { open_cold: setKey(100), team_switch: setKey(80) },
      },
      {
        runner: "macos-15",
        engine: "webkit",
        runs: 5,
        commit: "cisha00",
        date: "2026-11-27",
        throttle: "none",
        keys: { open_cold: setKey(300) },
      },
    ],
  };
}

// --- compare (test plan cases 1-11) ----------------------------------------------------------

test("case 1: medians at p50 pass", () => {
  const out = compare(baseline(), current({ open_cold: ms([300, 300, 300, 300, 300]) }), {
    runner: "macos-15",
  });
  assert.equal(out.exitCode, 0);
  assert.match(out.lines[0], /^PASS open_cold 300ms \(p50 300, limit 360, \+0%, team-switch\)$/);
  assert.equal(out.verdict, "perf compare macos-15: PASS 1/1 (tol 20%, 5 runs)");
});

test("case 2: a regression over tolerance and floor fails and names the key", () => {
  const out = compare(baseline(), current({ open_cold: ms([400, 410, 411, 420, 430]) }), {
    runner: "macos-15",
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.lines[0], /^FAIL open_cold 411ms \(p50 300, limit 360, \+37%, team-switch\)$/);
  assert.equal(out.verdict, "perf compare macos-15: FAIL 1/1: open_cold +37%");
});

test("case 3: the floor keeps a small absolute change green", () => {
  const small = baseline({
    sets: [{ ...baseline().sets[1], keys: { open_cold: setKey(40) } }],
  });
  // +25% but only +10 ms, under the 17 ms floor.
  assert.equal(
    compare(small, current({ open_cold: ms([50, 50, 50, 50, 50]) }), { runner: "macos-15" })
      .exitCode,
    0,
  );
  // +25% of 300 ms is 75 ms, over both.
  assert.equal(
    compare(baseline(), current({ open_cold: ms([375, 375, 375, 375, 375]) }), {
      runner: "macos-15",
    }).exitCode,
    1,
  );
});

test("case 4: exactly at the limit passes (the test is strict)", () => {
  const out = compare(baseline(), current({ open_cold: ms([360, 360, 360, 360, 360]) }), {
    runner: "macos-15",
  });
  assert.equal(out.exitCode, 0);
});

test("case 5: an fps key fails on a drop past tolerance and floor, and passes when it rises", () => {
  const fpsBase = baseline({
    keys: ["fps_tiles"],
    sets: [
      {
        ...baseline().sets[1],
        keys: { fps_tiles: { unit: "fps", p50: 60, p5: 55, samples: [60], endState: "tile" } },
      },
    ],
  });
  const fps = (values) => ({
    unit: "fps",
    samples: values.map((value) => ({ fps: value, endState: "tile" })),
  });
  const low = compare(fpsBase, current({ fps_tiles: fps([40, 40, 40, 40, 40]) }), {
    runner: "macos-15",
  });
  assert.equal(low.exitCode, 1);
  assert.match(low.lines[0], /^FAIL fps_tiles 40fps \(p50 60, limit 48, -33%, tile\)$/);
  const high = compare(fpsBase, current({ fps_tiles: fps([90, 90, 90, 90, 90]) }), {
    runner: "macos-15",
  });
  assert.equal(high.exitCode, 0);
});

test("case 6: an improvement on a time key passes", () => {
  const out = compare(baseline(), current({ open_cold: ms([90, 90, 90, 90, 90]) }), {
    runner: "macos-15",
  });
  assert.equal(out.exitCode, 0);
  assert.match(out.lines[0], /-70%/);
});

test("a key whose end state moved shows the set's and the current one", () => {
  const out = compare(
    baseline(),
    current({ open_cold: ms([90, 90, 90, 90, 90], "agent-overlay") }),
    { runner: "macos-15" },
  );
  assert.equal(out.exitCode, 0);
  assert.match(
    out.lines[0],
    /^PASS open_cold 90ms \(p50 300, limit 360, -70%, team-switch -> agent-overlay\)$/,
  );
  assert.equal(out.rows[0].endState, "team-switch -> agent-overlay");
});

test("case 7: a runner with no set skips with exit 0 and never falls back to another set", () => {
  const onlyM1 = baseline({ sets: [baseline().sets[0]] });
  const out = compare(onlyM1, current({ open_cold: ms([999, 999, 999, 999, 999]) }), {
    runner: "macos-15",
  });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.lines, ["perf lane skipped: no macos-15 rows"]);
});

test("case 8: a compared key missing from the set or from the current file is an input error", () => {
  const noKeyInSet = baseline({ keys: ["open_cold", "tab_open"] });
  assert.throws(
    () => compare(noKeyInSet, current({ open_cold: ms([300, 300, 300]) }), { runner: "macos-15" }),
    (err) => err.exitCode === 2 && /tab_open/.test(err.message),
  );
  assert.throws(
    () => compare(baseline(), current({}), { runner: "macos-15" }),
    (err) => err.exitCode === 2 && /open_cold/.test(err.message),
  );
});

test("case 9: too few samples or another engine is an input error", () => {
  assert.throws(
    () => compare(baseline(), current({ open_cold: ms([300, 300]) }), { runner: "macos-15" }),
    (err) => err.exitCode === 2 && /fewer than 3 samples/.test(err.message),
  );
  assert.throws(
    () =>
      compare(baseline(), current({ open_cold: ms([300, 300, 300]) }, { engine: "chromium" }), {
        runner: "macos-15",
      }),
    (err) => err.exitCode === 2 && /engine/.test(err.message),
  );
});

test("case 9: a bad shape in either file is an input error, never a silent pass", () => {
  const textP50 = baseline();
  textP50.sets[1].keys.open_cold.p50 = "300";
  assert.throws(
    () => compare(textP50, current({ open_cold: ms([999, 999, 999]) }), { runner: "macos-15" }),
    (err) => err.exitCode === 2 && /p50/.test(err.message),
  );
  const nullSet = baseline({ sets: [null, baseline().sets[1]] });
  assert.throws(
    () => compare(nullSet, current({ open_cold: ms([300, 300, 300]) }), { runner: "macos-15" }),
    (err) => err.exitCode === 2 && /runner/.test(err.message),
  );
  assert.throws(
    () =>
      compare(baseline(), current({ open_cold: { unit: "ms", samples: { ms: 300 } } }), {
        runner: "macos-15",
      }),
    (err) => err.exitCode === 2 && /not a list/.test(err.message),
  );
});

// --- CLI -------------------------------------------------------------------------------------

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-baseline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  return { dir, write };
}

function capture() {
  const out = [];
  const err = [];
  return {
    io: { log: (line) => out.push(line), error: (line) => err.push(line), env: {} },
    out,
    err,
  };
}

test("case 9: a malformed or missing file exits 2", (t) => {
  const { write, dir } = tmp(t);
  const bad = write("bad.json", "{not json");
  const base = write("base.json", baseline());
  const c = capture();
  assert.equal(
    run(["compare", "--current", bad, "--runner", "macos-15", "--baseline", base], c.io),
    2,
  );
  assert.equal(
    run(
      [
        "compare",
        "--current",
        path.join(dir, "missing.json"),
        "--runner",
        "macos-15",
        "--baseline",
        base,
      ],
      c.io,
    ),
    2,
  );
  assert.equal(run(["compare", "--runner", "macos-15", "--baseline", base], c.io), 2);
});

test("case 9: an unexpected error exits 2, not 1", (t) => {
  const { write, dir } = tmp(t);
  const base = write("base.json", baseline());
  const cur = write("cur.json", current({ open_cold: ms([300, 300, 300, 300, 300]) }));
  const c = capture();
  // A directory as the step summary makes the append throw a plain (non-input) error.
  c.io.env.GITHUB_STEP_SUMMARY = dir;
  assert.equal(
    run(["compare", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io),
    2,
  );
  assert.match(c.err.join("\n"), /^perf-baseline: unexpected: /);
});

test("case 10: tolerance and floor come only from the file; an override flag is refused", (t) => {
  const { write } = tmp(t);
  const base = write("base.json", baseline());
  const cur = write("cur.json", current({ open_cold: ms([300, 300, 300, 300, 300]) }));
  const c = capture();
  const args = ["compare", "--current", cur, "--runner", "macos-15", "--baseline", base];
  assert.equal(run([...args, "--tolerance", "90"], c.io), 2);
  assert.match(c.err.join("\n"), /unknown option --tolerance/);
  assert.equal(run(args, c.io), 0);
});

test("case 11: with GITHUB_STEP_SUMMARY set, compare appends a verdict line and a table", (t) => {
  const { write, dir } = tmp(t);
  const base = write("base.json", baseline());
  const cur = write("cur.json", current({ open_cold: ms([400, 410, 411, 420, 430]) }));
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(summary, "earlier step\n");
  const c = capture();
  c.io.env.GITHUB_STEP_SUMMARY = summary;
  const code = run(["compare", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io);
  assert.equal(code, 1);
  assert.deepEqual(c.out, [
    "FAIL open_cold 411ms (p50 300, limit 360, +37%, team-switch)",
    "perf compare macos-15: FAIL 1/1: open_cold +37%",
  ]);
  const text = fs.readFileSync(summary, "utf8");
  assert.ok(text.startsWith("earlier step\nperf compare macos-15: FAIL 1/1: open_cold +37%\n"));
  assert.match(
    text,
    /\| open_cold \| FAIL \| 411 ms \| 300 ms \| 360 ms \| \+37% \| team-switch \|/,
  );
  // Unset: stdout only, nothing written anywhere.
  const quiet = capture();
  run(["compare", "--current", cur, "--runner", "macos-15", "--baseline", base], quiet.io);
  assert.equal(fs.readFileSync(summary, "utf8"), text);
});

// --- record ----------------------------------------------------------------------------------

test("upsertSet appends a new runner, replaces it on a second record and leaves others alone", () => {
  const before = baseline({ sets: [baseline().sets[0]] });
  const m1Text = JSON.stringify(before.sets[0]);
  const measured = current({ open_cold: ms([310, 290, 300, 305, 295]) }, { commit: "cisha01" });
  const once = upsertSet(before, measured, "macos-15");
  assert.equal(once.sets.length, 2);
  assert.equal(JSON.stringify(once.sets[0]), m1Text);
  assert.deepEqual(once.sets[1], {
    runner: "macos-15",
    engine: "webkit",
    runs: 5,
    commit: "cisha01",
    date: "2026-11-27",
    throttle: "none",
    keys: {
      open_cold: {
        unit: "ms",
        p50: 300,
        p95: 310,
        samples: [310, 290, 300, 305, 295],
        endState: "team-switch",
      },
    },
  });
  const twice = upsertSet(once, current({ open_cold: ms([1, 2, 3]) }), "macos-15");
  assert.equal(twice.sets.length, 2);
  assert.equal(twice.sets[1].keys.open_cold.p50, 2);
  assert.equal(JSON.stringify(twice.sets[0]), m1Text);
  // The input is never changed in place.
  assert.equal(before.sets.length, 1);
});

test("upsertSet keeps the extra fields a hand-measured key carries in that runner's set", () => {
  const before = baseline({ sets: [baseline().sets[0]] });
  const release = setKey(900, 950, { build: "release", sha: "relsha0" });
  before.sets[0].keys.cold_start_release = release;
  const after = upsertSet(before, current({ open_cold: ms([90, 100, 110]) }), "m1");
  assert.deepEqual(after.sets[0].keys.cold_start_release, release);
  assert.equal(after.sets[0].keys.open_cold.p50, 100);
});

test("only the m1 set records team_switch: another runner drops it, even from its previous set", () => {
  const measured = current({
    open_cold: ms([310, 290, 300]),
    team_switch: ms([400, 410, 420], "team-view"),
  });
  const before = baseline();
  before.sets[1].keys.team_switch = setKey(500);
  const ci = upsertSet(before, measured, "macos-15");
  assert.deepEqual(Object.keys(ci.sets[1].keys), ["open_cold"]);
  const m1 = upsertSet(baseline(), measured, "m1");
  assert.equal(m1.sets[0].keys.team_switch.p50, 410);
  assert.equal(m1.sets[0].keys.team_switch.endState, "team-view");
});

test("record on another runner says it dropped team_switch", (t) => {
  const { write } = tmp(t);
  const base = write("base.json", formatBaseline(baseline({ sets: [baseline().sets[0]] })));
  const cur = write(
    "cur.json",
    current({ open_cold: ms([310, 290, 300, 305, 295]), team_switch: ms([400, 410, 420]) }),
  );
  const c = capture();
  assert.equal(
    run(["record", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io),
    0,
  );
  assert.deepEqual(c.out, [
    "recorded macos-15: 1 keys, 5 runs, commit abc1234",
    "dropped team_switch: only the m1 set records it",
    "spread open_cold 7% (20 ms): can be compared",
  ]);
  assert.equal(JSON.parse(fs.readFileSync(base, "utf8")).sets[1].keys.team_switch, undefined);
});

test("record on another runner names each key it carries over unmeasured; m1 keeps its own quietly", (t) => {
  const { write } = tmp(t);
  const start = baseline();
  start.sets[1].keys.renamed_key = setKey(50);
  const base = write("base.json", formatBaseline(start));
  const cur = write("cur.json", current({ open_cold: ms([310, 290, 300, 305, 295]) }));
  const c = capture();
  assert.equal(
    run(["record", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io),
    0,
  );
  assert.deepEqual(c.out, [
    "recorded macos-15: 1 keys, 5 runs, commit abc1234",
    "carried renamed_key: not measured, kept from the commit cisha00 set",
    "spread open_cold 7% (20 ms): can be compared",
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(base, "utf8")).sets[1].keys.renamed_key, setKey(50));
  const m1 = capture();
  assert.equal(run(["record", "--current", cur, "--runner", "m1", "--baseline", base], m1.io), 0);
  assert.ok(!m1.out.some((line) => line.startsWith("carried")), m1.out.join("\n"));
});

test("record writes the file, leaves the M1 set byte-identical and reports each key's spread", (t) => {
  const { write } = tmp(t);
  const startText = formatBaseline(baseline({ sets: [baseline().sets[0]] }));
  const base = write("base.json", startText);
  const m1Block = startText.slice(startText.indexOf('{\n      "runner": "m1"'));
  const m1Text = m1Block.slice(0, m1Block.indexOf("\n    }") + 6);
  const cur = write("cur.json", current({ open_cold: ms([310, 290, 300, 305, 295]) }));
  const c = capture();
  assert.equal(
    run(["record", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io),
    0,
  );
  const after = fs.readFileSync(base, "utf8");
  assert.ok(after.includes(m1Text), "the M1 set's bytes are unchanged");
  assert.equal(JSON.parse(after).sets[1].runner, "macos-15");
  assert.deepEqual(c.out, [
    "recorded macos-15: 1 keys, 5 runs, commit abc1234",
    "spread open_cold 7% (20 ms): can be compared",
  ]);
});

test("record refuses a measured file with an input error and leaves the baseline alone", (t) => {
  const { write } = tmp(t);
  const startText = formatBaseline(baseline());
  const base = write("base.json", startText);
  const cur = write("cur.json", current({ open_cold: ms([300]) }));
  const c = capture();
  assert.equal(
    run(["record", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io),
    2,
  );
  assert.equal(fs.readFileSync(base, "utf8"), startText);
});

test("record refuses a baseline without its compare block, from the CLI and from upsertSet", (t) => {
  const { write } = tmp(t);
  const startText = JSON.stringify({ sets: [] });
  const base = write("base.json", startText);
  const cur = write("cur.json", current({ open_cold: ms([300, 300, 300]) }));
  const c = capture();
  assert.equal(
    run(["record", "--current", cur, "--runner", "macos-15", "--baseline", base], c.io),
    2,
  );
  assert.equal(fs.readFileSync(base, "utf8"), startText);
  assert.throws(
    () => upsertSet({ sets: [] }, current({ open_cold: ms([300, 300, 300]) }), "macos-15"),
    (err) => err.exitCode === 2 && /compare/.test(err.message),
  );
});

// --- the committed file (task 1.2, case 12) --------------------------------------------------

const M1_KEYS = [
  "open_other_team_agent_cold",
  "open_other_team_agent_warm",
  "team_switch",
  "tab_open",
  "cold_start_mock",
];

test("the committed baseline has the M1 set, the compare block and no targets", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  assert.equal(formatBaseline(JSON.parse(text)), text, "the file is in the script's own format");
  const file = JSON.parse(text);
  assert.equal(file.targets, undefined);
  assert.deepEqual(Object.keys(file.compare).sort(), ["floor", "keys", "tolerancePercent"]);
  assert.equal(file.compare.tolerancePercent, 20);
  assert.equal(file.compare.floor.ms, 17);
  assert.ok(!file.compare.keys.includes("team_switch"), "team_switch is never compared");
  const m1 = file.sets.find((set) => set.runner === "m1");
  assert.ok(m1, "an m1 set");
  for (const set of file.sets) {
    assert.equal(set.engine, "webkit");
    assert.equal(set.throttle, "none");
    assert.ok(set.runs >= 3, `${set.runner} runs`);
    assert.match(set.commit, /^[0-9a-f]{7,40}$/, `${set.runner} commit`);
    assert.match(set.date, /^\d{4}-\d{2}-\d{2}$/, `${set.runner} date`);
    for (const key of file.compare.keys) assert.ok(set.keys[key], `${set.runner} has ${key}`);
    for (const [key, entry] of Object.entries(set.keys)) {
      assert.equal(entry.unit, "ms", key);
      assert.equal(typeof entry.p50, "number", key);
      assert.equal(typeof entry.p95, "number", key);
      assert.ok(entry.samples.length >= 1, key);
    }
  }
  for (const key of M1_KEYS) assert.ok(m1.keys[key], `m1 has ${key}`);
  const ci = file.sets.find((set) => set.runner === "macos-15");
  if (ci) assert.ok(!ci.keys.team_switch, "CI never records team_switch");
});

test("case 12: the committed M1 numbers pass compare against themselves", (t) => {
  const file = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const m1 = file.sets.find((set) => set.runner === "m1");
  const keys = Object.fromEntries(
    file.compare.keys.map((key) => [
      key,
      {
        unit: "ms",
        samples: m1.keys[key].samples.map((value) => ({
          ms: value,
          endState: m1.keys[key].endState,
        })),
      },
    ]),
  );
  const { write } = tmp(t);
  const cur = write("cur.json", current(keys, { runs: m1.runs }));
  const c = capture();
  assert.equal(
    run(["compare", "--current", cur, "--runner", "m1", "--baseline", FIXTURE], c.io),
    0,
  );
});
