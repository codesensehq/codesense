// SPDX-License-Identifier: MIT
// The Exports guard (.github/workflows/exports-guard.yml): a pull request may not change a
// cargo-written export (FROZEN_EXPORTS) unless it is the refresh pull request, a same-repository
// `chore/refresh-exports` branch carrying the `exports-refresh` label. The workflow runs this file
// from the base commit with plain `node`, so a pull request cannot weaken the script that checks it,
// and reads everything about the pull request through the API. Dependency-free: no install runs.
// The checks the refresh route runs before it opens that pull request follow the guard.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FROZEN_EXPORTS } from "./lib/sealed-export.mjs";

export const REFRESH_BRANCH = "chore/refresh-exports";
export const REFRESH_LABEL = "exports-refresh";
export const GUARD_MESSAGE = "Leave generated exports out of your PR; maintainers refresh them.";
export const SEALED_EXPORT = "scripts/lib/sealed-export.mjs";
// The pull request files API lists at most 3000 files; a list that reaches it may be truncated.
export const FILES_CAP = 3000;
const PAGE = 100;

// The frozen paths a pull request's files touch, on either side of a rename, for every status
// (added, modified, removed, renamed, copied, changed).
export function frozenChanges(files, frozen = FROZEN_EXPORTS) {
  const set = new Set(frozen);
  const touched = new Set();
  for (const file of files)
    for (const path of [file.filename, file.previous_filename])
      if (typeof path === "string" && set.has(path)) touched.add(path);
  return [...touched].sort();
}

// FROZEN_EXPORTS as the head commit's sealed-export.mjs writes it, read without running it: one
// `const GENERATED = "<path>";` and one `export const FROZEN_EXPORTS = Object.freeze([...]);` whose
// entries are each a plain double-quoted string or `${GENERATED}/<path>`. Anything else is null,
// which the guard counts as a changed list.
export function parseFrozenList(source) {
  if (typeof source !== "string") return null;
  const generated = [...source.matchAll(/^const GENERATED = "([^"\\$`]*)";$/gm)];
  const declared = [
    ...source.matchAll(/^export const FROZEN_EXPORTS = Object\.freeze\(\[\n([^\]]*)\]\);$/gm),
  ];
  if (generated.length !== 1 || declared.length !== 1) return null;
  if ((source.match(/\bGENERATED\s*=/g) ?? []).length !== 1) return null;
  if ((source.match(/\bFROZEN_EXPORTS\s*=/g) ?? []).length !== 1) return null;
  const entries = [];
  for (const line of declared[0][1].split("\n")) {
    if (!line.trim()) continue;
    const plain = /^ {2}"([^"\\$`]+)",$/.exec(line);
    const prefixed = /^ {2}`\$\{GENERATED\}\/([^"\\$`]+)`,$/.exec(line);
    if (plain) entries.push(plain[1]);
    else if (prefixed) entries.push(`${generated[0][1]}/${prefixed[1]}`);
    else return null;
  }
  return entries.length ? entries : null;
}

// Same order, same paths.
export const sameList = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// The refresh pull request: the `chore/refresh-exports` branch of this repository (a fork, or a
// deleted fork's null head.repo, never is) with the `exports-refresh` label. The label alone never is.
export function isRefreshPr(pr, repository) {
  return (
    pr?.head?.ref === REFRESH_BRANCH &&
    typeof pr.head.repo?.full_name === "string" &&
    pr.head.repo.full_name === repository &&
    pr.base?.repo?.full_name === repository &&
    Array.isArray(pr.labels) &&
    pr.labels.some((label) => label?.name === REFRESH_LABEL)
  );
}

// The pull request a merge group is for: `refs/heads/gh-readonly-queue/main/pr-<n>-<sha>`, or the
// same without `refs/heads/`. Null for anything else.
export function parseQueueRef(ref) {
  const match =
    typeof ref === "string" &&
    /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-([1-9]\d*)-[0-9a-f]{40}$/.exec(ref);
  return match ? Number(match[1]) : null;
}

// Every file the pull request changes, page by page. Fails closed on a page error (the request
// throws), on a list that reaches the API's cap, and on a count other than the PR's changed_files.
export async function listFiles(request, repository, number, changedFiles) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await request(
      `repos/${repository}/pulls/${number}/files?per_page=${PAGE}&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error(`exports guard: file list page ${page} is not a list`);
    files.push(...batch);
    if (files.length >= FILES_CAP)
      throw new Error(
        `exports guard: the pull request changes ${FILES_CAP} or more files, past what the API lists`,
      );
    if (batch.length < PAGE) break;
  }
  if (files.length !== changedFiles)
    throw new Error(
      `exports guard: the file list has ${files.length} files but the pull request reports ${changedFiles}`,
    );
  return files;
}

