// SPDX-License-Identifier: MIT
// The real model driver: headless `claude -p`, launched as the Foreman's agent.yaml launches it
// (its root prompt, permissions, env and `--add-dir`), in the fixture's home. Each case turn is
// one `claude -p` on the same session, delivered as the page chat delivers it: the person's
// text is inbox mail, and the prompt is CodeSense's idle inbox notice. What the agent does reaches the fixture live, so one
// sequence orders it all:
// - MCP calls go to a host in this process (`codesense`, and `github` for a GitHub MCP case),
//   which logs each through `fx.tool` and answers from the sandbox profile.
// - git from the agent's shell goes through a shim first on PATH that runs it with `fx.git`.
// - gh is the fixture's own shim.
// Cost and tokens come from the CLI's own result line. On `--resume` its `total_cost_usd` is the
// session's running total (`usage` is the one invocation's).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { parse } from "yaml";
import { expandLaunchParent } from "../../../../../scripts/lib/launch-parent.mjs";
import { InfraError } from "./errors.mjs";
import { packDir } from "./floor.mjs";

// One turn's wall clock, and one run's own spend cap (the runner's budget caps the whole report).
export const TURN_TIMEOUT_MS = 10 * 60 * 1000;
export const RUN_CAP_USD = 3;

const AGENT = path.join(packDir, "agents", "foreman-claude", "agent.yaml");
const TOOLS = JSON.parse(readFileSync(new URL("./tool-schemas.json", import.meta.url), "utf8")).tools;
// The one GitHub MCP tool the Foreman may call, in the github server's own argument names.
const GITHUB_TOOLS = [
  {
    name: "create_pull_request",
    description: "Create a new pull request in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "PR title" },
        head: { type: "string", description: "Branch containing changes" },
        base: { type: "string", description: "Branch to merge into" },
        body: { type: "string", description: "PR description" },
        draft: { type: "boolean", description: "Create as draft PR" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
];

export const loadAgent = () => parse(readFileSync(AGENT, "utf8"));

// The agent's launch args with the model under test. Settings come from `local` alone: the
// eval's CLI runs with the real HOME (for its sign-in), so `user` would load this Mac's own
// settings, hooks and CLAUDE.md into the Foreman.
export function launchArgs(agent, model) {
  const args = [...agent.args];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--model") args[i + 1] = model;
    if (args[i] === "--setting-sources") args[i + 1] = "local";
  }
  return args;
}

// Outer-session markers a nested CLI must not inherit (it would think it runs inside them).
const OUTER = /^(?:CLAUDE|CODESENSE_|MCP_)/;

// The git shim. It logs only git the agent's shell runs (the CLI marks its shell with
// CLAUDECODE=1), not git a team script runs inside it.
const shim = (realGit) => `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const host = process.env.FOREMAN_EVAL_HOST;
const parent = spawnSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" }).stdout ?? "";
const fromScript = /^\\S*sh\\s+(?:\\S*\\/)?stories\\/\\S+\\.sh\\b/.test(parent.trim());
if (!host || process.env.CLAUDECODE !== "1" || fromScript) {
  const r = spawnSync(${JSON.stringify(realGit)}, argv, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
fetch(host + "/git", { method: "POST", body: JSON.stringify({ argv, cwd: process.cwd() }) })
  .then((res) => res.json())
  .then((r) => {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    process.exit(r.status ?? 1);
  })
  .catch((e) => {
    process.stderr.write("git: eval host unreachable: " + e.message + "\\n");
    process.exit(128);
  });
`;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

// The MCP host: Streamable HTTP with plain JSON responses, one path per server.
async function startHost(fx, { github, inbox }) {
  const servers = { codesense: { tools: TOOLS, name: (n) => n }, ...(github ? { github: { tools: GITHUB_TOOLS, name: (n) => `mcp__github__${n}` } } : {}) };
  const errors = [];
  let sent = 8000;
  const answer = (server, msg) => {
    const { method, params = {} } = msg;
    if (method === "initialize")
      return { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `eval-${server.key}`, version: "0" } };
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: server.tools };
    if (method === "tools/call") {
      let result;
      try {
        result = fx.tool("foreman", server.name(params.name), params.arguments ?? {});
      } catch (e) {
        errors.push(`${params.name}: ${e.message}`);
        return { content: [{ type: "text", text: `eval host error: ${e.message}` }], isError: true };
      }
      if (server.key === "github") result = { number: 1, html_url: "https://example.test/acme/demo/pull/1" };
      // The person's mail, each message once; a send gets the real tool's answer.
      else if (params.name === "read_messages") result = { messages: inbox.splice(0) };
      else if (["reply", "send_message"].includes(params.name)) result = { status: "sent", messageId: (sent += 1) };
      return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }) }], ...(result?.error ? { isError: true } : {}) };
    }
    return undefined;
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      if (req.method === "POST" && req.url === "/git") {
        const { argv, cwd } = JSON.parse(await readBody(req));
        const r = fx.git(argv, cwd);
        return send(200, { status: r.status, stdout: r.stdout, stderr: r.stderr });
      }
      const m = /^\/mcp\/(\w+)$/.exec(req.url ?? "");
      const target = m && servers[m[1]] && { key: m[1], ...servers[m[1]] };
      if (!target) return send(404, { error: "not found" });
      if (req.method === "DELETE") return send(200);
      if (req.method !== "POST") return send(405);
      const body = JSON.parse(await readBody(req));
      const out = [body]
        .flat()
        .filter((msg) => msg.id !== undefined)
        .map((msg) => {
          const result = answer(target, msg);
          return result === undefined
            ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } }
            : { jsonrpc: "2.0", id: msg.id, result };
        });
      if (!out.length) return send(202);
      return send(200, Array.isArray(body) ? out : out[0]);
    } catch (e) {
      errors.push(e.message);
      return send(500, { error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const mcpServers = Object.fromEntries(Object.keys(servers).map((k) => [k, { type: "http", url: `${url}/mcp/${k}` }]));
  return { url, mcpServers, errors, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Each running CLI leads its own process group, so a timeout, its own exit or the runner's end
// kills it with anything it started (a shell, a background job).
const groups = new Set();
const killGroup = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};
export const killGroups = () => {
  for (const pid of groups) killGroup(pid);
  groups.clear();
};

// Runs `bin` as a group leader: `{ code, stdout, stderr, timedOut }`, or the spawn error.
export function runGroup(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) groups.add(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      groups.delete(child.pid);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (child.pid) killGroup(child.pid);
      groups.delete(child.pid);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// The JSON objects a CLI printed, one per line; anything else is skipped.
export const jsonLines = (text) =>
  text.split("\n").flatMap((l) => {
    try {
      return l.trim().startsWith("{") ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });

const tokensOf = (usage = {}) =>
  ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((n, k) => n + (Number(usage[k]) || 0), 0);

// Options: `model`; `bin` (the CLI, default `claude`); `timeoutMs` per turn; `runCapUsd`, one
// run's own cap; `logDir`, where each run's stream-json transcript is kept (outside the repo).
export function claudeDriver({ model, bin = "claude", timeoutMs = TURN_TIMEOUT_MS, runCapUsd = RUN_CAP_USD, logDir } = {}) {
  const agent = loadAgent();
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
  return async function driver({ caseDef, fx, budgetLeft = Infinity }) {
    const shimDir = path.join(fx.root, "eval-bin");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(path.join(shimDir, "git"), shim(realGit), { mode: 0o755 });
    // The person's unread mail. Ids sit clear of the fixture's card ids.
    const inbox = [];
    const host = await startHost(fx, { github: caseDef.fixture?.git_access === "github-mcp", inbox });
    const session = randomUUID();
    const self = fx.config.self;
    const home = path.join(fx.root, "home");
    // The rules as the app writes them for a launch in home: `{{launch_parent}}` expanded.
    const { permissions } = expandLaunchParent({ permissions: agent.permissions.claude }, home).content;
    const settings = { permissions, env: { ...agent.env, HOME: fx.env.HOME } };
    const env = {
      ...Object.fromEntries(Object.entries(fx.env).filter(([k]) => !OUTER.test(k))),
      // The CLI's own sign-in lives under the real HOME; the agent's shell gets the sandbox's
      // through `settings.env`.
      HOME: os.homedir(),
      PATH: `${shimDir}${path.delimiter}${fx.env.PATH}`,
      CODESENSE_TAB_SESSION_ID: fx.env.CODESENSE_TAB_SESSION_ID,
      FOREMAN_EVAL_HOST: host.url,
      ...agent.env,
    };
    const transcript = logDir && (mkdirSync(logDir, { recursive: true }), path.join(logDir, `${caseDef.id}-${session}.jsonl`));
    let cost = 0;
    let tokens = 0;
    const fail = (message) => new InfraError(message, { cost_usd: cost });
    try {
      for (const [i, text] of caseDef.input.turns.entries()) {
        // The CLI holds the cap against the session's total, so it is the run's whole cap.
        const cap = Math.min(runCapUsd, budgetLeft);
        if (!(cap > cost)) throw fail(`budget: no spend left for turn ${i + 1}`);
        fx.human(text);
        inbox.push({ messageId: 7001 + i, from: "human", fromName: "You", text });
        const notice = `[inbox t${i + 1}] You have 1 new message. Call read_messages with session_id ${self}.`;
        const args = [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          ...launchArgs(agent, model),
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify({ mcpServers: host.mcpServers }),
          "--settings",
          JSON.stringify(settings),
          "--max-budget-usd",
          String(Number(cap.toFixed(4))),
          ...(i === 0 ? ["--session-id", session] : ["--resume", session]),
          notice,
        ];
        let turn;
        try {
          turn = await runGroup(bin, args, { cwd: home, env, timeoutMs });
        } catch (e) {
          throw fail(`could not start ${bin}: ${e.message}`);
        }
        if (transcript) writeFileSync(transcript, turn.stdout, { flag: "a" });
        const lines = jsonLines(turn.stdout);
        const result = lines.findLast((l) => l.type === "result");
        if (result) {
          const total = Number(result.total_cost_usd);
          if (!Number.isFinite(total) || total < cost) throw fail(`turn ${i + 1}: the CLI reported cost ${result.total_cost_usd} after ${cost}`);
          cost = total;
          tokens += tokensOf(result.usage);
        } else {
          // What a killed or result-less turn spent is unknown: charge it up to its cap.
          cost = cap;
        }
        if (turn.timedOut) throw fail(`turn ${i + 1} timed out after ${timeoutMs / 1000}s`);
        const init = lines.find((l) => l.type === "system" && l.subtype === "init");
        const down = (init?.mcp_servers ?? []).find((s) => s.status !== "connected");
        if (down) throw fail(`turn ${i + 1}: MCP server ${down.name} ${down.status}`);
        if (!result) throw fail(`turn ${i + 1}: the CLI exited ${turn.code} with no result: ${turn.stderr.trim().split("\n").at(-1) ?? ""}`);
        if (host.errors.length) throw fail(`turn ${i + 1}: eval host: ${host.errors.join("; ")}`);
        if (result.is_error) {
          // The agent running out of turns, or past its own run cap, is its behaviour: graded.
          if (result.subtype === "error_max_turns") break;
          if (result.subtype === "error_max_budget_usd") {
            if (budgetLeft < runCapUsd) throw fail(`turn ${i + 1}: budget: the runner's budget ran out`);
            break;
          }
          throw fail(`turn ${i + 1}: ${result.subtype}: ${String(result.result ?? result.errors ?? "").slice(0, 300)}`);
        }
      }
      return { cost_usd: cost, tokens, session };
    } finally {
      await host.close();
    }
  };
}
