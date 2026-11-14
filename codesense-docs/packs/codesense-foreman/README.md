<!-- SPDX-License-Identifier: MIT -->

# The Foreman pack

The agent (`foreman.md`, `agents/`, `variants.yml`, `pack.yml`) and the page the app opens for it.

## The page

`getting-started/content/foreman/index.html` is one self-contained file: a vendored build of the
story view kit with its config inlined, a `story-view:foreman` meta and the capabilities it
declares (`sessions:read inbox:read:team inbox:write context:read launch machines:read`). It loads
no sibling script or style, so its hash covers everything it runs.

The app lets a page open a `team-workspace` agent only when the page holds the `foreman.launch`
grant, which it never declares. The app mints it from the page's own bytes: the file must sit at
its path in the placed docs checkout and hash to its entry in `PAGES`
(`src-tauri/src/verbs/foreman_launch.rs`). A page edited by one byte, or a copy anywhere else,
holds nothing. A page that holds it may launch only `foreman-claude` and `guide-claude`.

| File                       | What it is                                                                |
| -------------------------- | ------------------------------------------------------------------------- |
| `vendor/story-view.js`     | The kit build, first line `// vendored story-view build kit-rev:<n> sha256:<hex>` (the hash of the rest of the file) |
| `story-view.yml`           | The public config the kit is built with: product ids only                 |
| `pack.yml` `kit:`          | The vendored file's name, `kit_rev` and sha256                            |
| `../../getting-started/content/foreman/index.html` | The page: the template in `scripts/foreman-page.mjs` with the vendored build inlined |
| `PAGES` in `foreman_launch.rs` | The page's path and sha256, which the grant reads                     |

## The drift check

`pnpm check:foreman-page` (also part of `pnpm gen:docs:check`) fails when:

- the vendored file's header hash is not the hash of its contents, or `pack.yml` records another
  hash or `kit_rev`;
- the config baked into the kit differs from `story-view.yml`, the config has a budget or point
  key or a team's id;
- the vendored kit keeps a comment other than its config markers, or names a tracker story id, a
  local path, a path in the kit's own repository or a source file's hash;
- the page is not exactly the template with the vendored build inlined;
- the page's hash is not its `PAGES` entry, there is no entry, or the docs bundle ships other bytes
  than the page. A docs update that changed the page without the entry would otherwise drop the
  grant without a sound.

`scripts/foreman-page.node-test.mjs` plants each drift and expects it to fail.

## Re-vendoring the kit

The kit is built in its own repository, from a merged commit, with the public config.

1. In a checkout of the kit at the commit you are vendoring, copy this folder's `story-view.yml`
   over the kit's `story-view.yml` (in a scratch copy, never committed there), run
   `node build.mjs`, and run the kit's tests and `node check.mjs` on that build. `check.mjs`
   compares the kit's dashboard manifest with its team value, so point that value at the public
   config's `team` for the run.
2. In a worktree of this repository:

   ```sh
   node scripts/foreman-page.mjs --vendor <the built story-view.js> --kit-rev <n>
   ```

   This drops the build's comments (they describe the kit's own source tree; a parser finds them,
   and the step fails if the code changed), writes `vendor/story-view.js` with
   its header, updates the `kit:` block in `pack.yml`, rebuilds the page and writes the page's new
   hash into its `PAGES` entry. `<n>` is the kit's `template` number from its config; raise it when
   the kit's own changelog says its page contract changed. `--write` alone rebuilds the page from
   the vendored file.
3. Run `pnpm check:foreman-page` and `node --test scripts/foreman-page.node-test.mjs`. Commit the
   vendored file, `pack.yml`, the page and `foreman_launch.rs` together. A change to the page's
   declared capabilities is an edit to `CAPABILITIES` in `scripts/foreman-page.mjs`, then `--write`.
4. Record which kit commit went public, and its `kit_rev`, in the kit's own changelog. The pull
   request here names neither the kit's repository nor its commit.
