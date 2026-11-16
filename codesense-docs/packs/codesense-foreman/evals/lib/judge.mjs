// SPDX-License-Identifier: MIT
// The rubric judge: a tool-less `claude -p` reads the person's turns and the Foreman's replies
// and answers each of the case's rubric items pass or fail. Its verdicts are reported beside the
// script grade and never change it.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { jsonLines, runGroup } from "./claude-driver.mjs";
import { TMP_PREFIX } from "./fixture.mjs";

export const JUDGE_MODEL = "claude-sonnet-5-5";
const JUDGE_CAP_USD = 0.5;
const JUDGE_TIMEOUT_MS = 3 * 60 * 1000;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, pass: { type: "boolean" }, why: { type: "string" } },
        required: ["id", "pass", "why"],
      },
    },
  },
  required: ["verdicts"],
};

export function judgePrompt(caseDef, turns, replies) {
  const transcript = turns
    .map((t) => {
      const said = replies.filter((r) => r.turn === t.index).map((r) => `Foreman: ${r.text}`);
      return [`Turn ${t.index}. Person: ${t.text}`, ...(said.length ? said : ["Foreman: (no reply)"])].join("\n");
    })
    .join("\n\n");
  const items = caseDef.rubric.map((r) => `- ${r.id}: ${r.ask}`).join("\n");
  return `You grade an AI agent's chat replies against a rubric. Judge only what the replies say; nothing else is in front of you. "The first reply" means the Foreman's replies in turn 1 taken together, "the second reply" those in turn 2. Be strict: an item passes only when the replies plainly meet it.

Transcript:

${transcript}

Rubric:
${items}

Answer every rubric id once, with pass true or false and one short sentence why.`;
}

// A judge failure, with what it spent.
const judgeError = (message, cost_usd = 0) => Object.assign(new Error(`judge: ${message}`), { cost_usd });

// Options: `model`, `bin` (the CLI, default `claude`), `timeoutMs`. Each call's cap is the
// smaller of $0.50 and the runner's `budgetLeft`.
export function claudeJudge({ model = JUDGE_MODEL, bin = "claude", timeoutMs = JUDGE_TIMEOUT_MS } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|CODESENSE_|MCP_)/.test(k)));
  return async ({ caseDef, turns, replies, budgetLeft = Infinity }) => {
    const cap = Math.min(JUDGE_CAP_USD, budgetLeft);
    if (!(cap > 0)) throw judgeError("no budget left");
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      model,
      "--setting-sources",
      "local",
      "--strict-mcp-config",
      "--tools",
      "",
      "--no-session-persistence",
      "--max-budget-usd",
      String(Number(cap.toFixed(4))),
      "--json-schema",
      JSON.stringify(SCHEMA),
      judgePrompt(caseDef, turns, replies),
    ];
    // An empty dir, so `--setting-sources local` finds no settings, hooks or env to load.
    const cwd = mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}-judge-`));
    let out;
    try {
      out = await runGroup(bin, args, { cwd, env, timeoutMs });
    } catch (e) {
      throw judgeError(`could not start ${bin}: ${e.message}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const line = jsonLines(out.stdout).findLast((l) => l.type === "result");
    // What a killed or result-less judge spent is unknown: charge it up to its cap.
    if (!line) throw judgeError("no result", cap);
    const cost_usd = Number(line.total_cost_usd) || 0;
    const got = line.structured_output?.verdicts ?? [];
    const verdicts = {};
    const why = {};
    for (const r of caseDef.rubric) {
      const v = got.find((x) => x.id === r.id);
      if (!v) throw judgeError(`no verdict for ${r.id}`, cost_usd);
      verdicts[r.id] = v.pass ? "pass" : "fail";
      why[r.id] = v.why;
    }
    return { verdicts, why, cost_usd };
  };
}
