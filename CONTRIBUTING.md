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
- The other jobs lint, build and test the change.

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

### Before the long local checks

- Run `pnpm install` first, and do one check run at a time without starting
  another test runner or job queue from inside it.
- Run `pnpm gen:docs` before any Cargo step, and run the tests you changed
  quickly, without Cargo, before the long run.
- Leave at least 35 GB of free disk, stop if it drops under 20 GB, and delete
  `target/` when you are done. Build with the default features only.
- If a GitHub release download times out, retry it with `gh release download`
  and check it against its pinned checksum (the scanners' are in
  `release/scanners.lock`).

If a step fails on a clean checkout, please open an issue.

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

You're welcome to use AI tools for your own contributions. You remain
responsible for what you submit, and your sign-off certifies the DCO for it as
for any other change.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
