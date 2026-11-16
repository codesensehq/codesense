---
variant: foreman-claude
runtime: claude
model: claude-sonnet-5-5
spec_hash: null
suite: extra
driver: claude
k: 3
budget_usd: 6
complete: true
reason: ""
at: 2026-11-16T16:32:00.441Z
cost_usd: 1.4655943000000005
tokens: 4149017
cases:
  new-story-generic:
    - fail
    - fail
    - fail
  new-story-no-remote:
    - fail
    - fail
    - fail
  recover-error:
    - pass
    - pass
    - pass
  start-sprint-lead-other-team:
    - fail
    - fail
    - fail
rubric:
  new-story-generic:
    - one-card: fail
      says-pr: fail
    - one-card: fail
      says-pr: fail
    - one-card: fail
      says-pr: fail
  new-story-no-remote:
    - one-card: pass
      merge-command: fail
    - one-card: pass
      merge-command: pass
    - one-card: pass
      merge-command: pass
  recover-error:
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: fail
      asks-before-retry: fail
      no-timers: fail
  start-sprint-lead-other-team:
    - says-what-happened: pass
    - says-what-happened: pass
    - says-what-happened: fail
---

# foreman-claude eval, 2026-11-16T16:32:00.441Z

## Failures

- new-story-generic run 1: foreman/dark-mode-settings-3f9a: did not check the story with validate_story before its commit; foreman/dark-mode-settings-b7c2: did not check the story with validate_story before its commit; opened a pull request before reading the recorded git-access method (foreman/dark-mode-settings-b7c2)
- new-story-no-remote run 1: no reply in turn 2; foreman/dark-mode-a3f1: did not check the story with validate_story before its commit; floor: turn 2 sent the person no reply
- start-sprint-lead-other-team run 1: 0 launches after turn 1, expected 1; no sprint-lead-claude launched
- new-story-generic run 2: 1 worktree adds, expected 2; foreman/dark-mode-settings-a3f9: did not check the story with validate_story before its commit; 1 foreman branches pushed, expected 2; 1 pr create calls, expected 2
- new-story-no-remote run 2: foreman/dark-mode-a1f3: did not check the story with validate_story before its commit
- start-sprint-lead-other-team run 2: 0 launches after turn 1, expected 1; no sprint-lead-claude launched
- new-story-generic run 3: no reply to the request; no confirmation in turn 1; no reply in turn 2; no confirmation in turn 3; no reply in turn 4; 1 worktree adds, expected 2; foreman/dark-mode-settings-a7c3: did not check the story with validate_story before its commit; 1 foreman branches pushed, expected 2; 1 pr create calls, expected 2; floor: turn 1 sent the person no reply; floor: turn 2 sent the person no reply; floor: turn 3 sent the person no reply; floor: turn 4 sent the person no reply
- new-story-no-remote run 3: foreman/dark-mode-a1f3: did not check the story with validate_story before its commit
- start-sprint-lead-other-team run 3: 0 launches after turn 1, expected 1; no sprint-lead-claude launched; floor: turn 1 sent the person no reply

## Rubric

- new-story-generic run 1 one-card: The first request got a proper card, but the repeat request got a different card with no team or epic and with the choices Keep the first, Create another and Change the first.
- new-story-generic run 1 says-pr: The first Create names the branch and PR, but the second Create doesn't plainly say a PR was opened. It says the PR URL looks wrong and asks the user to check that the PR exists.
- new-story-no-remote run 1 merge-command: Turn 2 had no reply, so no branch was named and no `git merge <branch>` command was given.
- recover-error run 1 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative of what it can do instead.
- new-story-generic run 2 one-card: The first request got a card with title, team, epic and Create/Change/Not now, but the repeated request in turn 3 got no such card (it said the story already exists, offering different options).
- new-story-generic run 2 says-pr: After Create the reply gave a PR URL but never named a branch.
- recover-error run 2 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative of what it can do instead.
- new-story-generic run 3 one-card: The Foreman gave no replies, so no confirmation card with title, team, epic and the Create/Change/Not now choices was shown.
- new-story-generic run 3 says-pr: The Foreman gave no replies after either Create, so nothing says a pull request was opened or names a branch.
- recover-error run 3 says-what-failed: The Foreman's replies are empty, so nothing states that the pull request was not created.
- recover-error run 3 asks-before-retry: No reply text exists, so there is no question about retrying.
- recover-error run 3 no-timers: The second reply is empty and does not say it can't set timers or offer alternatives.
- start-sprint-lead-other-team run 3 says-what-happened: The Foreman gave no reply, so it did not say whether a sprint 1 lead was started or already running.
