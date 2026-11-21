// SPDX-License-Identifier: MIT
// node --test scripts/exports-guard.node-test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FILES_CAP,
  GUARD_MESSAGE,
  REFRESH_BRANCH,
  REFRESH_LABEL,
  REGENERATE_WORKFLOW,
  SEALED_EXPORT,
  artifactProblems,
  chooseRun,
  frozenChanges,
  githubRequest,
  isRefreshPr,
  listFiles,
  newestRun,
  parseFrozenList,
  parseQueueRef,
  refreshBranchProblems,
  runGuard,
  trustedRun,
} from "./exports-guard.mjs";
import { FROZEN_EXPORTS } from "./lib/sealed-export.mjs";

const REPO = "codesensehq/codesense";
const FROZEN = FROZEN_EXPORTS[0];
const sealedSource = readFileSync(
  fileURLToPath(new URL("lib/sealed-export.mjs", import.meta.url)),
  "utf8",
);
const sha = (c) => c.repeat(40);

test("the public message tells contributors to leave the exports out", () => {
  assert.equal(GUARD_MESSAGE, "Leave generated exports out of your PR; maintainers refresh them.");
});

test("the matcher finds frozen paths on either side of a rename, for every status", () => {
  for (const status of ["added", "modified", "removed", "changed", "copied"])
    assert.deepEqual(frozenChanges([{ filename: FROZEN, status }]), [FROZEN], status);
  assert.deepEqual(
    frozenChanges([{ filename: "elsewhere.json", previous_filename: FROZEN, status: "renamed" }]),
    [FROZEN],
  );
  assert.deepEqual(
    frozenChanges([{ filename: FROZEN, previous_filename: "old.json", status: "renamed" }]),
    [FROZEN],
  );
  assert.deepEqual(frozenChanges([{ filename: FROZEN }, { filename: FROZEN }]), [FROZEN]);
});

test("the matcher passes Node-rendered outputs and near misses", () => {
  const generated = "codesense-docs/getting-started/content/generated";
  for (const filename of [
    `${generated}/mcp-tools.json`,
    `${generated}/schemas/agent-yaml.schema.json`,
    `${generated}/live-data-contract.json.bak`,
    `x/${FROZEN}`,
    FROZEN.toUpperCase(),
    "src-tauri/src/docs_schemas.rs",
    SEALED_EXPORT,
  ])
    assert.deepEqual(frozenChanges([{ filename, status: "modified" }]), [], filename);
});

test("the base list is the base's FROZEN_EXPORTS, and the head parse reads it the same way", () => {
  assert.deepEqual(
    frozenChanges(FROZEN_EXPORTS.map((filename) => ({ filename }))),
    [...FROZEN_EXPORTS].sort(),
  );
  assert.deepEqual(parseFrozenList(sealedSource), [...FROZEN_EXPORTS]);
});

test("the head parse reads a changed list, and refuses anything it cannot read statically", () => {
  const added = sealedSource.replace(
    '  "src-tauri/src/docs_schemas.generated.json",\n',
    '  "src-tauri/src/docs_schemas.generated.json",\n  "src-tauri/extra.json",\n',
  );
  assert.deepEqual(parseFrozenList(added), [...FROZEN_EXPORTS, "src-tauri/extra.json"]);
  const dropped = sealedSource.replace('  "src-tauri/src/docs_schemas.generated.json",\n', "");
  assert.deepEqual(parseFrozenList(dropped), FROZEN_EXPORTS.slice(0, -1));
  const moved = sealedSource.replace(
    'const GENERATED = "codesense-docs/getting-started/content/generated";',
    'const GENERATED = "elsewhere";',
  );
  // GENERATED lives outside the entries block, so moving it is a change of the rest: refused.
  assert.equal(parseFrozenList(moved), null);
  assert.equal(parseFrozenList(moved, moved)[0], "elsewhere/live-data-contract.json");
  for (const [name, source] of [
    ["not text", undefined],
    ["empty", ""],
    ["computed entry", sealedSource.replace("`${GENERATED}/mcp-tools.inputs.json`", "path()")],
    ["spread", sealedSource.replace("`${GENERATED}/mcp-tools.inputs.json`", "...more")],
    ["comment", sealedSource.replace("  `${GENERATED}/mcp-tools.inputs.json`,", "  // gone")],
    ["escape", sealedSource.replace("docs_schemas.generated.json", "docs\\u005fschemas.json")],
    ["other expression", sealedSource.replace("`${GENERATED}/mcp", "`${OTHER}/mcp")],
    ["let", sealedSource.replace("const GENERATED =", "let GENERATED =")],
    ["reassigned", `${sealedSource}\nGENERATED = "x";\n`],
    ["second list", `${sealedSource}\nexport const FROZEN_EXPORTS = Object.freeze([\n]);\n`],
    ["not frozen", sealedSource.replace("FROZEN_EXPORTS = Object.freeze([", "FROZEN_EXPORTS = ([")],
    ["empty list", sealedSource.replace(/Object\.freeze\(\[\n[^\]]*\]\)/, "Object.freeze([\n])")],
  ])
    assert.equal(parseFrozenList(source), null, name);
});

