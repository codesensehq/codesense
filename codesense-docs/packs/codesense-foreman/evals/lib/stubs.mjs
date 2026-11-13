// SPDX-License-Identifier: MIT
// Scripted drivers for the model-free CI run: one that does nothing (every grader must be red)
// and one that makes exactly the expected calls (every grader must be green).
import path from "node:path";
import { CARDS, CONFIG } from "./fixture.mjs";

const F = "foreman";

const good = {
  "onboard-repo"({ fx }) {
    fx.human("set me up with ~/code/demo");
    fx.tool(F, "open_workspace", { agent: "codesense-setup", initial_prompt: "/codesense-setup ~/code/demo" });
    fx.say("Starting setup for ~/code/demo. It will ask you what it needs.");
  },
  "start-sprint-lead"({ fx }) {
    for (const turn of ["start sprint 1", "start sprint 1"]) {
      fx.human(turn);
      const live = fx.tool(F, "list_sessions").sessions.some((s) => s.role === "sprint-lead");
      if (live) fx.say("Sprint 1 already has a lead running.");
      else {
        fx.tool(F, "open_workspace", { agent: CONFIG.sprintLeadAgent, role: "sprint-lead" });
        fx.say("Started the sprint 1 lead.");
      }
    }
  },
  "answer-card"({ fx }) {
    const card = CARDS[0];
    const rec = card.options.find((o) => o.key === card.recommended);
    fx.human("what's waiting on me?");
    fx.tool(F, "inbox_list");
    fx.say(
      `${card.story} is waiting: ${card.question} Options: ${card.options.map((o) => `${o.key}) ${o.label}`).join("; ")}. I recommend ${rec.label}.`,
    );
    fx.human("answer it: option b");
    fx.say("You answer on the page; the card is shown there. I can't answer it for you.");
  },
  "recover-error"({ fx }) {
    const dir = path.join(fx.root, "foreman-readme-ab12");
    fx.human("ship the readme fix as a pull request");
    fx.git(["worktree", "add", "-b", "foreman/readme-ab12", dir]);
    const result = fx.gh(["pr", "create", "--title", "Fix the readme"]);
    fx.git(["worktree", "remove", "--force", dir]);
    fx.say(`The pull request didn't go through (${result.stderr.trim()}). I cleaned up my worktree. Want me to retry?`);
    fx.human("remind me in an hour");
    fx.say("I don't set timers; I can create a routine for you to approve in its dashboard.");
  },
};

export const stubs = {
  doNothing: async () => ({ cost_usd: 0, tokens: 0 }),
  good: async ({ caseDef, fx }) => {
    await good[caseDef.id]({ fx });
    return { cost_usd: 0, tokens: 0 };
  },
};
