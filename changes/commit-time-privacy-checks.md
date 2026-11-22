---
type: privacy
---

**Commits are checked when they are made.** With the privacy hooks installed, a commit to a clone with a public remote is refused when its message or the lines and paths it adds match the privacy rules, and a maintainer clone also checks the author, sign-off, co-author trailers and signing config; each refusal names the rule, where it is and how to fix it, without printing the match or a file name (`CODESENSE_PRIVACY_SHOW=1` prints both, for local use only).
