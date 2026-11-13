// SPDX-License-Identifier: MIT
/** One table for the nav filter's matching rule. `navTextMatches` (nav-ordering.ts) and the
 *  files-tree pane's own `textMatches` each run it, so the two copies cannot drift apart. */
export const NAV_TEXT_MATCH_CASES: { name: string; query: string; text: string; matches: boolean }[] =
  [
    { name: "ignores case", query: "demo", text: "DEMO-12", matches: true },
    { name: "trims the query", query: "  demo-12 ", text: "Demo-12", matches: true },
    { name: "matches inside the text", query: "o-1", text: "demo-12", matches: true },
    { name: "lower-cases non-ASCII on both sides", query: "ÉCOLE", text: "école", matches: true },
    { name: "rejects a different text", query: "nope", text: "demo-12", matches: false },
  ];
