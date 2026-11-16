// SPDX-License-Identifier: MIT
// The `{{launch_parent}}` token in Claude file rules, expanded the way a launch does it
// (`permissions::expand_launch_parent` in src-tauri/src/agents/permissions.rs). Both read
// src-tauri/src/agents/testdata/launch_parent_cases.json, so the two never drift.

/** The launch-time token a Claude file rule's path may start with. */
export const LAUNCH_PARENT_TOKEN = "{{launch_parent}}";

const LISTS = ["allow", "deny", "ask"];
const FILE_TOOLS = ["Read", "Edit", "Write", "NotebookEdit"];
const RULE_SYNTAX_CHARS = ["(", ")", "\\"];
const GLOB_CHARS = ["*", "?", "[", "]", "{", "}"];

/**
 * The parent of launch folder `cwd` without its leading `/` ("" for `/`), or null when `cwd`
 * is not an absolute path with a parent and no `.`, `..` or empty segment. Never resolved.
 */
function launchParent(cwd) {
  if (!cwd.startsWith("/")) return null;
  const path = cwd.slice(1).replace(/\/+$/, "");
  const segments = path.split("/");
  if (path === "" || segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.slice(0, -1).join("/");
}

/** `rule` expanded, or the reason it can't be: "position", "cwd" or "parent". */
function expandRule(rule, parent, narrows) {
  let rest = null;
  for (const tool of FILE_TOOLS) {
    const head = `${tool}(//${LAUNCH_PARENT_TOKEN}`;
    if (rule.startsWith(head)) rest = rule.slice(head.length);
  }
  if (
    rest === null ||
    !(rest.startsWith("/") || rest === ")") ||
    !rest.endsWith(")") ||
    rest.includes(LAUNCH_PARENT_TOKEN)
  ) {
    return { reason: "position" };
  }
  if (parent === null) return { reason: "cwd" };
  const refused = [...RULE_SYNTAX_CHARS, ...(narrows ? [] : GLOB_CHARS)];
  if (refused.some((c) => parent.includes(c))) return { reason: "parent" };
  const head = rule.slice(0, rule.length - LAUNCH_PARENT_TOKEN.length - rest.length);
  // A parent of `/`: `//foreman-*`, never `///foreman-*`.
  if (parent === "" && rest.startsWith("/")) return { rule: head + rest.slice(1) };
  return { rule: head + parent + rest };
}

/**
 * Claude settings `settings` with each token rule expanded for a launch in `cwd`, and the
 * rules that were not (`{list, rule, dropped, reason}`). Fails closed: an allow that can't be
 * expanded, or whose parent holds a glob or rule character, is dropped; a deny or ask is
 * expanded unless the token is misplaced, `cwd` is unusable or the parent holds a rule
 * character, and is otherwise kept as written.
 */
export function expandLaunchParent(settings, cwd) {
  const parent = launchParent(cwd);
  const content = structuredClone(settings);
  const unexpanded = [];
  for (const list of LISTS) {
    const rules = content.permissions?.[list];
    if (!Array.isArray(rules)) continue;
    const narrows = list !== "allow";
    content.permissions[list] = rules.flatMap((rule) => {
      if (typeof rule !== "string" || !rule.includes(LAUNCH_PARENT_TOKEN)) return [rule];
      const expanded = expandRule(rule, parent, narrows);
      if (expanded.rule !== undefined) return [expanded.rule];
      unexpanded.push({ list, rule, dropped: !narrows, reason: expanded.reason });
      return narrows ? [rule] : [];
    });
  }
  return { content, unexpanded };
}

/** Whether any Claude rule in `settings` holds the token. */
export function holdsLaunchParent(settings) {
  return LISTS.some((list) => {
    const rules = settings.permissions?.[list];
    return (
      Array.isArray(rules) &&
      rules.some((r) => typeof r === "string" && r.includes(LAUNCH_PARENT_TOKEN))
    );
  });
}
