// SPDX-License-Identifier: MIT
// New mock specs go under tests/e2e-mock/tiles/, where the tile jobs run them on both engines.
// A spec elsewhere must be in the mock layout job's hand list (read from tests.yml, not copied)
// or in the allowlist of older specs, which may only shrink against the base commit's copy:
//   node scripts/stray-specs.mjs [--base <sha>] [--root <repo>]
// With no base (a dispatched run) the tree is checked alone; a base with no allowlist takes this
// one as its seed. A line may name a spec that does not exist yet.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const ALLOWLIST = "tests/e2e-mock/stray-allowlist.txt";
export const HAND_LIST_STEP = "Run the mock layout specs";
const WORKFLOW = ".github/workflows/tests.yml";
const TILES = "tests/e2e-mock/tiles/";
const SPEC = /^tests\/e2e-mock\/\S+\.spec\.ts$/;

// The specs the hand-list step names, in any job. Renaming the step fails here, so the guard
// never passes on an empty hand list.
export function handList(workflowText) {
  const steps = Object.values(parse(workflowText)?.jobs ?? {}).flatMap((job) =>
    Array.isArray(job?.steps) ? job.steps.filter((step) => step?.name === HAND_LIST_STEP) : [],
  );
  if (steps.length !== 1)
    throw new Error(
      `${WORKFLOW}: no step named "${HAND_LIST_STEP}" (or more than one); the stray guard reads its hand list from it`,
    );
  const specs = String(steps[0].run ?? "")
    .split(/\s+/)
    .filter((word) => SPEC.test(word));
  if (!specs.length) throw new Error(`${WORKFLOW}: "${HAND_LIST_STEP}" lists no specs`);
  return specs;
}

export const parseAllowlist = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

export function strayErrors({ specs, handList, allowlist, baseAllowlist }) {
  const errors = [];
  const seen = new Set();
  for (const line of allowlist) {
    if (seen.has(line)) errors.push(`${line}: listed twice in ${ALLOWLIST}`);
    seen.add(line);
    if (baseAllowlist && !baseAllowlist.includes(line))
      errors.push(
        `${line}: the allowlist may only shrink; put a new spec under ${TILES} instead of adding it to ${ALLOWLIST}`,
      );
  }
  const listed = new Set([...handList, ...allowlist]);
  for (const spec of specs)
    if (!spec.startsWith(TILES) && !listed.has(spec))
      errors.push(
        `${spec}: a mock spec outside ${TILES}; move it there and tag it (tests/e2e-mock/README.md)`,
      );
  return errors;
}

function main(argv) {
  const option = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? "") : undefined;
  };
  const root = option("--root") || fileURLToPath(new URL("..", import.meta.url));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const exists = (spec) => {
    try {
      git("cat-file", "-e", spec);
      return true;
    } catch {
      return false;
    }
  };
  const specs = git("ls-files", "-z", ":(glob)tests/e2e-mock/**/*.spec.ts")
    .split("\0")
    .filter(Boolean);
  const allowlistPath = path.join(root, ALLOWLIST);
  const allowlist = fs.existsSync(allowlistPath)
    ? parseAllowlist(fs.readFileSync(allowlistPath, "utf8"))
    : [];
  // A push that creates a branch has an all-zero before; a dispatched run has none.
  const base = /^0*$/.test(option("--base") ?? "") ? "" : option("--base");
  let baseAllowlist = null;
  if (base) {
    if (!exists(`${base}^{commit}`))
      throw new Error(`stray-specs: base ${base} is not a commit in this checkout`);
    if (exists(`${base}:${ALLOWLIST}`))
      baseAllowlist = parseAllowlist(git("cat-file", "-p", `${base}:${ALLOWLIST}`));
  }
  const errors = strayErrors({
    specs,
    handList: handList(fs.readFileSync(path.join(root, WORKFLOW), "utf8")),
    allowlist,
    baseAllowlist,
  });
  for (const error of errors) console.error(error);
  if (errors.length) throw new Error(`stray-specs: ${errors.length} problem(s)`);
  console.log(
    `stray-specs: ${specs.length} mock specs, ${allowlist.length} allowlisted${
      base
        ? baseAllowlist
          ? ""
          : "; the base has no allowlist, so this one is the seed"
        : "; no base to compare"
    }`,
  );
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
