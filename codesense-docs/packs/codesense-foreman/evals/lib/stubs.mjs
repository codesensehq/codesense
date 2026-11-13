// SPDX-License-Identifier: MIT
// Scripted drivers for the model-free CI run: one that does nothing (every grader must be red)
// and one that makes exactly the expected calls in foreman.md's forms (every grader must be green).
import path from "node:path";
import { CARDS, CONFIG } from "./fixture.mjs";

const F = "foreman";

const good = {
  "onboard-repo"({ fx, turns }) {
    fx.human(turns[0]);
    fx.tool(F, "open_workspace", { agent: "codesense-setup", initial_prompt: `/codesense-setup ${CONFIG.repo}` });
    fx.say(`Starting setup for ${CONFIG.repo}. It will ask you what it needs.`);
  },
  "start-sprint-lead"({ fx, turns }) {
    for (const turn of turns) {
      fx.human(turn);
      const live = fx.tool(F, "list_sessions").sessions.some((s) => s.agent === CONFIG.sprintLeadAgent);
      if (live) fx.say("Sprint 1 already has a lead running.");
      else {
        fx.tool(F, "open_workspace", { target: "team-workspace", name: "Sprint 1", agent: CONFIG.sprintLeadAgent });
        fx.say("Started the sprint 1 lead.");
      }
    }
  },
  "answer-card"({ fx, turns }) {
    const card = CARDS[0];
    const rec = card.options.find((o) => o.key === card.recommended);
    fx.human(turns[0]);
    fx.tool(F, "inbox_list");
    fx.say(
      `${card.story} is waiting: ${card.question} Options: ${card.options.map((o) => `${o.key}) ${o.label}`).join("; ")}. I recommend ${rec.label}.`,
    );
    fx.human(turns[1]);
    fx.say("You answer on the page; the card is shown there. I can't answer it for you.");
  },
  "recover-error"({ fx, turns }) {
    const wt = "foreman-readme-ab12";
    const branch = "foreman/readme-ab12";
    const dir = path.join(fx.root, wt);
    fx.human(turns[0]);
    fx.git(["worktree", "add", "-b", branch, `../${wt}`, "origin/main"]);
    const result = fx.gh(["pr", "create", "--head", branch, "--title", "Fix the readme", "--body", "Fixes the readme."], dir);
    fx.git(["worktree", "remove", `../${wt}`]);
    fx.say(`The pull request didn't go through (${result.stderr.trim()}). I cleaned up my worktree. Want me to retry?`);
    fx.human(turns[1]);
    fx.say("I don't set timers; I can create a routine for you to approve in its dashboard.");
  },
};

export const stubs = {
  doNothing: async () => ({ cost_usd: 0, tokens: 0 }),
  good: async ({ caseDef, fx }) => {
    await good[caseDef.id]({ fx, turns: caseDef.input.turns });
    return { cost_usd: 0, tokens: 0 };
  },
};
