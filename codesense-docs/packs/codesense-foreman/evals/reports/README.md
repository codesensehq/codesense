<!-- SPDX-License-Identifier: MIT -->

# Foreman eval reports

Each `foreman-claude-<date>[-n].md` is one `evals/run.sh foreman-claude --driver claude` run. Its
front block is the record that `variants.yml` and `check-registry.mjs` read. This note is for the
Steward: what each failing row's runs did and why. Report files say which run; the run's
transcript stays on the machine that ran it.

## Rows

| Model               | `spec_hash` | Status | Deciding report                  | Spend |
| ------------------- | ----------- | ------ | -------------------------------- | ----- |
| `claude-opus-5-5`   | null        | passed | `foreman-claude-2026-11-16-8.md` | $2.54 |
| `claude-sonnet-5-5` | null        | failed | `foreman-claude-2026-11-16-7.md` | $1.20 |

`spec_hash` is null because there is no pack builder yet; the rows key on null until one exists.
Both runs were k=3, complete and had no infra errors. The Foreman had plain `Read`, `Edit` and
`Write` allows and no file rule: its instructions, not rules, say where it edits. Opus passed every
case in every run. Sonnet passed `answer-card` 3/3 and failed one or two runs of each other case.

## Permission refusals

No run had a permission refusal of any kind. Each transcript's `result` lines carry Claude's
`permission_denials`; the count per run is:

```sh
for f in "$FOREMAN_EVAL_LOGS"/*.jsonl; do
  printf '%s %s\n' "$(basename "$f" .jsonl)" \
    "$(jq -s '[.[] | select(.type == "result") | .permission_denials[]?] | length' "$f")"
done
```

Add `| select(.tool_name == "Edit" or .tool_name == "Write")` after `[]?` to count only file
writes. Every one of the 24 runs in `-7.md` and `-8.md` (12 per model, 3 per case) counted 0 for
both, as did the 24 in `-5.md` and `-6.md`.

## Fails

| Report                           | Case                | Run  | Cause                                                                                                                                    |
| -------------------------------- | ------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `foreman-claude-2026-11-16-7.md` | `onboard-repo`      | 1, 2 | Launched the setup session, then answered in plain text: no `reply` in turn 1                                                            |
| `foreman-claude-2026-11-16-7.md` | `recover-error`     | 2    | Committed, pushed, hit the injected `gh` failure and removed the worktree, but answered both turns in plain text: no `reply`             |
| `foreman-claude-2026-11-16-7.md` | `start-sprint-lead` | 2    | Called `read_content_file` with no arguments, so it never read `story-view.yml` and asked for the agent; turn 2 launched with no `reply` |

These are model failures, not permission ones: every one but the empty `read_content_file` call is
a turn answered in plain text without `reply`.

## Superseded: plain file access, before the worktree-remove fix

`foreman-claude-2026-11-16-6.md` (Opus, 12/12) and `-5.md` (Sonnet, 8/12) ran on a `foreman.md`
whose worktree-remove line had been trimmed to "when done". Sonnet then kept the worktree for a
retry after the `gh` failure in all three `recover-error` runs ("a foreman worktree was left
behind"), and `answer-card` run 1 sent an empty `reply`, then plain text. The line now says to
remove the worktree even if the PR failed, and no `-7.md` run left one.

## Earlier passes and fails (file rules in the `//**/foreman-*` form)

`foreman-claude-2026-11-16-3.md` (Opus) passed every case. `foreman-claude-2026-11-16-4.md`
(Sonnet) failed `recover-error` run 1 and `onboard-repo` run 3, both by answering in plain text with
no `reply`. Neither had a permission refusal. No `-4.md` run left a worktree
behind: the same grader check passed in all three `recover-error` runs.

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
