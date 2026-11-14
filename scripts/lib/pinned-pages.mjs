// SPDX-License-Identifier: MIT
// The docs pages the app hashes (`PAGES` in `foreman_launch.rs`): a page holds the
// `foreman.launch` grant only while its bytes match. Every docs step reads the list from here, so
// a page added there is left byte-exact by the bundle's metadata step and out of the API-skew scan.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productionPart, structTableConst } from "./rust.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const LAUNCH_RS = "src-tauri/src/verbs/foreman_launch.rs";
// `PAGES` paths are inside the placed docs checkout, which is this repository's `codesense-docs/`.
export const DOCS_ROOT = "codesense-docs";

/** The `PAGES` entries of `foreman_launch.rs` source, as `{path, sha256}`. */
export function launchPages(source) {
  return structTableConst(productionPart(source), "PAGES").map(({ path, sha256 }) => ({
    path,
    sha256,
  }));
}

/** The pinned pages' paths inside the docs checkout, read from this checkout's `foreman_launch.rs`. */
export function pinnedPages(root = ROOT) {
  return new Set(launchPages(readFileSync(join(root, LAUNCH_RS), "utf8")).map((page) => page.path));
}