test("the head parse fails closed on a decoy declaration", () => {
  const real = /^export const FROZEN_EXPORTS = Object\.freeze\(\[\n[^\]]*\]\);$/m.exec(
    sealedSource,
  )[0];
  const decoys = [
    // The real declaration commented out, and the list exported another way.
    [
      "block comment",
      sealedSource.replace(
        real,
        `/*\n${real}\n*/\nexport const { FROZEN_EXPORTS: _x } = { FROZEN_EXPORTS: [] };`,
      ),
    ],
    [
      "block comment, counts kept",
      sealedSource.replace(real, `/*\n${real}\n*/`).replace("FROZEN_EXPORTS.filter", "[].filter"),
    ],
    ["unclosed block comment", sealedSource.replace(real, `/*\n${real}`)],
    // The real declaration inside a template literal, the list defined elsewhere.
    [
      "template literal",
      sealedSource.replace(
        real,
        `const decoy = \`\n${real}\n\`;\nexport const FROZEN_EXPORTS = Object.freeze([]);`,
      ),
    ],
    [
      "template literal, counts kept",
      sealedSource
        .replace(real, `const decoy = \`\n${real}\n\`;`)
        .replace("FROZEN_EXPORTS.filter", "[].filter"),
    ],
    // Object.freeze reassigned, so the declaration's runtime value is another list.
    ["reassigned freeze", `Object.freeze = () => [];\n${sealedSource}`],
    ["reassigned freeze by key", `Object["freeze"] = () => [];\n${sealedSource}`],
    [
      "defineProperty on freeze",
      `Object.defineProperty(Object, "freeze", { value: () => [] });\n${sealedSource}`,
    ],
    // Another use of a counted token.
    ["extra GENERATED", `${sealedSource}\nexport const OTHER = GENERATED;\n`],
    ["extra FROZEN_EXPORTS", `${sealedSource}\nexport const OTHER = FROZEN_EXPORTS;\n`],
    // r2's repros: a computed key, and a template decoy closed by an indented backtick with the real
    // export renamed in and the token counts rebalanced. Each parsed to six entries while the runtime
    // list was empty.
    ["computed freeze key", `Object["fr" + "eeze"] = () => [];\n${sealedSource}`],
    [
      "indented template close, export renamed",
      sealedSource
        .replace(
          real,
          `const decoy = \`\n${real}\n  \`;\nconst y = [];\nexport { y as FROZEN_EXPORTS };`,
        )
        .replace("FROZEN_EXPORTS.filter", "[].filter"),
    ],
    // Any edit outside the entries block, however harmless it looks.
    ["a note", `${sealedSource}\n// another note\n`],
    ["whitespace", sealedSource.replace("\n\n", "\n\n\n")],
    ["one byte", sealedSource.replace("Shared by", "Shared  by")],
    // The block itself must stay the one declaration.
    ["no block", sealedSource.replace(real, "export const FROZEN_EXPORTS = [];")],
    ["two blocks", `${sealedSource}\n${real}\n`],
  ];
  for (const [name, source] of decoys) assert.equal(parseFrozenList(source), null, name);
  // The rest is compared with the base's, byte for byte: a head equal to its base outside the block
  // reads, whatever else that base holds, and a base without one block reads nothing.
  const note = `${sealedSource}\n// another note\n`;
  assert.deepEqual(parseFrozenList(note, note), [...FROZEN_EXPORTS]);
  assert.equal(parseFrozenList(sealedSource, "no block here"), null);
  assert.equal(parseFrozenList(sealedSource, null), null);
});

