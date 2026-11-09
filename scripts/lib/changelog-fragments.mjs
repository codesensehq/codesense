// SPDX-License-Identifier: MIT
// Changelog fragments: each pull request adds changes/<slug>.md instead of editing
// CHANGELOG.md, so parallel pull requests never touch the same lines. A fragment is
//
//   ---
//   type: fixed
//   ---
//   **Short lead.** One line for the people who use CodeSense.
//
// assembleChangelog folds the fragments into CHANGELOG.md's [Unreleased] section (or,
// with a version, into a new release section) in a stable order.
import fs from "node:fs";
import path from "node:path";

export const FRAGMENT_DIR = "changes";
// Keep a Changelog's order, with this project's Privacy section before Security.
export const TYPES = ["added", "changed", "deprecated", "removed", "fixed", "privacy", "security"];
const NOT_FRAGMENTS = new Set(["README.md", ".gitkeep"]);
const SLUG = /^[a-z0-9][a-z0-9-]*\.md$/;

const heading = (type) => type[0].toUpperCase() + type.slice(1);

// The fragment files in dir, sorted by name (the order entries take within a section).
export function fragmentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !NOT_FRAGMENTS.has(name))
    .sort();
}

// Parses one fragment. Returns { type, entry } or { error }.
export function parseFragment(name, text) {
  if (!SLUG.test(name))
    return { error: `${name}: name must be lowercase letters, digits and hyphens, ending .md` };
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) return { error: `${name}: must start with front matter between --- lines` };
  const fields = match[1].split("\n").filter((line) => line.trim());
  const type = /^type:\s*([a-z]+)\s*$/.exec(fields[0] ?? "")?.[1];
  if (fields.length !== 1 || !type)
    return { error: `${name}: front matter must be exactly one line, type: <type>` };
  if (!TYPES.includes(type))
    return { error: `${name}: type must be one of ${TYPES.join(", ")} (got ${type})` };
  const lines = match[2].split("\n").filter((line) => line.trim());
  if (lines.length !== 1) return { error: `${name}: the entry must be exactly one line` };
  const entry = lines[0].trim().replace(/^[-*]\s+/, "");
  if (!entry || entry.startsWith("#")) return { error: `${name}: the entry must be a sentence` };
  return { type, entry };
}

// Reads and parses every fragment in dir. Returns { fragments, errors }.
export function readFragments(dir) {
  const fragments = [];
  const errors = [];
  for (const name of fragmentFiles(dir)) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) {
      errors.push(`${name}: must be a file`);
      continue;
    }
    const parsed = parseFragment(name, fs.readFileSync(file, "utf8"));
    if (parsed.error) errors.push(parsed.error);
    else fragments.push({ name, ...parsed });
  }
  return { fragments, errors };
}

// Splits a section body into its prose (before the first ###) and its ### subsections, in order.
function parseSection(body) {
  const parts = body.split(/^(?=### )/m);
  const prose = parts[0].startsWith("### ") ? "" : parts.shift();
  const subsections = parts.map((part) => {
    const newline = part.indexOf("\n");
    const title = (newline < 0 ? part : part.slice(0, newline)).slice(4).trim();
    const items = (newline < 0 ? "" : part.slice(newline + 1)).trim();
    return { title, items: items ? items.split("\n") : [] };
  });
  return { prose: prose.trim(), subsections };
}

function renderSection({ prose, subsections }) {
  const known = TYPES.map(heading);
  const ordered = [
    ...known.map((title) => subsections.find((s) => s.title === title)).filter(Boolean),
    ...subsections.filter((s) => !known.includes(s.title)),
  ].filter((s) => s.items.length);
  const blocks = [];
  if (prose) blocks.push(prose);
  for (const s of ordered) blocks.push(`### ${s.title}\n\n${s.items.join("\n")}`);
  return blocks.join("\n\n");
}

// Folds fragments into the changelog text. With version (and date), the [Unreleased] content
// becomes "## [version] - date" under a fresh, empty [Unreleased]. Returns the new text.
export function assembleChangelog(changelog, fragments, { version, date } = {}) {
  const start = changelog.search(/^## \[Unreleased\][^\n]*\n/m);
  if (start < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const bodyStart = changelog.indexOf("\n", start) + 1;
  const next = changelog.slice(bodyStart).search(/^## |^\[[^\]]+\]: /m);
  const end = next < 0 ? changelog.length : bodyStart + next;

  const section = parseSection(changelog.slice(bodyStart, end));
  for (const type of TYPES) {
    const entries = fragments.filter((f) => f.type === type).map((f) => `- ${f.entry}`);
    if (!entries.length) continue;
    let sub = section.subsections.find((s) => s.title === heading(type));
    if (!sub) section.subsections.push((sub = { title: heading(type), items: [] }));
    sub.items.push(...entries);
  }
  const body = renderSection(section);

  const head = changelog.slice(0, start);
  const tail = changelog.slice(end);
  let out;
  if (version) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
      throw new Error(`version must be X.Y.Z (got ${version})`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? ""))
      throw new Error(`date must be YYYY-MM-DD (got ${date})`);
    if (!body)
      throw new Error("nothing to release: [Unreleased] is empty and there are no fragments");
    if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(changelog))
      throw new Error(`CHANGELOG.md already has a ${version} section`);
    out = `${head}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n${tail}`;
    out = updateLinks(out, version);
  } else {
    out = `${head}## [Unreleased]\n\n${body ? `${body}\n\n` : ""}${tail}`;
  }
  return out.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

// Points [Unreleased] at the new tag and adds the new version's link below it.
function updateLinks(text, version) {
  const unreleased = /^\[Unreleased\]: (\S+)\/compare\/(\S+)\.\.\.HEAD$/m.exec(text);
  if (!unreleased) return text;
  const base = unreleased[1];
  return text.replace(
    unreleased[0],
    `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/releases/tag/v${version}`,
  );
}
