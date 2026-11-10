<!-- SPDX-License-Identifier: MIT -->

# Test quarantine

`quarantine.json` is MIT-licensed data. JSON cannot carry a comment header; this
schema note supplies its SPDX license declaration without changing the array shape.
The ledger tracks the reader EOF/close-gate race under full-suite load, a CLI
version warm-up stall, headless-focus failures on macOS, Vitest full-suite
timeouts, and a host-requested kill that can lose its exit status on slower
runners. The reader test retains its bounded waits while the public issue tracks
the remaining race.
The deferred scheduler proof is unwritten and remains an explicit skip with a
reason, rather than a quarantine of a failing test.

Each entry has four required strings:

- `id`: `vitest:repo/path.test.ts#suite > test`,
  `playwright:tests/path.spec.ts#suite > test`, or
  `cargo:crate::module::test_name`. Titles include every enclosing suite, in order.
- `reason`: the failure and why the test cannot run reliably yet, public-safe.
- `issue`: exactly `https://github.com/<owner>/<repo>/issues/<number>`, an open public issue in the
  ledger's issue repository (see below).
- `added`: a UTC date in `YYYY-MM-DD` format. Quarantine expires after 30 days.

Run `node --test scripts/check-quarantine.node-test.mjs` (also included in
`pnpm test:node-scripts`). The check rejects missing/placeholder URLs and expired
entries. The public CI quarantine job also queries each issue using a read-only GitHub
issues token and requires `OPEN`; closed issues and API errors fail that job.
The gate, runners and frame-security guard all read
`QUARANTINE_ISSUE_REPOSITORY`, defaulting to `codesensehq/codesense`. Public CI
uses that code default everywhere and does not read a repository-variable override.
The environment variable remains available for a local override; Node validation
and runner filtering use the same default. The workflow relies on Node validation
before checking whether each issue is open.
`GITHUB_REPOSITORY` does not select the quarantine issue repository.

Vitest loads `support/quarantine-vitest.ts` from its setup: it prints the reason
and skips the matching test. Playwright specs import `test` from
`support/quarantine-playwright.ts` (the pane harness does this for its consumers).
Its hook prints the reason and calls `test.fixme(true, reason)`. Frame-security's
fixture guard accepts only ledger-backed fixme annotations with the exact reason;
unlisted skips and missing-fixture failures still fail the run.

The inventory check verifies each Vitest/Playwright entry names an existing file.
Cargo IDs start with the library's `[lib].name` (or its package name with hyphens
replaced by underscores when no library name is set); binary and integration-test
IDs use their Cargo target name. Follow that with the Rust module path and function
name. The inventory follows conventional and `#[path]` modules and checks Cargo
attributes and ledger entries in both directions, including identical issue URLs.
Macro-generated/include-generated quarantine markers must be made explicit in a
resolved source module; unresolved markers fail the check.

Cargo does not load JSON at runtime. Add a matching ledger entry and mark the
Rust test `#[ignore = "quarantine: <issue>"]`. Cargo prints that reason; use
`cargo test -- --ignored` to run quarantined tests deliberately. Remove both the
attribute and ledger entry when fixed. Never silently retry or delete a red test.

These adapters skip the test body, not `beforeAll` or worker fixtures. Those may
already have run before a per-test skip; fixture failures still fail the run.
Hostile-frame security tests (`tests/frame-security/hostile.spec.ts`) may never be
quarantined. Runners treat invalid or expired entries as unlisted.

`vitest.harness.config.ts` inherits the default setup. The separate `site/vitest.*`
configs do not: they belong to the website toolchain and need an explicit setup
adapter before website entries can be quarantined. Other Playwright suites must
import the adapter too; the frame-security specs and pane harness already do.

## One visible retry for Rust tests in CI

The nextest `ci` profile (`.config/nextest.toml`) retries every failed Rust test once in
CI. That retry is allowed because it is visible and tracked; silent retries stay banned.
This rule covers the Rust suite only, and local `pnpm test:rust` passes `--retries 0`.
Playwright's retries are existing, separate exceptions: `playwright.config.ts` retries
twice in CI, the website's Playwright config retries once in CI, and its staging project
retries once everywhere, local runs included.

- **Visible:** a test that passes only on its retry is FLAKY. Each Rust job lists its flaky
  tests in the job summary with a warning annotation, and nextest records the failed attempt
  as `flakyFailure` (or `flakyError`) in the uploaded JUnit report. A test that fails both
  attempts fails the job as before.
- **Tracked:** on the nightly run on `main` only, the `flaky-issues` job in `rust.yml` reads
  the JUnit reports and runs `node scripts/flaky-tests.mjs track`. It keeps one public issue per test,
  labelled `flaky-test` and found by the marker `<!-- flaky:<key> -->` in its body. A first
  flake opens the issue, a repeat comments with the run link and date, and a repeat after the
  issue was closed reopens it. Keep the label and the marker line. Pull requests, merge
  queue runs and forks never write issues; that job alone has `issues: write`, and the test
  jobs stay read-only. A flake seen only on a pull request or in the merge queue shows in
  that job's summary, but is tracked only if it recurs on a nightly run. One tracking run
  goes at a time. GitHub keeps one more waiting and cancels any older waiting run, whose
  flakes then go untracked; a test that keeps flaking is tracked on its next flake.
- **Key:** `<key>` is `cargo:<binary-id>#<test>`: nextest's binary id, `#`, then the test's
  module path and name. The `#` keeps a library test and an integration-test target with
  the same path apart (`pkg#foo::bar` against `pkg::foo#bar`). The ledger id names the same
  test differently, with `::` throughout, and every ledger crate name uses `_` for `-`:
  - a library test: the binary id is the package name (`my-crate`); the ledger id starts
    with the library name (`cargo:my_crate::module::test`);
  - an integration test: the binary id is `<package>::<target>`; the ledger id starts with
    the target name (`cargo:<target>::module::test`);
  - a binary target's own tests: the binary id is `<package>::bin/<name>`; the ledger id
    starts with the binary's target name (`cargo:<name>::module::test`).

  A binary id or test name with any character other than ASCII letters and digits and
  `_ . : / -` is keyed `cargo:sha256-<16 hex>` (a hash of `<binary-id>#<test>`) and shown
  with each such character replaced by `_`; its warning points to the JUnit report for the
  exact name.

- **Deadline:** the 30-day window starts when the issue first opens. A comment or a reopen
  does not restart it. By the deadline, either make the test pass deterministically and
  close the issue, or quarantine it: add a ledger entry and the `#[ignore]` attribute
  described above, both naming this issue. A test that flakes again after its issue was
  closed past the deadline must be fixed or quarantined at once.