const refreshPr = (overrides = {}) => ({
  number: 7,
  head: { ref: REFRESH_BRANCH, sha: sha("a"), repo: { full_name: REPO } },
  base: { repo: { full_name: REPO } },
  labels: [{ name: "other" }, { name: REFRESH_LABEL }],
  changed_files: 1,
  ...overrides,
});

test("the refresh pull request is the labelled same-repository branch, never the label alone", () => {
  assert.equal(isRefreshPr(refreshPr(), REPO), true);
  const head = refreshPr().head;
  for (const [name, pr] of [
    ["no label", refreshPr({ labels: [{ name: "other" }] })],
    ["no labels", refreshPr({ labels: undefined })],
    ["another branch", refreshPr({ head: { ...head, ref: "feat/x" } })],
    ["a prefixed branch", refreshPr({ head: { ...head, ref: `x/${REFRESH_BRANCH}` } })],
    ["a fork", refreshPr({ head: { ...head, repo: { full_name: "someone/codesense" } } })],
    ["a deleted fork", refreshPr({ head: { ...head, repo: null } })],
    ["another base", refreshPr({ base: { repo: { full_name: "someone/codesense" } } })],
  ])
    assert.equal(isRefreshPr(pr, REPO), false, name);
  assert.equal(isRefreshPr(refreshPr(), "someone/codesense"), false);
});