// The head commit's FROZEN_EXPORTS, parsed (null when unreadable or gone from that path).
async function headFrozenList(request, repository, files, headSha) {
  const removed = files.some(
    (file) =>
      (file.filename === SEALED_EXPORT && file.status === "removed") ||
      (file.previous_filename === SEALED_EXPORT && file.filename !== SEALED_EXPORT),
  );
  if (removed) return null;
  const body = await request(`repos/${repository}/contents/${SEALED_EXPORT}?ref=${headSha}`);
  if (body?.encoding !== "base64" || typeof body.content !== "string") return null;
  return parseFrozenList(Buffer.from(body.content, "base64").toString("utf8"));
}

// The guard's verdict for one event. `request(path)` returns the parsed JSON of a GitHub API path
// and throws on anything but success; every failure to read fails the guard.
export async function runGuard({
  eventName,
  payload,
  repository,
  request,
  frozen = FROZEN_EXPORTS,
}) {
  let number;
  let headSha;
  if (eventName === "pull_request") {
    number = payload?.pull_request?.number;
    headSha = payload?.pull_request?.head?.sha;
    if (!Number.isInteger(number) || typeof headSha !== "string")
      throw new Error("exports guard: the pull_request event has no number or head sha");
  } else if (eventName === "merge_group") {
    const ref = payload?.merge_group?.head_ref;
    number = parseQueueRef(ref);
    if (number === null) throw new Error(`exports guard: cannot read the queue ref ${ref}`);
  } else throw new Error(`exports guard: unexpected event ${eventName}`);

  const pr = await request(`repos/${repository}/pulls/${number}`);
  if (eventName === "pull_request") {
    if (pr?.head?.sha !== headSha)
      throw new Error(
        `exports guard: pull request #${number} is at ${pr?.head?.sha}, not the event's ${headSha}; re-run`,
      );
  } else {
    // The queue merges the entry as a merge commit whose second parent is the PR's head.
    const groupSha = payload.merge_group.head_sha;
    if (typeof groupSha !== "string")
      throw new Error("exports guard: the merge_group event has no head sha");
    const group = await request(`repos/${repository}/commits/${groupSha}`);
    const parent = group?.parents?.[1]?.sha;
    if (typeof parent !== "string" || parent !== pr?.head?.sha)
      throw new Error(
        `exports guard: the merge group's second parent ${parent} is not pull request #${number}'s head ${pr?.head?.sha}`,
      );
    headSha = parent;
  }
  if (!Number.isInteger(pr.changed_files))
    throw new Error(`exports guard: pull request #${number} reports no changed_files`);

  const files = await listFiles(request, repository, number, pr.changed_files);
  const touched = frozenChanges(files, frozen);
  if (files.some((f) => f.filename === SEALED_EXPORT || f.previous_filename === SEALED_EXPORT)) {
    const head = await headFrozenList(request, repository, files, headSha);
    if (!sameList(head, frozen)) touched.push(`${SEALED_EXPORT} (FROZEN_EXPORTS)`);
  }
  const refresh = isRefreshPr(pr, repository);
  return { number, refresh, touched, ok: touched.length === 0 || refresh };
}

