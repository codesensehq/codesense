// SPDX-License-Identifier: MIT
// The rubric judge: a tool-less `claude -p` reads the person's turns and the Foreman's replies
// and answers each of the case's rubric items pass or fail. Its verdicts are reported beside the
// script grade and never change it.
import { spawn } from "node:child_process";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { jsonLines } from "./claude-driver.mjs";

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

// Options: `model`, `bin` (the CLI, default `claude`), `timeoutMs`.
export function claudeJudge({ model = JUDGE_MODEL, bin = "claude", timeoutMs = JUDGE_TIMEOUT_MS } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|CODESENSE_|MCP_)/.test(k)));
  return ({ caseDef, turns, replies }) =>
    new Promise((resolve, reject) => {
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
        String(JUDGE_CAP_USD),
        "--json-schema",
        JSON.stringify(SCHEMA),
        judgePrompt(caseDef, turns, replies),
      ];
      const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (e) => (clearTimeout(timer), reject(new Error(`judge: could not start ${bin}: ${e.message}`))));
      child.on("close", () => {
        clearTimeout(timer);
        const line = jsonLines(stdout)
          .findLast((l) => l.type === "result");
        if (!line) return reject(new Error("judge: no result"));
        const got = line.structured_output?.verdicts ?? [];
        const verdicts = {};
        const why = {};
        for (const r of caseDef.rubric) {
          const v = got.find((x) => x.id === r.id);
          if (!v) return reject(new Error(`judge: no verdict for ${r.id}`));
          verdicts[r.id] = v.pass ? "pass" : "fail";
          why[r.id] = v.why;
        }
        resolve({ verdicts, why, cost_usd: Number(line.total_cost_usd) || 0 });
      });
    });
}