test("the queue ref parser reads the refs/heads/ and bare forms, and nothing else", () => {
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/main/pr-386-${sha("b")}`), 386);
  assert.equal(parseQueueRef(`gh-readonly-queue/main/pr-12-${sha("c")}`), 12);
  for (const ref of [
    undefined,
    "",
    "refs/heads/main",
    `refs/heads/gh-readonly-queue/release/pr-1-${sha("b")}`,
    `refs/heads/gh-readonly-queue/main/pr--${sha("b")}`,
    `refs/heads/gh-readonly-queue/main/pr-0-${sha("b")}`,
    `refs/heads/gh-readonly-queue/main/pr-01-${sha("b")}`,
    `refs/heads/gh-readonly-queue/main/pr-1-${sha("b").slice(1)}`,
    `refs/heads/gh-readonly-queue/main/pr-1-${sha("B")}`,
    `refs/heads/gh-readonly-queue/main/pr-1-${sha("b")}/x`,
    `refs/tags/gh-readonly-queue/main/pr-1-${sha("b")}`,
    `xrefs/heads/gh-readonly-queue/main/pr-1-${sha("b")}`,
  ])
    assert.equal(parseQueueRef(ref), null, String(ref));
});

const files = (count, filename = (i) => `src/file-${i}.ts`) =>
  Array.from({ length: count }, (_, i) => ({ filename: filename(i), status: "modified" }));
// A fake GitHub API: each path maps to its JSON, or to an Error it throws; anything else throws.
const fakeApi = (routes, calls = []) => {
  return async (path) => {
    calls.push(path);
    if (!Object.hasOwn(routes, path)) throw new Error(`HTTP 404 ${path}`);
    const value = routes[path];
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
};
const pages = (number, list) => {
  const routes = {};
  for (let page = 1; ; page++) {
    routes[`repos/${REPO}/pulls/${number}/files?per_page=100&page=${page}`] = list.slice(
      (page - 1) * 100,
      page * 100,
    );
    if (list.length < page * 100) return routes;
  }
};

test("the file list reads every page, and fails closed on an error, the cap or a mismatch", async () => {
  const list = files(250);
  const calls = [];
  assert.deepEqual(await listFiles(fakeApi(pages(3, list), calls), REPO, 3, 250), list);
  assert.equal(calls.length, 3);
  // A full last page needs one more, empty, page.
  assert.equal((await listFiles(fakeApi(pages(3, files(200))), REPO, 3, 200)).length, 200);
  const broken = { ...pages(3, list) };
  broken[`repos/${REPO}/pulls/3/files?per_page=100&page=2`] = new Error("HTTP 502");
  await assert.rejects(listFiles(fakeApi(broken), REPO, 3, 250), /HTTP 502/);
  broken[`repos/${REPO}/pulls/3/files?per_page=100&page=2`] = { message: "not a list" };
  await assert.rejects(listFiles(fakeApi(broken), REPO, 3, 250), /not a list/);
  await assert.rejects(listFiles(fakeApi(pages(3, list)), REPO, 3, 251), /reports 251/);
  await assert.rejects(
    listFiles(fakeApi(pages(3, files(FILES_CAP))), REPO, 3, FILES_CAP),
    /3000 or more files/,
  );
  await assert.rejects(
    listFiles(fakeApi(pages(3, files(FILES_CAP - 1))), REPO, 3, FILES_CAP),
    /reports 3000/,
  );
});

// One pull request, as the API returns it, with its files; and the events that name it.
const scenario = ({
  pr = refreshPr(),
  list = [{ filename: FROZEN, status: "modified" }],
} = {}) => ({
  [`repos/${REPO}/pulls/${pr.number}`]: { ...pr, changed_files: list.length },
  ...pages(pr.number, list),
});
const pullRequestEvent = (pr = refreshPr()) => ({
  eventName: "pull_request",
  payload: { pull_request: { number: pr.number, head: { sha: pr.head.sha } } },
});
const GROUP = sha("d");
const mergeGroupEvent = (number = 7, parent = sha("a")) => ({
  eventName: "merge_group",
  payload: {
    merge_group: {
      head_ref: `refs/heads/gh-readonly-queue/main/pr-${number}-${sha("e")}`,
      head_sha: GROUP,
      base_sha: sha("e"),
    },
  },
  group: { [`repos/${REPO}/commits/${GROUP}`]: { parents: [{ sha: sha("e") }, { sha: parent }] } },
});
const guard = (event, routes) =>
  runGuard({ ...event, repository: REPO, request: fakeApi({ ...routes, ...event.group }) });
const ordinary = (labels = []) =>
  refreshPr({
    head: { ref: "feat/x", sha: sha("a"), repo: { full_name: REPO } },
    labels,
  });

test("pull_request: an ordinary PR changing a frozen file fails, the labelled refresh PR passes", async () => {
  const bad = await guard(pullRequestEvent(ordinary()), scenario({ pr: ordinary() }));
  assert.deepEqual(bad, { number: 7, refresh: false, touched: [FROZEN], ok: false });
  const labelled = ordinary([{ name: REFRESH_LABEL }]);
  assert.equal((await guard(pullRequestEvent(labelled), scenario({ pr: labelled }))).ok, false);
  const refresh = await guard(pullRequestEvent(), scenario());
  assert.deepEqual(refresh, { number: 7, refresh: true, touched: [FROZEN], ok: true });
  const clean = await guard(
    pullRequestEvent(ordinary()),
    scenario({ pr: ordinary(), list: files(3) }),
  );
  assert.deepEqual(clean, { number: 7, refresh: false, touched: [], ok: true });
});

test("pull_request: the API's head sha must be the event's, and a null head.repo is not same-repo", async () => {
  const moved = refreshPr({ head: { ...refreshPr().head, sha: sha("f") } });
  await assert.rejects(
    guard(pullRequestEvent(refreshPr()), scenario({ pr: moved })),
    /is at f{40}, not the event's a{40}/,
  );
  const gone = refreshPr({ head: { ...refreshPr().head, repo: null } });
  const result = await guard(pullRequestEvent(gone), scenario({ pr: gone }));
  assert.deepEqual([result.refresh, result.ok], [false, false]);
  await assert.rejects(
    guard({ eventName: "pull_request", payload: { pull_request: {} } }, scenario()),
    /no number or head sha/,
  );
  await assert.rejects(guard({ eventName: "push", payload: {} }, scenario()), /unexpected event/);
});

test("pull_request: a changed FROZEN_EXPORTS, or any edit beside it, counts as a frozen change", async () => {
  const contents = (source) => ({
    [`repos/${REPO}/contents/${SEALED_EXPORT}?ref=${sha("a")}`]: {
      encoding: "base64",
      content: Buffer.from(source).toString("base64"),
    },
  });
  const edit = [{ filename: SEALED_EXPORT, status: "modified" }];
  const dropped = sealedSource.replace('  "src-tauri/src/docs_schemas.generated.json",\n', "");
  const pr = ordinary();
  const run = (source, list = edit) =>
    guard(pullRequestEvent(pr), { ...scenario({ pr, list }), ...contents(source) });
  // Outside the entries block nothing may change, so even a harmless edit fails closed.
  assert.deepEqual((await run(`${sealedSource}\n// another edit\n`)).touched, [
    `${SEALED_EXPORT} (FROZEN_EXPORTS)`,
  ]);
  // Touching the file without changing it (a mode change, say) is no change of the list.
  assert.deepEqual((await run(sealedSource)).touched, []);
  assert.deepEqual((await run(dropped)).touched, [`${SEALED_EXPORT} (FROZEN_EXPORTS)`]);
  assert.equal((await run("garbage")).ok, false);
  const removed = [{ filename: SEALED_EXPORT, status: "removed" }];
  assert.equal((await run(sealedSource, removed)).ok, false);
  const renamed = [{ filename: "x.mjs", previous_filename: SEALED_EXPORT, status: "renamed" }];
  assert.equal((await run(sealedSource, renamed)).ok, false);
  // An unreadable head file fails the guard rather than passing it.
  await assert.rejects(guard(pullRequestEvent(pr), scenario({ pr, list: edit })), /HTTP 404/);
  // The refresh PR may change the list too.
  const refresh = await guard(pullRequestEvent(), {
    ...scenario({ list: edit }),
    ...contents(dropped),
  });
  assert.deepEqual([refresh.refresh, refresh.ok], [true, true]);
});