// dco-check's request shape: the token from the environment, and a failure on anything but OK.
export const githubRequest =
  (env = process.env, fetchImpl = fetch) =>
  async (path) => {
    const api = env.GITHUB_API_URL || "https://api.github.com";
    const response = await fetchImpl(`${api}/${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GH_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok)
      throw new Error(`exports guard: cannot read ${path}: HTTP ${response.status}`);
    return response.json();
  };

// The refresh route. The maintainers' refresh command opens the refresh pull request from a
// regenerate run's artifacts, calling these checks from a checkout of main; they live here so
// they are tested with the guard they feed.
export const UPSTREAM = "codesensehq/codesense";
export const REGENERATE_WORKFLOW = ".github/workflows/regenerate-exports.yml";
export const REGENERATE_ALL = "Regenerate exports (all)";
const DISPATCH = "dispatch an all run on main (gh workflow run regenerate-exports.yml --ref main)";

// A run whose artifacts may become the refresh pull request: a successful scheduled or dispatched
// all run of the regenerate workflow, on main of this repository, whose commit `onMain(sha)` finds
// on main's history (a dispatch on a tag named main also reports head_branch main). The run name
// is the only place a dispatch's input shows, so a single-export run is never trusted.
export function trustedRun(run, onMain) {
  return (
    run?.path === REGENERATE_WORKFLOW &&
    run.head_branch === "main" &&
    run.head_repository?.full_name === UPSTREAM &&
    ["schedule", "workflow_dispatch"].includes(run.event) &&
    run.conclusion === "success" &&
    run.display_title === REGENERATE_ALL &&
    typeof run.head_sha === "string" &&
    /^[0-9a-f]{40}$/.test(run.head_sha) &&
    onMain(run.head_sha) === true
  );
}

const newest = (runs) =>
  [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];

// The manifest's paths, or null unless it is a sorted JSON array of distinct non-empty strings.
function manifestPaths(text) {
  let paths;
  try {
    paths = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path))
    return null;
  const sorted = [...new Set(paths)].sort();
  return sameList(paths, sorted) ? paths : null;
}

// What to do with the regenerate runs `trustedRun` accepted. Takes the newest and never an older
// one; `artifacts` are that run's, `manifest` the text of its exports-manifest.json, `gap` how far
// main is ahead of it ({ahead, age}) and `applied` the run ids main's Exports-run trailers name.
// Returns {action, run, ...}: `refuse` (with a reason), `already-applied`, `fresh` (an empty
// manifest at main's tip), `stale-run` (an empty manifest behind main: nothing says main is fresh)
// or `refresh` (with the manifest's paths). Fresh is never inferred from a missing artifact.
export function chooseRun({ runs, artifacts, manifest, mainSha, gap, applied = [] }) {
  const run = newest(runs ?? []);
  if (!run) return { action: "refuse", reason: `no trusted regenerate run; ${DISPATCH}` };
  if (applied.map(String).includes(String(run.id))) return { action: "already-applied", run };
  const gapText = `run ${run.id} at ${run.head_sha}, ${gap?.age} old; main is ${gap?.ahead} commits ahead`;
  const usable = (name) => {
    const found = (artifacts ?? []).filter((a) => a?.name === name);
    if (found.length !== 1 || found[0].workflow_run?.id !== run.id)
      return `run ${run.id} has no ${name} artifact of its own; ${DISPATCH}`;
    if (found[0].expired) return `run ${run.id}'s ${name} artifact has expired; ${DISPATCH}`;
    return null;
  };
  const noManifest = usable("exports-manifest");
  if (noManifest) return { action: "refuse", run, reason: noManifest };
  const paths = manifestPaths(manifest);
  if (!paths)
    return {
      action: "refuse",
      run,
      reason: `run ${run.id}'s manifest is not a sorted JSON array of distinct paths`,
    };
  if (!paths.length)
    return run.head_sha === mainSha
      ? { action: "fresh", run }
      : {
          action: "stale-run",
          run,
          gap: gapText,
          reason: `run ${run.id} found nothing to refresh, but main has moved on; ${DISPATCH}`,
        };
  const noExports = usable("generated-exports");
  if (noExports) return { action: "refuse", run, reason: noExports };
  return { action: "refresh", run, paths, gap: gapText };
}

const unsafePath = (path) =>
  typeof path !== "string" ||
  !path ||
  path.startsWith("/") ||
  path.includes("\\") ||
  /^[A-Za-z]:/.test(path) ||
  path.split("/").some((part) => part === "" || part === "." || part === "..");

