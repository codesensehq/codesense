# Worktrees

_From a story to its worktree and branch: setup scripts, hydration, discovery and clean-up._

A **worktree** is a second (or third, or tenth) checkout of a repo, each on
its own branch, sharing one `.git`. CodeSense gives every story its own, so
agents working on different stories never step on each other's files. By
default every session of a story shares the story's worktree; a named session
can have one of its own (see [Seat worktrees](#seat-worktrees)).

## From a story to a worktree

The first time you open a story's workspace (**Open CLI** on its right-click
menu in the left nav), or an agent calls `open_workspace` for it, CodeSense
creates its worktree:

1. Finds the story's repo from its `source_repo` field. The repo must be one
   your team has configured.
2. Works out the branch: the story's `branch` field if set, otherwise the
   repo's branch prefix plus the story id (`feat/LL-214`).
3. Runs `git worktree add` for that branch from local refs. On your Mac it never
   fetches, so fetch first if the branch or its base is new on the remote. A
   remote machine gets its copy from your Mac's clone, so the same applies. A new branch starts from the branch of the story's first
   `depends_on` story, or else from the repo's start point (`main` unless you
   set one).
4. Links the worktree to the story and opens its terminal.
5. Runs the repo's setup commands in the background.

The worktree goes beside the clone, at `../{repo}-wt/{slug}` by default, where
`{slug}` is the branch with `/` turned into `-`. For `ledgerline/api` and
`feat/LL-214` that's `../api-wt/feat-LL-214`. A clone CodeSense made for you
with **Clone for me** lives under `~/.codesense/users/<id>/sources/`, and its
worktrees sit beside it there.

Every later open reattaches to the same worktree and keeps its files. If your
team has machines, **Open CLI** asks where to create the workspace: **This
Mac** or one of the machines. A workspace that already exists opens where it
lives.

Creating a worktree copies no context into it. Context arrives when an agent
launches there: CodeSense copies the files its definition's `context` names
before the agent starts, and lists them in the clone's `.git/info/exclude` so
they stay out of your commits. More arrives only when an agent asks for it.

## Configure worktrees per repo

Each repo can have its own worktree settings in
`_codesense/worktree/github.com/<owner>/<repo>.yaml` inside the context repo.
For `ledgerline/api`:

```yaml
version: 1
branch_prefix: feat/
default_start_point: main
worktree_dir: ../{repo}-wt/{slug}
timeout_seconds: 600
setup:
  - npm ci
  - npm run db:migrate
env:
  DATABASE_URL: postgres://localhost/ledgerline_dev
```

| Key | What it does | Default |
|---|---|---|
| `setup` | Commands run in a new worktree, in order. | none |
| `env` | Extra environment variables for the setup commands. | none |
| `cleanup` | CodeSense accepts and checks it but doesn't run it. | none |
| `branch_prefix` | Prefix for branches made from story ids. | `feat/` |
| `default_start_point` | The ref new branches start from. | `main` |
| `worktree_dir` | Where worktrees go, relative to the clone. Only `{repo}` and `{slug}` are allowed; `{slug}` is the branch with `/` turned into `-`. | `../{repo}-wt/{slug}` |
| `timeout_seconds` | How long a setup command may run. | 600 |

Setup commands run in the new worktree through a shell, with your login
shell's `PATH`, so `npm`, `cargo` and your scripts are found even when the
app was started from Finder. They also get `CODESENSE_SOURCE_ROOT`, the path
of the checkout the worktree was made from, which is handy for copying a
local `.env`:

```yaml
setup:
  - cp "$CODESENSE_SOURCE_ROOT/.env" .env
```

While setup runs, the workspace shows a checklist of its commands, and a
line names each step as it runs. If a command fails, the worktree stays and
the workspace shows **Setup failed** with the step, its exit code and the
command, so you can fix it and retry.

When the setup commands came from your team's shared context repo rather than
from you, CodeSense shows them before they run for the first time, and again
whenever they change: **Run setup from your team for …?** Choose **Approve &
run**, or **Skip setup** to open the worktree without it.

An agent can also read and write this file for you with the
`read_worktree_config` and `write_worktree_config` tools.

## After a worktree exists

The diff and code editor float over the worktree's terminal: <kbd>⌘⇧D</kbd>
for **Source diff** and <kbd>⌘⇧C</kbd> for the **Code editor**, on this Mac
or on a machine. See [Over the terminal](terminals.md#over-the-terminal).

An agent can list the worktrees CodeSense manages with `list_worktrees`.
Context doesn't sync into an open worktree on its own: an agent there brings
in newer context with `hydrate_worktree`, and sends edits back with reverse
sync (see [Reverse sync](agent-context.md#reverse-sync), in
Beta).

## Seat worktrees

By default a story's own session and its named sessions (`<story>#<name>`) all
work in the story's worktree. An agent that launches a named session with
`open_workspace` can give it a worktree of its own with `seatWorktree`:

```json
{"target": "story", "story_id": "LL-214", "name": "dev", "seatWorktree": {"kind": "branch"}}
{"target": "story", "story_id": "LL-214", "name": "review", "seatWorktree": {"kind": "commit", "commit": "3f2c1a9"}}
```

| Kind | What the session gets |
|---|---|
| `branch` | A writable worktree on its own branch, `<story branch>-seat-<name>` (`feat/LL-214-seat-dev`), cut from the tip of the story's branch. The repo's setup commands run there. |
| `commit` | A detached checkout pinned to that commit (a sha or a ref). No setup runs, so nothing is installed: it suits a reviewer that only reads the code. |

The folder is the one `worktree_dir` gives a branch named
`<story branch>-seat-<name>`, beside the story's own: `../api-wt/feat-LL-214-seat-dev`
for the example. The tab opens in the story's workspace with the other sessions,
under the same `<story>#<name>` handle. The seat worktree is linked to the story
like the story's own worktree: context arrives when its agent launches,
`hydrate_story` and reverse sync work there, and its sessions count toward the
story.

- Launching the same name again reuses its seat worktree. A `commit` seat
  launched with another commit moves to it when it has no uncommitted changes;
  with changes the launch is refused and the worktree is left as it was.
- A seat launch never changes the story's `branch` field.
- When the name is already running, nothing is created: the running session
  keeps its folder, and the result says so in a warning.
- A seat worktree needs a `name`, runs on This Mac only, and can't be asked for
  from a dashboard page yet. Without `seatWorktree` a named session shares the
  story's worktree, as always.
- Seat worktrees stay until you remove them, like any worktree (see below).

## Clean-up

A worktree is removed only when you remove it, for example with
`git worktree remove` in the repo. Closing its tabs or ending its workspace
keeps it. CodeSense never limits how many worktrees you have, and never
removes one because it is idle or because its pull request merged.

Removal never publishes context. Normal removal preserves dirty files and refuses ignored
files whose safety cannot be proved. Review or explicitly publish the files you need, then
remove the worktree.

> **Worktrees are real git worktrees**
>
>   CodeSense creates them with `git worktree`, so `git worktree list` in the
>   repo shows them, and your editor, scripts and tools treat them like any
>   checkout. Creating one is a normal checkout, not an instant copy: large
>   repos take as long as `git worktree add` does.

The full guide ships in the app's docs: **Workspaces & worktrees → Worktree creation**.

## Attach your own clone

Attach a checkout you already have; story worktrees open beside it and it stays untouched.

Point CodeSense at a clone you already have with `attach_source_repo_path`. Story worktrees are created beside it, and your checkout, its branch and its uncommitted work are left alone.