test("merge_group end to end: frozen changes fail unless it is the refresh PR, and the parent must match", async () => {
  // An unlabelled PR touching a frozen file fails.
  const unlabelled = await guard(mergeGroupEvent(), scenario({ pr: ordinary() }));
  assert.deepEqual(unlabelled, { number: 7, refresh: false, touched: [FROZEN], ok: false });
  // The labelled same-repository refresh PR passes.
  const refresh = await guard(mergeGroupEvent(), scenario());
  assert.deepEqual(refresh, { number: 7, refresh: true, touched: [FROZEN], ok: true });
  // An ordinary PR touching none passes, across pages.
  const clean = await guard(mergeGroupEvent(), scenario({ pr: ordinary(), list: files(150) }));
  assert.deepEqual(clean, { number: 7, refresh: false, touched: [], ok: true });
  // The group's second parent must be the PR's head.
  await assert.rejects(
    guard(mergeGroupEvent(7, sha("9")), scenario()),
    /second parent 9{40} is not pull request #7's head a{40}/,
  );
  const oneParent = mergeGroupEvent();
  oneParent.group[`repos/${REPO}/commits/${GROUP}`] = { parents: [{ sha: sha("e") }] };
  await assert.rejects(guard(oneParent, scenario()), /second parent undefined/);
  // The group names its own PR: another number reads another PR, which does not exist here.
  await assert.rejects(guard(mergeGroupEvent(8), scenario()), /HTTP 404/);
  const malformed = mergeGroupEvent();
  malformed.payload.merge_group.head_ref = "refs/heads/gh-readonly-queue/main/pr-x";
  await assert.rejects(guard(malformed, scenario()), /cannot read the queue ref/);
  // A truncated or mismatched list fails closed here too.
  const short = scenario({ pr: ordinary(), list: files(5) });
  short[`repos/${REPO}/pulls/7`].changed_files = 6;
  await assert.rejects(guard(mergeGroupEvent(), short), /reports 6/);
});

