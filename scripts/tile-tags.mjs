// SPDX-License-Identifier: MIT
// Every tile spec runs on both engines and carries exactly one gate tag, checked over the full
// list rather than a grep run, which never sees an untagged or @nightly spec:
//   pnpm exec playwright test -c playwright.mock.config.ts --list --reporter=json \
//     --project=tiles-webkit --project=tiles-chromium > list.json
//   node scripts/tile-tags.mjs list.json
// @p0 blocks merge, @p1 blocks a release (tiles-release.yml), @nightly runs in nightly.yml.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const GATE_TAGS = ["@p0", "@p1", "@nightly"];
export const ENGINES = ["tiles-chromium", "tiles-webkit"];

// Each spec by its full title (file, describe blocks, title), with its tags and the projects that
// list it. Playwright reports a spec once per project, tags from the title and from `tag` alike.
function listedSpecs(report) {
  const specs = new Map();
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const key = [...titles, spec.title].join(" › ");
      const entry = specs.get(key) ?? { tags: new Set(), projects: new Set() };
      // The JSON reporter writes a tag without its @ (`p0` for `@p0`).
      for (const tag of spec.tags ?? []) entry.tags.add(tag.startsWith("@") ? tag : `@${tag}`);
      for (const run of spec.tests ?? []) entry.projects.add(run.projectName);
      specs.set(key, entry);
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, [file.file ?? file.title]);
  return specs;
}

export function tileTagErrors(report) {
  const errors = (report.errors ?? []).map(
    (error) => `could not list the tile specs: ${String(error.message ?? error).split("\n")[0]}`,
  );
  for (const [key, { tags, projects }] of listedSpecs(report)) {
    const gates = GATE_TAGS.filter((tag) => tags.has(tag));
    if (gates.length !== 1)
      errors.push(
        `${key}: needs exactly one gate tag (${GATE_TAGS.join(", ")}); has ${gates.join(", ") || "none"}`,
      );
    const listed = [...projects].sort();
    if (JSON.stringify(listed) !== JSON.stringify(ENGINES))
      errors.push(
        `${key}: listed for ${listed.join(", ")}${listed.length === 1 ? " only" : ""}; must run on both ${ENGINES.join(" and ")}`,
      );
  }
  return errors;
}

// A realpath guard keeps imports inert, including when /tmp is a symlink on macOS.
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node scripts/tile-tags.mjs <list.json>");
    const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const errors = tileTagErrors(report);
    for (const error of errors) console.error(error);
    if (!errors.length) {
      const count = listedSpecs(report).size;
      console.log(
        count
          ? `tile-tags: ${count} spec${count === 1 ? "" : "s"} on both engines, each with one gate tag`
          : "tile-tags: no tile specs yet",
      );
    }
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
