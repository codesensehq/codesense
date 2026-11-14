// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SETUP_VERBS, checkConsent, turnsOf } from "./setup-consent-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(HERE, "fixtures/consent", `${name}.json`);
const load = (name) => JSON.parse(readFileSync(fixture(name), "utf8"));

const P = "mcp__codesense__";
const call = (name, input, result) => ({
  name,
  input: JSON.stringify(input ?? {}),
  ...(result === undefined ? {} : { result: JSON.stringify(result) }),
});
const card = (id) =>
  call(`${P}send_message`, { to: "human", kind: "needs-you", text: "?" }, { messageId: id });
const click = (id, replyTo, text = "Do it") =>
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
  assert.deepEqual({ cards, calls, clicks }, { cards: 2, calls: 3, clicks: 2 });
});

test("a verb before its click fails, naming the turn and the reason", () => {
  const { errors } = checkConsent(load("failing"));
  assert.deepEqual(errors, [
    "turn 2: create_local_organization was called with no consent click: no card has been sent",
    "turn 4: create_team was called with no consent click: the card sent at turn 3 has no click yet",
    "turn 8: add_source_repo was called with no consent click: the card sent at turn 7 has no click yet",
  ]);
});

test("with no inReplyTo anywhere, cards and clicks pair by message order", () => {
  const { errors, clicks } = checkConsent(load("order-fallback"));
  assert.deepEqual(errors, []);
  assert.equal(clicks, 2);
});

test("the message-order fallback still catches a verb before its click", () => {
  const { errors } = checkConsent(load("order-fallback-failing"));
  assert.deepEqual(errors, [
    "turn 6: add_source_repo was called with no consent click: the card sent at turn 5 has no click yet",
  ]);
});

test("the command line prints ok for a passing export and fails a failing one", () => {
  const run = (name) =>
    spawnSync(process.execPath, [join(HERE, "setup-consent-check.mjs"), fixture(name)], {
      encoding: "utf8",
    });
  const ok = run("passing");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^setup-consent-check: ok \(3 setup calls, 2 cards, 2 clicks\)/);
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

test("a decline never opens consent", () => {
  for (const text of ["Not now", "skip", "Cancel", "Stop", "no"]) {
    const { errors } = checkConsent(session([card(1)], [click(2, 1, text)], [verb()]));
    assert.equal(errors.length, 1, text);
    assert.match(errors[0], /was declined/);
  }
});

test("one click covers every verb until the next card, and a new card closes it", () => {
  const ok = session(
    [card(1)],
    [click(2, 1)],
    [verb("create_local_organization"), verb("create_team")],
  );
  assert.deepEqual(checkConsent(ok).errors, []);
  const second = session(
    [card(1)],
    [click(2, 1)],
    [verb("create_team")],
    [card(3)],
    [verb("add_source_repo")],
  );
  assert.equal(checkConsent(second).errors.length, 1);
});

test("a click on an older card does not open the new one", () => {
  const stale = session([card(1)], [click(2, 1)], [card(3)], [click(4, 1)], [verb()]);
  const { errors } = checkConsent(stale);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /the card sent at turn 2 has no click yet/);
  const fresh = session([card(1)], [click(2, 1)], [card(3)], [click(4, 3)], [verb()]);
  assert.deepEqual(checkConsent(fresh).errors, []);
});

test("a free-text chat message is not a click once replies are threaded", () => {
  const chat = call(
    `${P}read_messages`,
    {},
    { messages: [{ messageId: 9, from: "human", text: "do it", inReplyTo: null }] },
  );
  const { errors } = checkConsent(session([card(1)], [click(2, 1)], [card(3)], [chat], [verb()]));
  assert.equal(errors.length, 1);
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

test("every setup verb counts, under Claude, OpenCode and Codex's by-name wrapper", () => {
  for (const name of SETUP_VERBS) {
    assert.equal(checkConsent(session([call(`${P}${name}`)])).errors.length, 1, name);
    assert.equal(checkConsent(session([call(`codesense_${name}`)])).errors.length, 1, name);
    assert.equal(
      checkConsent(session([call("codesense_call_tool", { tool: name, arguments: {} })])).errors
        .length,
      1,
      name,
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
  for (const name of ["passing", "failing", "order-fallback", "order-fallback-failing"]) {
    const text = readFileSync(fixture(name), "utf8");
    assert.ok(!/\/(?:Users|home)\/(?!user\b)/.test(text), name);
    assert.ok(!/gh[pousr]_|sk-|xox[bp]-/.test(text), name);
  }
});