test("merge_group reads labels through the API, not the event", async () => {
  const unlabelled = refreshPr({ labels: [] });
  const event = mergeGroupEvent();
  event.payload.merge_group.labels = [{ name: REFRESH_LABEL }];
  assert.equal((await guard(event, scenario({ pr: unlabelled }))).ok, false);
});

test("the workflow's request sends the token and fails on anything but OK", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.authorization]);
    return url.endsWith("/missing")
      ? { ok: false, status: 404 }
      : { ok: true, json: async () => ({ fine: true }) };
  };
  const request = githubRequest(
    { GH_TOKEN: "t", GITHUB_API_URL: "https://api.example" },
    fetchImpl,
  );
  assert.deepEqual(await request("repos/a/b"), { fine: true });
  await assert.rejects(request("repos/a/missing"), /cannot read repos\/a\/missing: HTTP 404/);
  assert.deepEqual(seen[0], ["https://api.example/repos/a/b", "Bearer t"]);
});

// The refresh route: which regenerate run a refresh pull request may come from, and what it may take.
const MAIN = sha("1");
const trusted = (overrides = {}) => ({
  id: 100,
  path: REGENERATE_WORKFLOW,
  head_branch: "main",
  head_repository: { full_name: REPO },
  head_sha: MAIN,
  event: "schedule",
  conclusion: "success",
  display_title: "Regenerate exports (all)",
  created_at: "2026-11-21T07:17:00Z",
  ...overrides,
});
const onMain = (accepted) => (s) => accepted.includes(s);

test("trustedRun accepts only a successful all run of the regenerate workflow on main", () => {
  assert.equal(trustedRun(trusted(), onMain([MAIN])), true);
  assert.equal(trustedRun(trusted({ event: "workflow_dispatch" }), onMain([MAIN])), true);
  for (const [name, run] of [
    ["a dispatch on a branch", trusted({ event: "workflow_dispatch", head_branch: "feat/x" })],
    ["a failed run", trusted({ conclusion: "failure" })],
    ["a run still going", trusted({ conclusion: null })],
    ["a pull_request run", trusted({ event: "pull_request" })],
    ["a push run", trusted({ event: "push" })],
    ["another workflow", trusted({ path: ".github/workflows/rust.yml" })],
    ["a fork", trusted({ head_repository: { full_name: "someone/codesense" } })],
    ["no head repository", trusted({ head_repository: null })],
    ["a single export", trusted({ display_title: "Regenerate exports (model-schemas)" })],
    ["no head sha", trusted({ head_sha: undefined })],
  ])
    assert.equal(trustedRun(run, onMain([MAIN])), false, name);
  // A dispatch on a tag named main reports head_branch main; its sha must be on main's history.
  assert.equal(trustedRun(trusted({ head_sha: sha("2") }), onMain([MAIN])), false);
  assert.equal(
    trustedRun(trusted(), () => "yes"),
    false,
  );
});

const artifact = (name, run = 100, expired = false) => ({
  name,
  expired,
  workflow_run: { id: run },
});
const FROZEN_PATH = FROZEN_EXPORTS[1];
const choose = (overrides = {}) =>
  chooseRun({
    runs: [trusted()],
    artifacts: [artifact("exports-manifest"), artifact("generated-exports")],
    manifest: JSON.stringify([FROZEN_PATH]),
    mainSha: MAIN,
    gap: { ahead: 0, age: "2h" },
    applied: [],
    ...overrides,
  });

test("chooseRun takes the newest accepted run and never falls back to an older one", () => {
  const older = trusted({ id: 90, created_at: "2026-11-20T07:17:00Z" });
  const newer = trusted({ id: 110, created_at: "2026-11-22T07:17:00Z" });
  const runs = [older, newer, trusted()];
  const picked = choose({
    runs,
    artifacts: [artifact("exports-manifest", 110), artifact("generated-exports", 110)],
  });
  assert.equal(picked.action, "refresh");
  assert.equal(picked.run.id, 110);
  assert.equal(newestRun(runs).id, 110);
  // Same start time: the higher id is newer.
  assert.equal(newestRun([trusted({ id: 7 }), trusted({ id: 8 }), trusted({ id: 6 })]).id, 8);
  // The newest run's artifacts expired: refuse, rather than use run 100's.
  const expired = choose({
    runs,
    artifacts: [artifact("exports-manifest", 110), artifact("generated-exports", 110, true)],
  });
  assert.equal(expired.action, "refuse");
  assert.match(expired.reason, /generated-exports.*expired.*dispatch an all run on main/);
  assert.equal(choose({ runs: [] }).action, "refuse");
});