// Why the downloaded generated-exports artifact may not go into the refresh branch. `files` are
// its entries ({path, type}, type from lstat: "file", "symlink", ...), `manifest` the run's
// parsed manifest, `frozen` the branch's FROZEN_EXPORTS and `genDocsChanged` the paths the
// branch's own `pnpm gen:docs` changed. The artifact must hold exactly the manifest's files, each
// a frozen export or a file gen:docs also changed here, and gen:docs may change nothing the
// artifact lacks: the seat's environment never rides in, and nothing else does either.
export function artifactProblems({ files, manifest, frozen, genDocsChanged }) {
  const found = [];
  const inArtifact = new Set(files.map((file) => file.path));
  const listed = new Set(manifest);
  const frozenSet = new Set(frozen);
  const changed = new Set(genDocsChanged);
  for (const file of files) {
    if (unsafePath(file.path)) found.push(`${file.path}: unsafe path`);
    if (file.type !== "file") found.push(`${file.path}: a ${file.type}, not a file`);
    if (!listed.has(file.path)) found.push(`${file.path}: in the artifact but not in the manifest`);
    if (!frozenSet.has(file.path) && !changed.has(file.path))
      found.push(`${file.path}: neither a frozen export nor written by gen:docs on this branch`);
  }
  for (const path of manifest) {
    if (unsafePath(path)) found.push(`${path}: unsafe path in the manifest`);
    if (!inArtifact.has(path)) found.push(`${path}: in the manifest but not in the artifact`);
  }
  for (const path of genDocsChanged)
    if (!inArtifact.has(path))
      found.push(`${path}: gen:docs changed it here but the artifact does not carry it`);
  return [...new Set(found)];
}

// The run id in a commit message's Exports-run trailer (its last paragraph), or null.
export function exportsRunTrailer(message) {
  const paragraphs = String(message ?? "")
    .trim()
    .split(/\n\s*\n/);
  const match = /^Exports-run: (\d+)$/m.exec(paragraphs.at(-1) ?? "");
  return match ? match[1] : null;
}

// Why the command may not open or update the refresh pull request. `branchTip` is the
// chore/refresh-exports tip ({sha, message}) or null, `openPr` its open pull request or null,
// `inQueue` whether that pull request is in the merge queue. A tip without an Exports-run trailer
// was pushed by hand (an export being added, or an Update branch merge): never overwritten.
export function refreshBranchProblems({ branchTip, openPr, inQueue }) {
  const found = [];
  if (openPr && inQueue)
    found.push(
      `pull request #${openPr.number} is in the merge queue; wait for it to merge or leave`,
    );
  if (openPr && !branchTip)
    found.push(`pull request #${openPr.number} is open but ${REFRESH_BRANCH} was not found`);
  if (branchTip && !exportsRunTrailer(branchTip.message))
    found.push(
      openPr
        ? `pull request #${openPr.number}'s tip ${branchTip.sha} has no Exports-run trailer; finish or close that pull request first, and delete the branch`
        : `${REFRESH_BRANCH} at ${branchTip.sha} has no Exports-run trailer and no open pull request; finish it or delete the branch first`,
    );
  return found;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const env = process.env;
    const result = await runGuard({
      eventName: env.GITHUB_EVENT_NAME,
      payload: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
      repository: env.GITHUB_REPOSITORY,
      request: githubRequest(env),
    });
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `refresh=${result.refresh}\n`);
    if (result.ok) {
      console.log(
        result.touched.length
          ? `exports guard: refresh pull request #${result.number} may change ${result.touched.join(", ")}`
          : `exports guard: pull request #${result.number} changes no generated export`,
      );
    } else {
      console.error(`exports guard: pull request #${result.number} changes generated exports:`);
      for (const path of result.touched) console.error(`  ${path}`);
      console.error(`::error::${GUARD_MESSAGE}`);
      process.exitCode = 1;
    }
  } catch (error) {
    // Fails closed: an unreadable pull request is never let through.
    console.error(`::error::${error.message}. ${GUARD_MESSAGE}`);
    process.exitCode = 1;
  }
}
