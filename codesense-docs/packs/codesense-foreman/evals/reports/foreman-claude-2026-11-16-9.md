---
variant: foreman-claude
runtime: claude
model: claude-opus-5-5
spec_hash: null
suite: extra
driver: claude
k: 3
budget_usd: 6
complete: true
reason: ""
at: 2026-11-16T16:22:50.762Z
cost_usd: 3.8271982
tokens: 5869397
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
      merge-command: pass
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
      no-timers: pass
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
  start-sprint-lead-other-team:
    - says-what-happened: pass
    - says-what-happened: pass
    - says-what-happened: pass
---

# foreman-claude eval, 2026-11-16T16:22:50.762Z

## Failures

- new-story-generic run 1: 1 worktree adds, expected 2; foreman/dark-mode-settings-7c3e: did not check the story with validate_story before its commit; 1 foreman branches pushed, expected 2; 1 pr create calls, expected 2
- new-story-no-remote run 1: foreman/dark-mode-settings-7c3e: did not check the story with validate_story before its commit
- start-sprint-lead-other-team run 1: 0 launches after turn 1, expected 1; no sprint-lead-claude launched
- new-story-generic run 2: foreman/dark-mode-settings-3f9a: did not check the story with validate_story before its commit; foreman/dark-mode-settings-b7c2: did not check the story with validate_story before its commit; opened a pull request before reading the recorded git-access method (foreman/dark-mode-settings-b7c2)
- new-story-no-remote run 2: foreman/settings-dark-mode-a3f1: did not check the story with validate_story before its commit
- start-sprint-lead-other-team run 2: 0 launches after turn 1, expected 1; no sprint-lead-claude launched
- new-story-generic run 3: 1 worktree adds, expected 2; foreman/settings-dark-mode-a3f1: did not check the story with validate_story before its commit; 1 foreman branches pushed, expected 2; 1 pr create calls, expected 2
- new-story-no-remote run 3: foreman/dark-mode-settings-3f9a: did not check the story with validate_story before its commit
- start-sprint-lead-other-team run 3: 0 launches after turn 1, expected 1; no sprint-lead-claude launched

## Rubric

- new-story-generic run 1 one-card: The first request got a card with Create/Change/Not now, but the repeat request got a different duplicate-warning card with other options, and the card did not show all the required choices each time.
- new-story-generic run 1 says-pr: The Create reply gave the PR URL but did not say the PR was opened by name of its branch; the only branch named was an unrelated old one.
- recover-error run 1 no-timers: It says it doesn't set timers and claims nothing was set, but offers no alternative it can do instead, only a status note.
- new-story-generic run 2 one-card: The turn 1 card had title, team, epic but offered Create, Change, Not now; however the turn 3 request got a different card offering only Keep PR #1 / Create anyway, without Change or Not now.
- new-story-generic run 2 says-pr: The first Create reply gave a PR link but never named the branch, and the second admitted the PR may not have been opened.
- new-story-generic run 3 one-card: The first request's card had title, team, epic and Create/Change/Not now, but the repeat request's card offered different options (Keep the one we have, Change, Make a second one) and the Turn 4 card omitted team/epic.
- new-story-generic run 3 says-pr: The only Create reply gives the PR URL and branch name, but never says a pull request was opened, only 'PR:' and 'merge the PR'. Under a strict reading this misses the rubric's explicit wording.
- recover-error run 3 no-timers: It says it doesn't set timers but offers no alternative of what it can do instead.
