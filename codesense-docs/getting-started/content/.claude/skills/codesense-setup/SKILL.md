---
name: codesense-setup
description: Set up CodeSense with the person, step by step, from probes and the setup ledger. Use when the page starts you with /codesense-setup, or the person says "set up CodeSense" or "what's left to set up". Safe to rerun.
---

Argument: empty (first open) or `resume` followed by a handoff note.

1. Read `guide/setup/steps/index.yml` with `read_content_file` (ids, titles, needs, what to check). Read a step's file only when you work on it. Check state with `probe_environment`, `describe_setup`, `list_source_repos` and the ledger (`records_list` on `setup-ledger`). That is what is done. Never rely on earlier messages, and check again after each step.
2. First open: in your first reply, show that they use CodeSense by asking for things ("set up my repos", "create a story for the login bug"), list what you found in a few rows, and ask what they work on. Resume: say in one line where things stand and offer the next step.
3. Elicit what you need, one question at a time: products and repos, and where their stories live (GitHub issues, Jira, Linear, none). Suggest answers from what you checked.
4. Pick the next step that isn't done and serves what they asked. Skip steps that don't apply or are done.
5. Send the step's card with `send_message` to `human`, `kind: needs-you`, using its text and options. Ask before you change anything, and confirm the exact names. Only after they click Do it (or an option that names an action) call the step's tool or run its command. Never act without that click. Commands run with `run_in_terminal_tab`, exactly as the step file writes them.
6. Before each step call `signal_progress` ("checking gh", "cloning acme/api") alongside the tool.
7. Check again that it worked, say what changed in one line, and record it with `records_create` (no paths, usernames or secrets in team records; those go in private records).
8. "What have you set up?": read the ledger, re-check machine facts, and list results with undo hints.
9. If the page asks for a handoff, send `Guide handoff:` and up to 10 lines (see `guide/handoff.md`), then stop.

Every tool returns `{status, ...}`. A `validation` or `unauthorizedTeam` status carries the reason in plain language: show it, fix the input, and don't retry blindly. Every write names the person's own `org` and `team`, never the docs team. If nothing in `orgs` is theirs yet, the context repo and team come first, as one card, because everything else is written there.

Never: credentials in chat or files; writes to GitHub, Jira, Slack or any outside account; destructive changes (delete, archive, remove); reading source code, other conversations or terminal output.
