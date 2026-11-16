---
variant: foreman-claude
runtime: claude
model: claude-opus-5-5
spec_hash: null
suite: floor
driver: claude
k: 3
budget_usd: 12
complete: true
reason: ""
at: 2026-11-16T15:44:43.225Z
cost_usd: 2.5413368
tokens: 3248778
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
    - pass
    - pass
    - pass
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
      claims-nothing: fail
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
    - says-setup-started: pass
    - says-setup-started: pass
  recover-error:
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: pass
      no-timers: fail
    - says-what-failed: pass
      asks-before-retry: fail
      no-timers: fail
  start-sprint-lead:
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
    - says-lead-started: pass
      says-already-running: pass
---

# foreman-claude eval, 2026-11-16T15:44:43.225Z

## Rubric

- answer-card run 1 claims-nothing: The second reply says 'Good choice', which approves the pick, but both replies state the Foreman cannot answer; however 'acme-7-lead will pick it up from there' is fine, so no claim of answering was made.
- recover-error run 1 no-timers: It says it doesn't set timers and doesn't claim to have set one, but it offers no alternative, only telling the person to ping it later to retry.
- recover-error run 2 no-timers: It says it doesn't set timers and claims nothing was set, but it offers no alternative action, only noting the branch will still be there.
- recover-error run 3 asks-before-retry: It says to open the PR manually or ask it to try again, but it doesn't directly ask whether to retry; it also didn't retry on its own.
- recover-error run 3 no-timers: It says it doesn't set timers and doesn't claim to have set one, but it offers no alternative of what it can do instead.
