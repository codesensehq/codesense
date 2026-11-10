# Changelog entries

Don't edit `CHANGELOG.md` in a pull request. If users would notice your change,
add one file here instead, so pull requests merged in parallel never conflict:

```markdown
---
type: fixed
---

**Short lead.** One line for the people who use CodeSense.
```

- Name it `changes/<slug>.md`, using lowercase letters, digits and hyphens, for
  example `changes/machine-save-conflict.md`.
- `type` is one of `added`, `changed`, `deprecated`, `removed`, `fixed`,
  `privacy` or `security`. It picks the section the entry goes under.
- The entry is exactly one line. Write it the way the existing entries in
  `CHANGELOG.md` read.

`node scripts/changelog-lint.mjs` checks the format. If a pull request changes
the app but users won't notice, a maintainer adds the `no-changelog` label.

At release time, `node scripts/changelog-assemble.mjs --version X.Y.Z --date
YYYY-MM-DD` folds every fragment into `CHANGELOG.md`, ordered by section and
then by file name, and deletes them. Add `--dry-run` to print the result
without changing anything.
