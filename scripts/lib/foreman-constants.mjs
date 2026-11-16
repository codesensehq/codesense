// SPDX-License-Identifier: MIT
// The Foreman's ids the app keeps its own copies of (the overlay's agent, role, team and history,
// the launch grant's agents) checked against the pack's config, the one source of them.
// `foreman-page.mjs --check` (`check:foreman-page`) runs it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const PACK = "codesense-docs/packs/codesense-foreman";
const OPEN = "src/features/foreman/open-foreman.ts";
const THREAD = "src/features/foreman/use-foreman-thread.ts";
const DOCS = "src/shared/lib/codesense-docs.ts";
const LAUNCH = "src-tauri/src/verbs/foreman_launch.rs";
const CONFIG = `${PACK}/story-view.yml`;
const PACK_YML = `${PACK}/pack.yml`;
export const CONSTANT_FILES = [OPEN, THREAD, DOCS, LAUNCH, CONFIG, PACK_YML];

/** The string or number a `NAME = <value>` (TS) or `NAME: &str = <value>` (Rust) line holds. */
function constant(text, name) {
  const found = new RegExp(`\\b${name}(?::\\s*&str)?\\s*=\\s*("([^"]*)"|\\d+)`).exec(text);
  if (!found) return undefined;
  return found[2] ?? Number(found[1]);
}

export function constantProblems(root) {
  const missing = CONSTANT_FILES.filter((rel) => !existsSync(join(root, rel)));
  if (missing.length) return missing.map((rel) => `${rel}: missing`);
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const foreman = parse(read(CONFIG))?.foreman ?? {};
  const out = [];
  const open = read(OPEN);
  const agent = constant(open, "FOREMAN_AGENT");
  const role = constant(open, "FOREMAN_ROLE");
  if (role !== foreman.role)
    out.push(
      `${OPEN}: FOREMAN_ROLE ${JSON.stringify(role)} is not the pack's foreman.role ${JSON.stringify(foreman.role)}`,
    );
  // isForemanAgent matches the bare id or a key ending in `/<id>`; it must keep that rule, and
  // every agent the pack launches must be one it matches.
  if (!open.includes("id === FOREMAN_AGENT") || !open.includes("id.endsWith(`/${FOREMAN_AGENT}`)"))
    out.push(`${OPEN}: isForemanAgent no longer matches a key ending in /FOREMAN_AGENT`);
  for (const id of foreman.agents ?? [])
    if (id !== agent && !String(id).endsWith(`/${agent}`))
      out.push(
        `${OPEN}: isForemanAgent does not match the pack's agent ${JSON.stringify(id)} (FOREMAN_AGENT ${JSON.stringify(agent)})`,
      );
  const parts = (parse(read(PACK_YML))?.parts ?? [])
    .filter((p) => p.kind === "agent")
    .map((p) => p.id);
  if (!parts.includes(agent))
    out.push(`${OPEN}: FOREMAN_AGENT ${JSON.stringify(agent)} is not an agent part of ${PACK_YML}`);
  const history = constant(read(THREAD), "FOREMAN_HISTORY");
  if (history !== foreman.history)
    out.push(
      `${THREAD}: FOREMAN_HISTORY ${history} is not the pack's foreman.history ${foreman.history}`,
    );
  const thread = read(THREAD);
  const docs = read(DOCS);
  const team = {
    org: constant(docs, "CODESENSE_DOCS_SLUG"),
    team: constant(docs, "CODESENSE_DOCS_TEAM"),
  };
  if (
    !/FOREMAN_TEAM: InboxTeam = \{ org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM \}/.test(
      thread,
    ) ||
    team.org !== foreman.docs?.org ||
    team.team !== foreman.docs?.team
  )
    out.push(
      `${THREAD}: FOREMAN_TEAM ${team.org}/${team.team} is not the pack's foreman.docs ${foreman.docs?.org}/${foreman.docs?.team}`,
    );
  const launch = read(LAUNCH);
  const key = constant(launch, "FOREMAN_KEY");
  if (key !== foreman.agents?.[0])
    out.push(
      `${LAUNCH}: FOREMAN_KEY ${JSON.stringify(key)} is not the pack's foreman.agents[0] ${JSON.stringify(foreman.agents?.[0])}`,
    );
  if (!/pub const AGENTS: &\[&str\] = &\[FOREMAN_KEY\b/.test(launch))
    out.push(`${LAUNCH}: AGENTS does not start with FOREMAN_KEY, the Foreman the pack launches`);
  return out;
}
