<!-- SPDX-License-Identifier: MIT -->

# Foreman eval reports

Each `foreman-claude-<date>[-n].md` is one `evals/run.sh foreman-claude --driver claude` run. Its
front block is the record that `variants.yml` and `check-registry.mjs` read. This note is for the
Steward: what each failing row's runs did and why. Report files say which run; the run's
transcript stays on the machine that ran it.

## Rows

| Model               | `spec_hash` | Status | Deciding report                  | Spend |
| ------------------- | ----------- | ------ | -------------------------------- | ----- |
| `claude-opus-5-5`   | null        | passed | `foreman-claude-2026-11-16-3.md` | $2.59 |
| `claude-sonnet-5-5` | null        | failed | `foreman-claude-2026-11-16-4.md` | $1.18 |

`spec_hash` is null because there is no pack builder yet; the rows key on null until one exists.
Both runs were k=3, complete and had no infra errors, with the pack's file rules in the
`//**/foreman-*` form and the eval sandbox under `fm-eval-…`. Opus passed every case in every run.
Sonnet passed `answer-card` and `start-sprint-lead` 3/3 and failed one run each of `onboard-repo`
and `recover-error`; in both, the Foreman answered in plain text and never called `reply`.

## Permission refusals

No run had a permission refusal of any kind, so none of an Edit or Write in the worktree. Each
transcript's `result` lines carry Claude's `permission_denials`; the count per run is:

```sh
for f in "$FOREMAN_EVAL_LOGS"/*.jsonl; do
  printf '%s %s\n' "$(basename "$f" .jsonl)" \
    "$(jq -s '[.[] | select(.type == "result") | .permission_denials[]?] | length' "$f")"
done
```

Add `| select(.tool_name == "Edit" or .tool_name == "Write")` after `[]?` to count only file
writes. Every one of the 24 runs (12 per model) counted 0 for both.

## Fails

| Report                           | Case            | Run | Cause                                                                                                                                              |
| -------------------------------- | --------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foreman-claude-2026-11-16-4.md` | `recover-error` | 1   | Wrote the README and commit message in the worktree, committed, pushed and hit the injected `gh` failure, but said so in plain text: no `reply` in either turn |
| `foreman-claude-2026-11-16-4.md` | `onboard-repo`  | 3   | Launched the setup session correctly, then answered in plain text: no `reply` in turn 1, caught by the floor-wide reply check                       |

These are model failures, not pack ones. The floor-wide check that every turn sends a `reply` is
new in these runs; before it, `onboard-repo` run 3 would have passed on the script grade.

## Earlier fails (before the rule fix)

In `foreman-claude-2026-11-16.md` and `-2.md`, the same cause on both models: the pack's own file
rules, since fixed. `agent.yaml` allowed edits only through
`Edit(../foreman-*/**)` and `Write(../foreman-*.msg)`, and Claude never matches a rule path that
starts with `../`, whether the rules come inline or in a `--settings` file as the app writes them.
Every Edit and Write in the `foreman-*` worktree is refused. The Foreman then stops, as
`foreman.md` tells it to, before any commit or `gh pr create`, so the pull request's failure path
is never reached. A probe with an absolute `//<dir>/foreman-*/**` rule is allowed. This is a pack
finding, not a model one: no model can pass this case until the rules change.

| Report                           | Case            | Run | Cause                                                                                                |
| -------------------------------- | --------------- | --- | ---------------------------------------------------------------------------------------------------- |
| `foreman-claude-2026-11-16-2.md` | `recover-error` | 1   | Edit of README and Write of the commit message refused; stopped and said so, no pull request attempt |
| `foreman-claude-2026-11-16-2.md` | `recover-error` | 2   | Edit, Write and a combined Bash command refused; stopped before any pull request attempt             |
| `foreman-claude-2026-11-16-2.md` | `recover-error` | 3   | Edit and Write refused; stopped before any pull request attempt                                      |
| `foreman-claude-2026-11-16.md`   | `recover-error` | 1   | Edit and Write refused; no pull request attempt, and turn 1 got no `reply` (plain text only)         |
| `foreman-claude-2026-11-16.md`   | `recover-error` | 2   | Write of the commit message refused; stopped before any pull request attempt                         |
| `foreman-claude-2026-11-16.md`   | `recover-error` | 3   | Edit and a combined Bash command refused; stopped before any pull request attempt                    |

## Notes on the earlier runs

- `recover-error`'s first turn changed before these runs. It asked to "ship the readme fix", but the
  fixture holds no fix, so a careful agent asked which fix and never reached the pull request. It
  now names the change. The grader and the failure injection are unchanged.
- An earlier Sonnet run was discarded, not committed: the sandbox answered `read_content_file` with
  a bare ok, so the Foreman could not read the sprint agent from `story-view.yml`.
- Sonnet `onboard-repo` run 2 started the setup session but sent no `reply`, so the person got
  no answer. Then the script grade checked only the launch, and only the rubric caught it ("The
  Foreman gave no reply"). The floor-wide reply check now catches this, as it did in
  `foreman-claude-2026-11-16-4.md`.
- Rubric verdicts (the judge's, in each report's `rubric` block and "Rubric" section) never change
  a row. The rubric fails worth a look: `onboard-repo`'s reply rarely says the setup session will
  ask what it needs, and `recover-error`'s reminder reply says "I don't set timers" without offering
  anything instead.
