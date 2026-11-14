// SPDX-License-Identifier: MIT
// Scripted drivers for the model-free CI run: one that does nothing (every grader must be red)
// and one that makes exactly the expected calls in foreman.md's forms (every grader must be green).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ANSWERED_CARD, CARDS, CONFIG, GIT_ACCESS_PATH, HANDBACK_ROLE, SETUP_LAUNCH, SETUP_STEPS, stepDone } from "./fixture.mjs";

const F = "foreman";
const SELF = CONFIG.self;

// Before a pull request: the recorded git-access method. True when it is `gh`.
const opensWithGh = (fx) => /\bgh\b/.test(fx.tool(F, "read_content_file", { path: GIT_ACCESS_PATH }).text ?? "");

const good = {
  "onboard-repo"({ fx, turns }) {
    fx.human(turns[0]);
    fx.tool(F, "list_sessions");
    // The setup hand-off's launch form.
    fx.tool(F, "open_workspace", { ...SETUP_LAUNCH, launched_by: SELF });
    fx.say(`Starting setup for ${CONFIG.repo}. It will ask you what it needs.`);
  },
  // A live lead is the team's sprint agent (the `sprint` key in home's story-view.yml), in this
  // team, named `Sprint 1` or launched by this Foreman's handle (so a renamed tab still counts).
  "start-sprint-lead"({ fx, turns }) {
    const config = readFileSync(path.join(fx.root, "home", "story-view.yml"), "utf8");
    const agent = /^sprint:\s*(\S+)/m.exec(config)[1];
    const { handle: self } = fx.tool(F, "who_am_i");
    for (const turn of turns) {
      fx.human(turn);
      const live = fx
        .tool(F, "list_sessions")
        .sessions.some(
          (s) =>
            s.agent === agent &&
            s.workspace === CONFIG.team &&
            (s.displayName === "Sprint 1" || s.launchedBy === self),
        );
      if (live) fx.say("Sprint 1 already has a lead running.");
      else {
        fx.tool(F, "open_workspace", { target: "team-workspace", name: "Sprint 1", agent, role: "sprint-lead", initial_prompt: "/sprint-lead 1", launched_by: self });
        fx.say("Started the sprint 1 lead.");
      }
    }
  },
  // Each "make a story" turn is followed by its "Create" turn; every story gets a fresh name.
  "new-story"({ fx, turns }) {
    const title = "Add dark mode to the settings page";
    for (let at = 0; at < turns.length; at += 2) {
      fx.human(turns[at]);
      // Homed in the docs team: no org but the docs.
      const setup = fx.tool(F, "describe_setup");
      if (setup.orgs.every((o) => o.slug === "codesense/docs")) {
        fx.say("Stories live in a team, and you don't have one yet. Want me to start setup?");
        return;
      }
      fx.say(`New story: "${title}" in team ${CONFIG.team}, no epic. Create · Change · Not now?`);
      fx.human(turns[at + 1]);
      const hasRemote = fx.git(["remote"]).stdout.trim() !== "";
      fx.git(["worktree", "list"]);
      const taken = hasRemote ? fx.git(["ls-remote", "--heads", "origin"]).stdout : "";
      // A fresh suffix: draw again while a branch of that name exists.
      let hex;
      do hex = randomBytes(2).toString("hex");
      while (taken.includes(`foreman/dark-mode-${hex}`) || fx.git(["branch", "--list", `foreman/dark-mode-${hex}`]).stdout.trim());
      const branch = `foreman/dark-mode-${hex}`;
      const wt = `foreman-dark-mode-${hex}`;
      const dir = path.join(fx.root, wt);
      fx.git(["worktree", "add", "-b", branch, `../${wt}`, hasRemote ? "origin/main" : "main"]);
      const [hit] = fx.tool(F, "query_context", { text: "story-create" }).hits;
      if (hit) {
        fx.tool(F, "read_content_file", { path: hit.path });
        const id = fx.run(path.join(dir, "stories", "next-id.sh"), [], dir).stdout.trim();
        fx.run(path.join(dir, "stories", "new-story.sh"), [id, title], dir);
      } else {
        const file = `stories/dark-mode-${hex}.md`;
        fx.tool(F, "get_story_format");
        fx.write(path.join(dir, file), `---\ntype: story\nstatus: planning\nsprint: backlog\n---\n# ${title}\n`);
        fx.tool(F, "validate_story", { path: `../${wt}/${file}` });
        fx.git(["-C", `../${wt}`, "add", file]);
        fx.write(path.join(fx.root, `${wt}.msg`), `Add the dark mode story\n`);
        fx.git(["-C", `../${wt}`, "commit", "-s", "-F", `../${wt}.msg`]);
        if (hasRemote) fx.git(["-C", `../${wt}`, "push", "-u", "origin", branch]);
      }
      const viaGh = hasRemote && opensWithGh(fx);
      if (viaGh) fx.gh(["pr", "create", "--head", branch, "--title", title, "--body", "Adds the dark mode story."], dir);
      fx.git(["worktree", "remove", `../${wt}`]);
      fx.say(
        viaGh
          ? `Opened a pull request for "${title}" from ${branch}.`
          : hasRemote
            ? `Pushed "${title}" on ${branch}. No git-access method here can open a pull request, so the branch is ready for you.`
            : `Made the story on branch ${branch}. There's no remote, so no pull request. To merge it, run in your main workspace: git merge ${branch}`,
      );
    }
  },
  handoff({ fx, turns }) {
    fx.human(turns[0]);
    fx.tool(F, "list_sessions");
    fx.git(["worktree", "list"]);
    fx.say("Foreman handoff:\nHome team: acme\nOpen worktrees: foreman-x\nLive children: session-child-1 (ACME-7)\nUnanswered cards I raised: none\nLast request: hand off now (test)");
    fx.tool(F, "signal_done", { status: "success" });
  },
  // The setup hand-off, in foreman.md's forms. One script serves every setup case; the fixture
  // decides what the ledger, the inbox and the sessions hold.
  setup({ fx, turns }) {
    let handoff;
    for (const turn of turns) {
      fx.human(turn);
      const ledger = fx.tool(F, "records_list", { collection: "setup-ledger" }).records;
      const skipped = ledger.some((r) => r.step === "foreman-offer" && r.state === "skipped");
      if (/^Guide handoff:/.test(turn)) {
        handoff = turn;
        fx.say("Noted.");
      } else if (/^not now$/i.test(turn)) {
        fx.tool(F, "records_create", { collection: "setup-ledger", fields: { step: "foreman-offer", state: "skipped" } });
        fx.say("No problem. Ask me when you want to set up.");
      } else if (/how is setup going/i.test(turn)) {
        const next = SETUP_STEPS.find((step) => !stepDone(ledger, step));
        fx.say(`Setup stopped at ${next}. Resume?`);
      } else if (/set me up|resume setup/i.test(turn)) {
        // A live guide launched by any Foreman session: this one, or one before a relaunch.
        const { sessions } = fx.tool(F, "list_sessions");
        const foreman = (h) => h === SELF || sessions.some((x) => x.handle === h && /^foreman-/.test(x.agent ?? ""));
        const live = sessions.some((x) => /^guide-/.test(x.agent ?? "") && foreman(x.launchedBy));
        if (live) {
          fx.say("A setup session is already running; open its tab to carry on.");
          continue;
        }
        const started = ledger.some((r) => r.step !== "foreman-offer");
        const complete = SETUP_STEPS.every((step) => stepDone(ledger, step));
        const resume = started && !complete ? ["/codesense-setup resume", handoff].filter(Boolean).join(" ") : undefined;
        fx.tool(F, "open_workspace", { ...SETUP_LAUNCH, ...(resume && { initial_prompt: resume }), launched_by: SELF });
        fx.say(started ? "Resuming setup where it left off." : `Starting setup for ${CONFIG.repo}.`);
        // Mail wakes the Foreman: the guide's hand-back.
        const { deliveries } = fx.tool(F, "claim_role_messages", { role: HANDBACK_ROLE });
        for (const d of deliveries) {
          fx.tool(F, "ack_role_message", { deliveryId: d.deliveryId, claimToken: d.claimToken, receiptId: `receipt-${d.deliveryId}` });
          const done = fx.tool(F, "records_list", { collection: "setup-ledger" }).records.filter((r) => r.state === "done").map((r) => r.step);
          fx.say(`Set up: ${done.join(", ")}.`);
        }
      } else {
        const pending = fx.tool(F, "inbox_list", { kind: "needs-you", limit: 50 }).cards.some((c) => c.story === "setup" && !c.state);
        const orgs = fx.tool(F, "list_orgs_teams");
        const repos = fx.tool(F, "list_source_repos").repos;
        if (pending || skipped || (orgs.length > 1 && repos.length)) fx.say("Hi. What can I do for you?");
        else
          fx.tool(F, "reply", {
            kind: "needs-you",
            text: "You have no team or repo yet. Set up now?",
            options: ["Set up now", "Not now"],
          });
      }
    }
  },
  "waiting-on-me"({ fx, turns }) {
    fx.human(turns[0]);
    const open = fx.tool(F, "inbox_list", { kind: "needs-you", limit: 50 }).cards.filter((c) => c.state !== ANSWERED_CARD.state);
    fx.say(`Waiting on you: ${open.map((c) => `${c.story}: ${c.question}`).join("; ")}. Answer on the page.`);
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
    opensWithGh(fx);
    const result = fx.gh(["pr", "create", "--head", branch, "--title", "Fix the readme", "--body", "Fixes the readme."], dir);
    fx.git(["worktree", "remove", `../${wt}`]);
    fx.say(`The pull request didn't go through (${result.stderr.trim()}). I cleaned up my worktree. Want me to retry?`);
    fx.human(turns[1]);
    fx.say("I don't set timers.");
  },
};

export const stubs = {
  doNothing: async () => ({ cost_usd: 0, tokens: 0 }),
  good: async ({ caseDef, fx }) => {
    await good[caseDef.kind ?? caseDef.id]({ fx, turns: caseDef.input.turns });
    return { cost_usd: 0, tokens: 0 };
  },
};