test("chooseRun refuses a missing or expired artifact, or another run's", () => {
  for (const artifacts of [
    [artifact("generated-exports")],
    [artifact("exports-manifest", 100, true), artifact("generated-exports")],
    [artifact("exports-manifest")],
    [artifact("exports-manifest"), artifact("generated-exports", 100, true)],
    [artifact("exports-manifest", 99), artifact("generated-exports")],
  ]) {
    const result = choose({ artifacts });
    assert.equal(result.action, "refuse", JSON.stringify(artifacts));
    assert.match(result.reason, /dispatch an all run on main/);
  }
  // An empty manifest needs no generated-exports artifact.
  assert.equal(
    choose({ manifest: "[]", artifacts: [artifact("exports-manifest")] }).action,
    "fresh",
  );
});

test("chooseRun refuses a manifest that is not a sorted JSON array of distinct paths", () => {
  for (const manifest of [
    undefined,
    "",
    "not json",
    "{}",
    '"a"',
    "[1]",
    '["a", null]',
    '["b", "a"]',
    '["a", "a"]',
    '[""]',
  ]) {
    const result = choose({ manifest });
    assert.equal(result.action, "refuse", String(manifest));
    assert.match(result.reason, /manifest/);
  }
});

test("chooseRun: fresh only for an empty manifest at main's tip; otherwise the gap is reported", () => {
  const fresh = choose({ manifest: "[]\n" });
  assert.equal(fresh.action, "fresh");
  const behind = { ahead: 3, age: "26h" };
  const stale = choose({ manifest: "[]", mainSha: sha("3"), gap: behind });
  assert.equal(stale.action, "stale-run");
  assert.equal(stale.gap, `run 100 at ${MAIN}, 26h old; main is 3 commits ahead`);
  assert.match(stale.reason, /dispatch an all run on main/);
  const refresh = choose({ mainSha: sha("3"), gap: behind });
  assert.equal(refresh.action, "refresh");
  assert.deepEqual(refresh.paths, [FROZEN_PATH]);
  assert.equal(refresh.gap, `run 100 at ${MAIN}, 26h old; main is 3 commits ahead`);
});

test("chooseRun: a run whose Exports-run trailer is already on main opens nothing", () => {
  assert.equal(choose({ applied: ["100"] }).action, "already-applied");
  assert.equal(choose({ applied: [100] }).action, "already-applied");
  assert.equal(choose({ applied: ["10", "1000"] }).action, "refresh");
});

const GEN_DOCS_OUTPUT = "codesense-docs/getting-started/content/generated/mcp-tools.json";
const problems = (overrides = {}) =>
  artifactProblems({
    files: [
      { path: FROZEN_PATH, type: "file" },
      { path: GEN_DOCS_OUTPUT, type: "file" },
    ],
    manifest: [GEN_DOCS_OUTPUT, FROZEN_PATH].sort(),
    frozen: FROZEN_EXPORTS,
    genDocsChanged: [GEN_DOCS_OUTPUT],
    ...overrides,
  });

test("artifactProblems accepts frozen exports and what the branch's gen:docs also wrote", () => {
  assert.deepEqual(problems(), []);
  assert.deepEqual(
    problems({
      files: [{ path: FROZEN_PATH, type: "file" }],
      manifest: [FROZEN_PATH],
      genDocsChanged: [],
    }),
    [],
  );
});

