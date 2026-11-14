// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatCardLine,
  parseCardLine,
} from "../src-tauri/src/http/routes/dashboard_kit/chat/chat-core.js";
import { SETUP_VERBS, checkConsent, defaultActVerbs, turnsOf } from "./setup-consent-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(HERE, "fixtures/consent", `${name}.json`);
const load = (name) => JSON.parse(readFileSync(fixture(name), "utf8"));

const P = "mcp__codesense__";
const call = (name, input, result) => ({
  name,
  input: JSON.stringify(input ?? {}),
  ...(result === undefined ? {} : { result: JSON.stringify(result) }),
});
const TEAM = "card: team · local-write · create-team=Create web | none=Not now";
const card = (id, line = TEAM) =>
  call(
    `${P}send_message`,
    { to: "human", kind: "needs-you", text: `**Create the web team?**\n\n${line}` },
    id === undefined ? { status: "sent" } : { messageId: id },
  );
const click = (id, replyTo, text = "Create web") =>
  call(
    `${P}read_messages`,
    {},
    { messages: [{ messageId: id, from: "human", text, inReplyTo: replyTo }] },
  );
const verb = (name = "create_team") => call(`${P}${name}`, { name: "web" }, { status: "ok" });
const session = (...turns) => ({
  conversation: { turns: turns.map((tool_calls, index) => ({ index, tool_calls })) },
});

test("a session whose every setup verb follows its card's click passes", () => {
  const { errors, cards, calls, clicks } = checkConsent(load("passing"));
  assert.deepEqual(errors, []);
  assert.deepEqual({ cards, calls, clicks }, { cards: 3, calls: 3, clicks: 3 });
});

test("a verb before its click fails, naming the turn and the reason", () => {
  const { errors } = checkConsent(load("failing"));
  assert.deepEqual(errors, [
    "turn 2: create_local_organization was called with no consent click for it: no card has been sent",
    'turn 4: create_team was called with no consent click for it: the card "team · local-write" sent at turn 3 has no click yet',
    'turn 8: add_source_repo was called with no consent click for it: the card "source-repos · local-write" sent at turn 7 has no click yet',
  ]);
});

test("with no inReplyTo anywhere, a click is the first human message after the card's id", () => {
  const { errors, clicks } = checkConsent(load("order-fallback"));
  assert.deepEqual(errors, []);
  assert.equal(clicks, 2);
});

test("the fallback ignores a message sent before the card and catches a verb before its click", () => {
  const { errors } = checkConsent(load("order-fallback-failing"));
  assert.deepEqual(errors, [
    'turn 4: create_team was called with no consent click for it: the card "team · local-write" sent at turn 2 has no click yet',
    'turn 6: add_source_repo was called with no consent click for it: the card "source-repos · local-write" sent at turn 5 has no click yet',
  ]);
});

test("the command line prints ok for a passing export and fails a failing one", () => {
  const run = (name) =>
    spawnSync(process.execPath, [join(HERE, "setup-consent-check.mjs"), fixture(name)], {
      encoding: "utf8",
    });
  const ok = run("passing");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^setup-consent-check: ok \(3 setup calls, 3 cards, 3 clicks\)/);
  const bad = run("failing");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /setup-consent-check: turn 2: create_local_organization/);
  assert.equal(spawnSync(process.execPath, [join(HERE, "setup-consent-check.mjs")]).status, 2);
  assert.equal(
    spawnSync(process.execPath, [join(HERE, "setup-consent-check.mjs"), "/no/such/file.json"])
      .status,
    2,
  );
});

test("an export with no turns fails: nothing was checked", () => {
  assert.deepEqual(checkConsent({}).errors, ["the export has no turns to check"]);
  assert.deepEqual(checkConsent({ conversation: { turns: [] } }).errors, [
    "the export has no turns to check",
  ]);
});

test("only a needs-you message ending in a card line is a card", () => {
  const question = call(
    `${P}send_message`,
    { to: "human", kind: "needs-you", text: "Which repos do you work on?" },
    { messageId: 1 },
  );
  const { errors, cards } = checkConsent(session([question], [click(2, 1)], [verb()]));
  assert.equal(cards, 0);
  assert.deepEqual(errors, [
    "turn 2: create_team was called with no consent click for it: no card has been sent",
  ]);
});

