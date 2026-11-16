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
at: 2026-11-16T03:23:47.712Z
cost_usd: 1.9079054999999998
tokens: 2922550
cases:
  answer-card:
    - pass
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
    - names-story: pass
      lists-options: pass
      recommends-pick: pass
      points-to-page: pass
      claims-nothing: pass
  onboard-repo:
    - says-setup-started: fail
    - says-setup-started: fail
    - says-setup-started: fail
  recover-error:
    - says-what-failed: fail
      asks-before-retry: fail
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

# foreman-claude eval, 2026-11-16T03:23:47.712Z

## Failures

- recover-error run 1: 0 gh writes, expected 1 (the failed pr create); no pr create was attempted
- recover-error run 2: 0 gh writes, expected 1 (the failed pr create); no pr create was attempted
- recover-error run 3: 0 gh writes, expected 1 (the failed pr create); no pr create was attempted

## Rubric

- onboard-repo run 1 says-setup-started: The reply says a setup session started, but it says the guide wasn't given ~/code/demo and may need the path, so it doesn't plainly say setup started for ~/code/demo.
- recover-error run 1 says-what-failed: Turn 1 had no reply at all, so nothing said the pull request was not created.
- recover-error run 1 asks-before-retry: No reply asked whether to retry; the Foreman said nothing after the failure.
- recover-error run 1 no-timers: It said it doesn't set timers but offered no alternative of what it can do instead.
- onboard-repo run 2 says-setup-started: The Foreman gave no reply, so nothing told the person a setup session started for ~/code/demo.
- recover-error run 2 no-timers: The reply says it doesn't set timers and doesn't claim to have set one, but it offers no alternative of what it can do instead.
- onboard-repo run 3 says-setup-started: The reply says a setup session started with ~/code/demo, but it never says the session will ask the person what it needs.
- recover-error run 3 no-timers: It says "I don't set timers" and claims nothing was set, but it offers no alternative of what it can do instead.