test("artifactProblems refuses a mismatch with the manifest or gen:docs, a symlink and an unsafe path", () => {
  const file = (path, type = "file") => ({ path, type });
  for (const [name, overrides, pattern] of [
    [
      "a manifest path missing",
      { manifest: [GEN_DOCS_OUTPUT, FROZEN_PATH, "x.json"].sort() },
      /x\.json.*not in the artifact/,
    ],
    [
      "an artifact path not in the manifest",
      { manifest: [FROZEN_PATH] },
      /mcp-tools\.json.*not in the manifest/,
    ],
    [
      "an extra file",
      {
        files: [file(FROZEN_PATH), file(GEN_DOCS_OUTPUT), file("src/extra.ts")],
        manifest: [FROZEN_PATH, GEN_DOCS_OUTPUT, "src/extra.ts"].sort(),
      },
      /src\/extra\.ts.*neither a frozen export nor written by gen:docs/,
    ],
    [
      "a local gen:docs change missing",
      { genDocsChanged: [GEN_DOCS_OUTPUT, "codesense-docs/other.html"] },
      /codesense-docs\/other\.html.*gen:docs changed it here but the artifact/,
    ],
    ["a symlink", { files: [file(FROZEN_PATH, "symlink"), file(GEN_DOCS_OUTPUT)] }, /symlink/],
    [
      "an absolute path",
      {
        files: [file(FROZEN_PATH), file(GEN_DOCS_OUTPUT), file("/etc/x")],
        manifest: ["/etc/x", FROZEN_PATH, GEN_DOCS_OUTPUT].sort(),
      },
      /\/etc\/x.*unsafe path/,
    ],
    [
      "a .. path",
      {
        files: [file(FROZEN_PATH), file(GEN_DOCS_OUTPUT), file("a/../b")],
        manifest: ["a/../b", FROZEN_PATH, GEN_DOCS_OUTPUT].sort(),
      },
      /a\/\.\.\/b.*unsafe path/,
    ],
    [
      "a backslash path",
      {
        files: [file(FROZEN_PATH), file(GEN_DOCS_OUTPUT), file("a\\b")],
        manifest: ["a\\b", FROZEN_PATH, GEN_DOCS_OUTPUT].sort(),
      },
      /unsafe path/,
    ],
  ]) {
    const found = problems(overrides);
    assert.ok(found.length, name);
    assert.match(found.join("\n"), pattern, name);
  }
});

const TRAILER =
  "chore: refresh the generated exports\n\nSigned-off-by: x <x@example.invalid>\nExports-run: 100\n";

test("refreshBranchProblems allows a missing branch or a command-made one, and refuses the rest", () => {
  assert.deepEqual(refreshBranchProblems({ branchTip: null, openPr: null, inQueue: false }), []);
  // The update path: an open, unqueued pull request the command made.
  const tip = { sha: sha("4"), message: TRAILER };
  assert.deepEqual(
    refreshBranchProblems({ branchTip: tip, openPr: { number: 5 }, inQueue: false }),
    [],
  );
  // A command-made branch left behind after its pull request merged or closed.
  assert.deepEqual(refreshBranchProblems({ branchTip: tip, openPr: null, inQueue: false }), []);

  const hand = {
    sha: sha("5"),
    message: "chore: add an export\n\nSigned-off-by: x <x@example.invalid>\n",
  };
  assert.match(
    refreshBranchProblems({ branchTip: hand, openPr: { number: 5 }, inQueue: false }).join("\n"),
    /#5.*no Exports-run trailer.*finish or close/,
  );
  assert.match(
    refreshBranchProblems({ branchTip: hand, openPr: null, inQueue: false }).join("\n"),
    /no Exports-run trailer.*finish it or delete the branch/,
  );
  // A trailer outside the last paragraph is not a trailer (an Update branch merge commit).
  const merged = {
    sha: sha("6"),
    message: "Merge branch 'main' into chore/refresh-exports\n\nExports-run: 100\n\nmore\n",
  };
  assert.ok(
    refreshBranchProblems({ branchTip: merged, openPr: { number: 5 }, inQueue: false }).length,
  );
  assert.match(
    refreshBranchProblems({ branchTip: tip, openPr: { number: 5 }, inQueue: true }).join("\n"),
    /merge queue/,
  );
  assert.ok(
    refreshBranchProblems({ branchTip: null, openPr: { number: 5 }, inQueue: false }).length,
  );
});