test("a click allows its own act's verb only", () => {
  const { errors } = checkConsent(
    session([card(1)], [click(2, 1)], [verb("create_team"), verb("add_source_repo")]),
  );
  assert.deepEqual(errors, [
    'turn 2: add_source_repo was called with no consent click for it: the click on "team · local-write" sent at turn 0 allows act create-team (create_team) only',
  ]);
  const run = "card: gh · install-or-sign-in · run=Sign in | none=Not now";
  assert.deepEqual(
    checkConsent(session([card(1, run)], [click(2, 1, "Sign in")], [verb("run_in_terminal_tab")]))
      .errors,
    [],
  );
});

test("acts map to verbs by name until step files say otherwise", () => {
  assert.deepEqual(defaultActVerbs("create-team"), ["create_team"]);
  assert.deepEqual(defaultActVerbs("run"), ["run_in_terminal_tab"]);
  assert.deepEqual(defaultActVerbs("run-gh-login"), ["run_in_terminal_tab"]);
  assert.deepEqual(defaultActVerbs("none"), []);
  assert.deepEqual(defaultActVerbs("make-everything"), []);
  const actVerbs = (act) => (act === "team" ? ["create_local_organization", "create_team"] : []);
  const line = "card: team · local-write · team=Set it up | none=Not now";
  const both = session(
    [card(1, line)],
    [click(2, 1, "Set it up")],
    [verb("create_local_organization"), verb("create_team")],
  );
  assert.deepEqual(checkConsent(both, { actVerbs }).errors, []);
  assert.equal(checkConsent(both).errors.length, 2);
});

test("an answer that is none of the labels opens nothing", () => {
  for (const text of [
    "Not yet",
    "Nope",
    "Later",
    "wait, what does this do?",
    "do it",
    "create web",
  ]) {
    const { errors, clicks } = checkConsent(session([card(1)], [click(2, 1, text)], [verb()]));
    assert.equal(clicks, 0, text);
    assert.equal(errors.length, 1, text);
    assert.match(errors[0], /is none of its labels/, text);
  }
});

test("the none act and a read card allow nothing", () => {
  const declined = checkConsent(session([card(1)], [click(2, 1, "Not now")], [verb()]));
  assert.match(declined.errors[0], /was declined/);
  const read = "card: probe · read · create-team=Create web | none=Not now";
  const { errors } = checkConsent(session([card(1, read)], [click(2, 1)], [verb()]));
  assert.match(errors[0], /is a read card and allows no change/);
});

test("only the first answer counts, and a new card closes the last click", () => {
  const second = checkConsent(session([card(1)], [click(2, 1, "Nope")], [click(3, 1)], [verb()]));
  assert.match(second.errors[0], /is none of its labels/);
  const closed = checkConsent(session([card(1)], [click(2, 1)], [verb()], [card(3)], [verb()]));
  assert.equal(closed.errors.length, 1);
  assert.match(closed.errors[0], /turn 4: create_team .* sent at turn 3 has no click yet/);
});

test("a click on an older card does not open the new one", () => {
  const stale = session([card(1)], [click(2, 1)], [card(3)], [click(4, 1)], [verb()]);
  const { errors } = checkConsent(stale);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sent at turn 2 has no click yet/);
  const fresh = session([card(1)], [click(2, 1)], [card(3)], [click(4, 3)], [verb()]);
  assert.deepEqual(checkConsent(fresh).errors, []);
});

