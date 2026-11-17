// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { compositeOver, contrastRatio, CONTRAST_THRESHOLDS } from "../shared/lib/color-contrast";
import { BUNDLED_THEMES, themeTokens, type AppTheme } from "./index";
import { kitRoles } from "./kit";

const themes = (Object.keys(BUNDLED_THEMES) as AppTheme[]).flatMap((id) =>
  (["light", "dark"] as const).map((mode) => [id, mode] as const),
);

it.each(themes)("%s/%s control borders contrast with the raised viewer surface", (id, mode) => {
  const tokens = themeTokens(id, mode);
  const roles = kitRoles("viewer");
  expect(
    contrastRatio(tokens[`--theme-${roles["border-control"]}`], tokens[`--theme-${roles.surface}`]),
  ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLDS.nonText);
});

/** The Chat | CLI switch in a tab's caption, on the caption's ground (the terminal surface). */
it.each(themes)("%s/%s the caption's Chat | CLI switch reads on the caption ground", (id, mode) => {
  const t = themeTokens(id, mode);
  const ground = t["--theme-surface-terminal-bg"];
  // The selected segment is the primary ink mixed 12% into the ground (inbox.css `.ibx-sw-seg`).
  const selected = compositeOver(`${t["--theme-text-terminal-primary"]}1f`, ground);
  const text = CONTRAST_THRESHOLDS.text;
  // One assertion per colour pair, at the strictest threshold of its uses.
  // The needs tone on the ground: the "Input needed" words, and the ring when the switch is icons only.
  expect(
    contrastRatio(t["--theme-status-terminal-needs"], ground),
    "needs on ground",
  ).toBeGreaterThanOrEqual(text);
  // The primary ink on the ground: the held-output dot (non-text) and the segment words.
  expect(
    contrastRatio(t["--theme-text-terminal-primary"], ground),
    "primary on ground",
  ).toBeGreaterThanOrEqual(text);
  // The muted ink on the ground: the unselected label and the key hint.
  expect(
    contrastRatio(t["--theme-text-terminal-muted"], ground),
    "muted on ground",
  ).toBeGreaterThanOrEqual(text);
  // The selected segment's label on its raised fill.
  expect(
    contrastRatio(t["--theme-text-terminal-primary"], selected),
    "selected label",
  ).toBeGreaterThanOrEqual(text);
  // The needs tone shows only on the CLI segment while the chat covers it: never on the selected fill.
});
