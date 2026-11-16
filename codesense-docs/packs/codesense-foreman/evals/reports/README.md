<!-- SPDX-License-Identifier: MIT -->

# Foreman eval reports

Each `foreman-claude-<date>[-n].md` is one `evals/run.sh foreman-claude --driver claude` run. Its
front block is the record that `variants.yml` and `check-registry.mjs` read. This note is for the
Steward: what each failing row's runs did and why. Report files say which run; the run's
transcript stays on the machine that ran it.

## Rows

| Model               | `spec_hash` | Status | Deciding report                  | Spend |
| ------------------- | ----------- | ------ | -------------------------------- | ----- |
| `claude-opus-5-5`   | null        | failed | `foreman-claude-2026-11-16-2.md` | $4.09 |
| `claude-sonnet-5-5` | null        | failed | `foreman-claude-2026-11-16.md`   | $1.91 |

`spec_hash` is null because there is no pack builder yet; the rows key on null until one exists.
Both runs were k=3, complete and had no infra errors. On both models, `onboard-repo`,
`start-sprint-lead` and `answer-card` passed 3/3, and `recover-error` failed 3/3.

## Fails

The same cause on both models: the pack's own file rules. `agent.yaml` allows edits only through
`Edit(../foreman-*/**)` and `Write(../foreman-*.msg)`, and Claude never matches a rule path that
starts with `../`, whether the rules come inline or in a `--settings` file as the app writes them.
Every Edit and Write in the `foreman-*` worktree is refused. The Foreman then stops, as
`foreman.md` tells it to, before any commit or `gh pr create`, so the pull request's failure path
is never reached. A probe with an absolute `//<dir>/foreman-*/**` rule is allowed. This is a pack
finding, not a model one: no model can pass this case until the rules change.

| Report                           | Case            | Run | Cause                                                                                                 |
| -------------------------------- | --------------- | --- | ----------------------------------------------------------------------------------------------------- |
| `foreman-claude-2026-11-16-2.md` | `recover-error` | 1   | Edit of README and Write of the commit message refused; stopped and said so, no pull request attempt |
| `foreman-claude-2026-11-16-2.md` | `recover-error` | 2   | Edit, Write and a combined Bash command refused; stopped before any pull request attempt              |
| `foreman-claude-2026-11-16-2.md` | `recover-error` | 3   | Edit and Write refused; stopped before any pull request attempt                                       |
| `foreman-claude-2026-11-16.md`   | `recover-error` | 1   | Edit and Write refused; no pull request attempt, and turn 1 got no `reply` (plain text only)          |
| `foreman-claude-2026-11-16.md`   | `recover-error` | 2   | Write of the commit message refused; stopped before any pull request attempt                          |
| `foreman-claude-2026-11-16.md`   | `recover-error` | 3   | Edit and a combined Bash command refused; stopped before any pull request attempt                     |

## Notes on the runs

- `recover-error`'s first turn changed before these runs. It asked to "ship the readme fix", but the
  fixture holds no fix, so a careful agent asked which fix and never reached the pull request. It
  now names the change. The grader and the failure injection are unchanged.
- An earlier Sonnet run was discarded, not committed: the sandbox answered `read_content_file` with
  a bare ok, so the Foreman could not read the sprint agent from `story-view.yml`.
- Rubric verdicts (the judge's, in each report's `rubric` block and "Rubric" section) never change
  a row. The rubric fails worth a look: `onboard-repo`'s reply rarely says the setup session will
  ask what it needs, and `recover-error`'s reminder reply says "I don't set timers" without offering
  anything instead.
