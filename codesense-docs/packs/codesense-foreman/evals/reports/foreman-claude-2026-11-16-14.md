---
variant: foreman-claude
runtime: claude
model: claude-sonnet-5-5
spec_hash: null
suite: extra
driver: claude
k: 3
budget_usd: 3
complete: true
reason: ""
at: 2026-11-16T16:58:13.469Z
cost_usd: 0.3605949000000001
tokens: 967633
cases:
  start-sprint-lead-renamed:
    - pass
    - pass
    - fail
rubric:
  start-sprint-lead-renamed:
    - says-what-happened: pass
    - says-what-happened: pass
    - says-what-happened: pass
---

# foreman-claude eval, 2026-11-16T16:58:13.469Z

## Failures

- start-sprint-lead-renamed run 3: 0 launches after turn 1, expected 1; 0 launches after turn 2, expected 1; no sprint-lead-claude launched
