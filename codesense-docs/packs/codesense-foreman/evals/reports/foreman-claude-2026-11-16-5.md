---
variant: foreman-claude
runtime: claude
model: claude-sonnet-5-5
spec_hash: null
suite: floor
driver: claude
k: 3
budget_usd: 12
complete: true
reason: ""
at: 2026-11-16T15:31:23.376Z
cost_usd: 1.2160026999999998
tokens: 2946014
cases:
  answer-card:
    - fail
    - pass
    - pass
  onboard-repo:
    - pass
    - pass
    - pass
  recover-error:
    - fail
    - fail
    - fail
  start-sprint-lead:
    - pass
    - pass
    - pass
rubric:
  answer-card:
    - names-story: fail
      lists-options: fail
      recommends-pick: fail
      points-to-page: fail
      claims-nothing: pass
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: pass
      claims-nothing: pass
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: pass
      claims-nothing: pass
  onboard-repo:
    - says-setup-started: pass
    - says-setup-started: fail
    - says-setup-started: pass
  recover-error:
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
---

# foreman-claude eval, 2026-11-16T15:31:23.376Z

## Failures

- answer-card run 1: no reply to the person's answer; floor: turn 2 sent the person no reply
- recover-error run 1: a foreman worktree was left behind
- recover-error run 2: a foreman worktree was left behind
- recover-error run 3: a foreman worktree was left behind

## Rubric

- answer-card run 1 names-story: The first reply is empty and does not name ACME-7.
- answer-card run 1 lists-options: The first reply is empty, so no options are listed.
- answer-card run 1 recommends-pick: The first reply is empty, so nothing is recommended.
- answer-card run 1 points-to-page: The second turn has no reply, so the person is not told to answer on the page.
- recover-error run 1 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative of what it can do instead.
- onboard-repo run 2 says-setup-started: The reply says setup guide launched for ~/code/demo but never says it will ask the person what it needs; it only promises a 'Set up:' line on completion.
- recover-error run 2 no-timers: It says it doesn't set timers but offers no alternative of what it can do instead.
- recover-error run 3 no-timers: The reply says it doesn't set timers and claims nothing was set, but it offers no alternative of what it can do instead.
