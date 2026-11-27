# Contributing to CodeSense

Thanks for your interest. Pull requests, issues and GitHub Discussions are
welcome:

- **Bugs:** open an [issue](https://github.com/codesensehq/codesense/issues/new/choose).
- **Questions and ideas:** start a
  [discussion](https://github.com/codesensehq/codesense/discussions).
- **Security problems:** report them privately, as described in
  [SECURITY.md](SECURITY.md). Don't open a public issue.

## Issues

Open a GitHub issue with what you did, what you expected and what happened,
plus your macOS version and the CodeSense version. The bug report form asks for
these. Don't post secrets, tokens or private repository contents. Search the
open issues first.

## Pull requests

- Keep a change focused on one thing, and say what it does and why.
- If users would notice the change, add a changelog entry as a new file,
  `changes/<slug>.md`, as [changes/README.md](changes/README.md) describes.
  Don't edit `CHANGELOG.md`: entries are folded into it at release time, so
  pull requests merged together never conflict. Write the entry for the people
  who use CodeSense.
- Sign off every commit (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/). See
  [Sign-off](#sign-off-dco) below.
- CI runs on every pull request, and all required checks must pass before it
  can merge. A first-time contributor's runs wait until a maintainer approves
  them. Run the [local checks](#local-checks) first and say in the pull request
  which ones you ran.

### Checks on a pull request

- **DCO** checks that every commit is signed off (see
  [Sign-off](#sign-off-dco)).
- **Privacy scan** checks the files, every commit's changes, the branch name
  and the pull request's title and description for secrets and private data.
  It uses only the public rules in this repository (`scripts/privacy-rules.mjs`
  and `scripts/privacy-scan.allow`); there is no hidden list. To scan your
  checkout with the same rules before you push, run
  `node scripts/privacy-scan.mjs --show .`. If a finding is in an earlier
  commit you've since fixed, start a fresh branch from current `main` and
  reapply only the clean changes. Don't paste private values while explaining
  a failure.
- **Changelog** checks the format of every file in `changes/`. If the pull
  request changes the app (`src/`, `src-tauri/` or `src-emulator/`, apart from
  tests), it also needs a new `changes/<slug>.md`. When users won't notice the
  change, a maintainer adds the `no-changelog` label instead.
- **Rust guards** runs the `codesense-guards` crate's tests (the source guards
  and the X1 census, a count of the calls the guard can't resolve, held under a
  ceiling) on every change, whether or not the Rust jobs are skipped, because
  the guards also scan the frontend. It builds no app and starts without
  waiting for any other job, so it fails within minutes, long before the Rust
  build jobs finish. It is a required check. To run it locally, use
  `cargo test --locked -p codesense-guards`. When the census goes over its
  ceiling, the failure lists the unresolved calls; set `X1_DIFF_BASE` to a
  commit sha, for example `X1_DIFF_BASE=$(git merge-base origin/main HEAD)`, to
  narrow that listing to the calls in, or to functions defined in, the files
  your change touches (it lists every call when none is in a changed file).
- The other jobs lint, build and test the change.
- **Tile specs** runs the `@p0` browser specs in `tests/e2e-mock/tiles/` on
  WebKit and Chromium, and checks that each one carries one gate tag. **Frame
  security specs** runs `pnpm run test:frame-security`, and fails on a skipped
  spec too (the one exception, native media on Linux WebKit, runs nightly on
  macOS). Where new browser specs go, their tags, the release gate and the
  nightly run: [`tests/e2e-mock/README.md`](tests/e2e-mock/README.md).
- **Rust (macOS arm64)** doesn't block a merge. It runs after the merge, on
  each push to `main` and nightly; a red run there is fixed forward in a
  later hardening pass. A push that `main` has already moved past when its
  build starts skips it and reports as superseded, and a newer push to `main`
  cancels an older push's queued or running macOS jobs, which then also report
  as superseded: the newer push's run and the nightly cover it. For a macOS-specific change, a maintainer adds the
  `ci:macos` label to run it on the pull request too.
- A change that touches nothing the Rust build reads (see
  `scripts/rust-changes.mjs`) skips the Rust jobs, which then report as
  passed, and one that changes only files Windows or Linux compiles (listed
  there too) skips the macOS jobs. The nightly run on `main` still tests
  everything.

### Sign-off (DCO)

The sign-off is a line at the end of each commit message that says you wrote
the change, or otherwise have the right to submit it under this project's
licence:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it, using the `user.name` and `user.email` in your git
config. Use your real name. If you forgot, add it to your last commit with
`git commit --amend -s --no-edit`. To add it to every commit on your branch,
point a remote at this repository once, then rebase onto it:

```bash
git remote add upstream https://github.com/codesensehq/codesense.git
git fetch upstream
git rebase --signoff upstream/main
```

The DCO check needs a `Signed-off-by:` line whose email matches the commit's
author email on every commit except merges. Dependabot's own commits on a pull
request Dependabot opened are exempt, because a bot can't certify the DCO.

There is no CLA. Contributions come in under the MIT licence, the same licence
the project goes out under, and the sign-off is all we need. A CLA would only
come if the project were ever relicensed.

### How a pull request lands

The maintainer reviews your pull request and adds it to the merge queue, which
runs the required checks on your change combined with the others ahead of it
and merges it once they pass. You don't need to keep your branch up to date
with `main`. Your commits keep your authorship and sign-off, so the history
credits you. The change ships in the next release; releases are not on a fixed
schedule.

## Local checks

First follow the [Build from source](README.md#build-from-source) steps in the
README. They fetch `src-tauri/resources/git-ai`, build the terminal emulator
files, and build the sidecar binaries the app runs, which the checks need. Then
run:

```bash
pnpm lint              # formatting, ESLint and the repository's own checks
pnpm build             # type-checks and builds the frontend
pnpm exec vitest run   # frontend tests
pnpm test:rust         # Rust tests
```

`pnpm exec prettier --write <file>` fixes the formatting of a file you changed.

### Unused code

`pnpm check:unused` runs [knip](https://knip.dev) for files, exports and types
that nothing uses and compares them with `knip-baseline.json`. It fails on a
finding that is not in the baseline, so new dead code needs a fix, and on a
baseline entry knip no longer reports, so the baseline can only shrink. After
you delete dead code, run `node scripts/check-unused.mjs --write` to drop its
entries. `--write` never adds an entry; adding one is a hand edit that the pull
request shows for review.

### Before the long local checks

- Run `pnpm install` first, and do one check run at a time without starting
  another test runner or job queue from inside it.
- Run `pnpm gen:docs` before any Cargo step, and run the tests you changed
  quickly, without Cargo, before the long run.
- Leave the cargo-written exports README.md lists ("Regenerating exports",
  `FROZEN_EXPORTS`) out of your PR; maintainers refresh them. If you change
  Rust code that feeds the MCP reference, the live-data contract or the model
  schemas, `pnpm gen:docs` and `pnpm gen:docs:check:pr` print a notice that the
  export is stale: that is expected. Commit what `pnpm gen:docs` writes, such
  as `mcp-tools.json`. The page verb registry is not on that list: a verb
  change still regenerates it in the same PR (`pnpm gen:verbs`).
- Leave at least 35 GB of free disk, stop if it drops under 20 GB, and delete
  `target/` when you are done. Build with the default features only.
- If a GitHub release download times out, retry it with `gh release download`
  and check it against its pinned checksum (the scanners' are in
  `release/scanners.lock`).

If a step fails on a clean checkout, please open an issue.

## Release flags

A feature that isn't ready for everyone ships behind a release flag, off by
default. There is one flag today, `tiles`, read as `tiles_enabled()` in Rust
(`src-tauri/src/flags.rs`) and `tilesEnabled()` in the frontend
(`src/shared/lib/tiles-enabled.ts`). It is on only when both of its inputs say
so:

- **The local setting**: `viewer.settings.tiles` in `app-state.json`. Only the
  boolean `true` turns it on; a missing key or any other value is off.
- **No remote kill.** Beta builds read the static update manifest, and each
  read that parses caches its override in `flags-cache.json` in the app data
  folder. Only the literal JSON `false` at `flags.tiles` kills, for example
  `{"version":"0.5.1","flags":{"tiles":false}}`, a withdrawn manifest included.
  The value is unsigned and kill-only: the manifest can switch tiles off but
  never on. An unreachable or malformed manifest keeps the last cached value,
  and a missing, malformed or unreadable cache is no kill. Internal builds read
  no manifest and use the local setting alone.

The app decides the flag once at startup, before its first manifest read, and
the frontend reads that same value through the `tiles_enabled` command, so both
agree for the whole session. A kill takes effect from the next launch.

With the flag off the app is today's app on untouched old state, and no tile
code writes any file. Every file that writes a tile file or mounts the tile host
calls `tilesEnabled()` and is listed in `src/shared/lib/tiles-flag-sites.json`,
one entry per file:

```json
[{ "file": "src/features/tiles/save-layout.ts", "what": "writes the tile layout file" }]
```

`tiles-flag.guard.test.ts` (in `pnpm test:docs-gate`) fails if a listed file
doesn't call `tilesEnabled()` in code; a mention in a comment or a string
doesn't count.

## Who maintains CodeSense

CodeSense has a single maintainer, who reviews every change and makes the final
call on what is merged and released. [MAINTAINERS.md](MAINTAINERS.md) says who
that is and how to reach them.

What you can expect:

- Issues and discussions are triaged weekly, on a best-effort basis. There is
  no promised response time for bugs, features or questions.
- We aim to acknowledge security reports within 3 business days (see
  [SECURITY.md](SECURITY.md)).
- Only the latest release is supported.
- Questions and ideas go to
  [GitHub Discussions](https://github.com/codesensehq/codesense/discussions);
  bugs go to issues.

## AI assistance

AI agents help the maintainer triage issues, review changes and write code.
The maintainer reviews and is responsible for what is released. Maintainer
commits use the maintainer's own GitHub identity (their GitHub noreply address)
as author, committer and sign-off, are signed, and carry no AI co-author
trailer. A maintainer clone sets `git config codesense.requireSigned true`;
then a push to the public repository is refused if any commit it publishes is
unsigned or has an Anthropic (Claude) co-author trailer. After this check was
added, a maintainer clone must rerun `scripts/git-hooks/install.sh` once.
GitHub's Verified badge shows whose key signed a commit.

**Maintainer clone setup.** In each maintainer clone (never globally): set
`git config user.name` to the maintainer's GitHub login and
`git config user.email` to its noreply address,
`<id>+<login>@users.noreply.github.com` (GitHub shows it under Settings, Emails;
[MAINTAINERS.md](MAINTAINERS.md) says who the maintainer is); set
`git config gpg.format ssh`, `git config user.signingkey` to the registered
public key, and `git config commit.gpgsign true`; set
`git config codesense.requireSigned true`; and run
`sh scripts/git-hooks/install.sh --quiet`, which is safe to rerun.

**Checks at commit time.** With the hooks installed and a public remote, the
`commit-msg` hook refuses a commit, and commits nothing, when:

- the message, or a line or path the commit adds, matches the privacy rules
  (the same rules and allow-list as the push check; a merge is left to the push
  check), or the staged changes hold a gitlink;
- in a clone that sets `codesense.requireSigned`: the author or committer is
  not the maintainer identity, the trailer block has no maintainer
  `Signed-off-by` (`git commit -s`), the message has an AI `Co-authored-by`
  trailer, or signing is not configured (`commit.gpgsign` true and a key).
  The hook cannot see `-S`, so it checks the signing config, not the
  signature. The push check only checks that each commit carries a signature
  (GitHub's Verified badge shows whose key made it), and nothing after this
  hook checks the author or committer identity before a merge.

The hook scans every line of git's message file, comment lines and the `-v` diff
included, because it can't see which lines git drops. Each refusal prints one
line per finding: the rule, where it is and how to fix it. A staged file is
named only by its position in the commit's file list
(`git diff --cached --name-only`; for `commit -a` or a pathspec commit, the list
once those files are staged), never by name. `CODESENSE_PRIVACY_SHOW=1` prints
the file name and, for some rules, the matched text, so never paste that output
anywhere public. Fix each finding and rerun the commit. Skipping the hooks with
`--no-verify` is not allowed: the push check and CI still refuse the change.

You're welcome to use AI tools for your own contributions. You remain
responsible for what you submit, and your sign-off certifies the DCO for it as
for any other change.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
