// SPDX-License-Identifier: MIT
// Shared by the two sealed Cargo exports (MCP reference, live-data contract).
import { execFileSync, spawnSync } from "node:child_process";

const GENERATED = "codesense-docs/getting-started/content/generated";
// The one list of cargo-written exports, for every reader. PRs leave these alone and maintainers
// refresh them; the files Node renders from them (mcp-tools.json, generated/schemas/*.schema.json,
// the routine-yml.html field rows, the html pages) stay editable in a PR.
export const FROZEN_EXPORTS = Object.freeze([
  `${GENERATED}/live-data-contract.json`,
  `${GENERATED}/live-data-contract.inputs.json`,
  `${GENERATED}/mcp-tools.default.json`,
  `${GENERATED}/mcp-tools.dashboard-publish.json`,
  `${GENERATED}/mcp-tools.inputs.json`,
  "src-tauri/src/docs_schemas.generated.json",
]);
// One export's frozen files: those named `<prefix>.*` or `<prefix>` itself.
export const frozenExport = (prefix) =>
  FROZEN_EXPORTS.filter((path) => path === prefix || path.startsWith(`${prefix}.`));

// `gen:docs:check:pr` sets the env var: the PR gate tolerates input-only and inherited drift,
// whether a PR left the exports alone or re-exported before main moved inputs it did not touch.
// Strict `gen:docs:check` (the wave) leaves it unset.
export const allowStaleExport = (argv = process.argv, env = process.env) =>
  argv.includes("--allow-stale-export") || env.DOCS_ALLOW_STALE_EXPORT === "1";

// The export pins (the Rust, Vitest and Node tests that compare a committed export with its
// source) compare strictly only with CS_STRICT_EXPORTS=1. PRs leave the cargo-written exports alone,
// so without it a stale export is a notice. The regenerate run and the nightly probe set it.
export const strictExports = (env = process.env) => env.CS_STRICT_EXPORTS === "1";

// The refresh command shown to the user, with the CI route for a checkout without a Rust build. A
// template literal stays on the `=` line at any length, so a longer or shorter command keeps the
// same formatting.
export const REFRESH_COMMAND = `pnpm docs:refresh-mcp (without a local Rust build: gh workflow run regenerate-exports.yml --ref <branch>)`;

const DEFAULT_MIN_FREE_GIB = 25;
const HARD_FLOOR_GIB = 20;

// The one disk gate for the sealed Cargo exports. Default 25 GiB free (inclusive),
// `CS_EXPORT_MIN_FREE_GB` overrides it, and no override goes below the 20 GiB hard floor.
// An invalid override is ignored with a warning. A `df` failure refuses.
export function diskGate(root, env = process.env) {
  const raw = env.CS_EXPORT_MIN_FREE_GB;
  let required = DEFAULT_MIN_FREE_GIB;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed) && parsed > 0) required = parsed;
    else
      console.warn(
        `WARNING: ignoring invalid CS_EXPORT_MIN_FREE_GB=${JSON.stringify(raw)}; using ${DEFAULT_MIN_FREE_GIB} GiB`,
      );
  }
  const floored = Math.max(required, HARD_FLOOR_GIB);
  const result = spawnSync("df", ["-k", root], { encoding: "utf8", env });
  const available = Number(result.stdout?.trim().split("\n").at(-1).trim().split(/\s+/)[3]);
  if (!Number.isFinite(available))
    throw new Error("Sealed export blocked: could not read free disk space from df");
  if (available < floored * 1024 * 1024) {
    const floorNote =
      required < HARD_FLOOR_GIB
        ? ` (${required} GiB override raised to the ${HARD_FLOOR_GIB} GiB hard floor)`
        : "";
    throw new Error(
      `Sealed export blocked: needs at least ${floored} GiB free${floorNote}; the ${HARD_FLOOR_GIB} GiB hard floor cannot be lowered. Set CS_EXPORT_MIN_FREE_GB to change the ${DEFAULT_MIN_FREE_GIB} GiB default.`,
    );
  }
}

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });

// The gate may only tolerate drift when this PR left every tracked export file (seal, payloads,
// manifest) byte-identical to its merge-base with origin/main (absent at both counts as
// identical). A PR that edits an export must pass the strict check, and drift then present is
// inherited: the seal/payload relationship is a pure function of those files. Two git spawns:
// committed changes since the merge-base (`origin/main...HEAD` errors without one), then the
// working tree against HEAD. Any git failure, a missing origin/main or a merge-base outside a
// shallow clone's history ⇒ false (strict). Never fetches.
export function exportsUntouchedSinceMain(root, exportFiles) {
  try {
    git(root, ["diff", "--quiet", "origin/main...HEAD", "--", ...exportFiles]);
    return git(root, ["status", "--porcelain", "--ignored", "--", ...exportFiles]).length === 0;
  } catch {
    return false;
  }
}

// A PR that re-exported is held to the strict check, yet main may since have changed inputs the
// PR never touched (another PR's tool edit). Then the PR's export matched its own inputs and the
// drift is main's, refreshed in the next docs wave like any inherited drift. True when the PR left
// every drifted input as it was at the merge-base (same rule as the exports, so never fetches).
export const driftInheritedFromMain = (root, driftedInputs) =>
  driftedInputs.length > 0 && exportsUntouchedSinceMain(root, driftedInputs);

const mergeBase = (root) => {
  try {
    return git(root, ["merge-base", "HEAD", "origin/main"]).toString().trim().slice(0, 10);
  } catch {
    return "merge-base";
  }
};

export const inheritedNotice = (root, message) =>
  `NOTICE: ${message} (inherited from origin/main at ${mergeBase(root)}; this PR does not change the sealed export)`;