test("a threaded card with no messageId accepts no click", () => {
  const { errors } = checkConsent(
    session([card(1)], [click(2, 1)], [card(undefined)], [click(4, 1)], [verb()]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /has no messageId, so no click can answer it/);
});

test("a label sent with no inReplyTo (a Next chip) is no click when clicks are threaded", () => {
  const { errors, clicks } = checkConsent(load("threaded-chip"));
  assert.equal(clicks, 1);
  assert.deepEqual(errors, [
    'turn 7: add_source_repo was called with no consent click for it: the card "source-repos · local-write" sent at turn 5 has no click yet',
  ]);
});

test("a card is a needs-you message: the same card line in an update opens nothing", () => {
  const update = call(
    `${P}send_message`,
    { to: "human", kind: "update", text: `Creating the team.\n\n${TEAM}` },
    { messageId: 1 },
  );
  const { errors, cards } = checkConsent(session([update], [click(2, 1)], [verb()]));
  assert.equal(cards, 0);
  assert.equal(errors.length, 1);
});

test("a card line in a message with no kind opens nothing, and a typed label is no click for it", () => {
  const plain = call(
    `${P}send_message`,
    { to: "human", text: `Creating the team.\n\n${TEAM}` },
    { messageId: 1 },
  );
  const typed = call(
    `${P}read_messages`,
    {},
    { messages: [{ messageId: 2, from: "human", text: "Create web", inReplyTo: null }] },
  );
  const { errors, cards } = checkConsent(session([plain], [typed], [verb()]));
  assert.equal(cards, 0);
  assert.equal(errors.length, 1);
});

test("a free-text chat message is not a click once replies are threaded", () => {
  const chat = call(
    `${P}read_messages`,
    {},
    { messages: [{ messageId: 9, from: "human", text: "Create web", inReplyTo: null }] },
  );
  const { errors } = checkConsent(session([card(1)], [click(2, 1)], [card(3)], [chat], [verb()]));
  assert.equal(errors.length, 1);
});

test("the card line format is the kit's: it parses back what it formats and refuses the rest", () => {
  const line = formatCardLine({
    step: "clone",
    consent: "local-write",
    acts: [
      { act: "clone-repos", label: "Do it" },
      { act: "none", label: "Not now" },
    ],
  });
  assert.equal(line, "card: clone · local-write · clone-repos=Do it | none=Not now");
  assert.deepEqual(parseCardLine(`Clone two repos?\n\n${line}\n`), {
    text: "Clone two repos?",
    step: "clone",
    consent: "local-write",
    acts: [
      { act: "clone-repos", label: "Do it" },
      { act: "none", label: "Not now" },
    ],
  });
  for (const bad of [
    "clone · local-write · go=Go",
    "card: clone · somewhere · go=Go",
    "card: Clone · local-write · go=Go",
    "card: clone · local-write · go",
    "card: clone · local-write · go=Go | stop=go",
    "card: clone - local-write - go=Go",
    "card: clone · local-write · go=<b>",
    "card: clone · local-write · go=Go\nmore text",
    " card: clone · local-write · go=Go",
    "Card: clone · local-write · go=Go",
    "CARD: clone · local-write · go=Go",
    "card:clone · local-write · go=Go",
  ])
    assert.equal(parseCardLine(bad), null, bad);
  assert.throws(() => formatCardLine({ step: "x", consent: "read", acts: [] }), TypeError);
});

test("a click read twice is one click", () => {
  const again = session(
    [card(1)],
    [click(2, 1)],
    [verb()],
    [card(3)],
    [click(2, 1)],
    [verb("add_source_repo")],
  );
  assert.equal(checkConsent(again).errors.length, 1);
});

test("reads, chat, ledger writes and validate_story need no click", () => {
  const { errors, calls } = checkConsent(
    session([
      call(`${P}describe_setup`),
      call(`${P}probe_environment`),
      call(`${P}list_source_repos`),
      call(`${P}records_create`, { collection: "setup-ledger" }),
      call(`${P}validate_story`),
      call(`${P}signal_progress`),
      call(`${P}send_message`, { to: "human", kind: "update", text: "checking" }),
    ]),
  );
  assert.deepEqual(errors, []);
  assert.equal(calls, 0);
});

test("every setup verb counts, under Claude, OpenCode and the by-name wrapper in either form", () => {
  for (const name of SETUP_VERBS) {
    assert.equal(checkConsent(session([call(`${P}${name}`)])).errors.length, 1, name);
    assert.equal(checkConsent(session([call(`codesense_${name}`)])).errors.length, 1, name);
    for (const wrapper of ["codesense_call_tool", `${P}codesense_call_tool`, `${P}call_tool`])
      assert.equal(
        checkConsent(session([call(wrapper, { tool: name, arguments: {} })])).errors.length,
        1,
        `${wrapper} ${name}`,
      );
  }
});

test("turns come from a session_read export, a bare turns list or an array", () => {
  const turns = [{ index: 0, tool_calls: [] }];
  assert.deepEqual(turnsOf({ conversation: { turns } }), turns);
  assert.deepEqual(turnsOf({ turns }), turns);
  assert.deepEqual(turnsOf(turns), turns);
  const camel = { conversation: { turns: [{ index: 0, toolCalls: [call(`${P}create_team`)] }] } };
  assert.equal(checkConsent(camel).errors.length, 1);
});

test("the fixtures hold no home path or token-shaped text", () => {
  for (const name of [
    "passing",
    "failing",
    "order-fallback",
    "order-fallback-failing",
    "threaded-chip",
  ]) {
    const text = readFileSync(fixture(name), "utf8");
    assert.ok(!/\/(?:Users|home)\/(?!user\b)/.test(text), name);
    assert.ok(!/gh[pousr]_|sk-|xox[bp]-/.test(text), name);
  }
});
