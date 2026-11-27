// SPDX-License-Identifier: MIT
/**
 * A stylesheet's top-level style rules as declarations, keyed by every selector in each rule's list.
 * At-rule blocks (@media, @keyframes, @supports) are skipped whole, so their inner rules never pass
 * for top-level ones.
 */
export function cssRules(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let at = 0;
  while (at < flat.length) {
    const open = flat.indexOf("{", at);
    if (open < 0) break;
    const prelude = flat.slice(at, open).trim();
    let depth = 1;
    let close = open + 1;
    for (; close < flat.length && depth > 0; close++) {
      if (flat[close] === "{") depth++;
      else if (flat[close] === "}") depth--;
    }
    const body = flat.slice(open + 1, close - 1);
    at = close;
    if (prelude.startsWith("@") || body.includes("{")) continue;
    const decls = Object.fromEntries(
      body
        .split(";")
        .map((d) => d.split(":").map((x) => x.trim()))
        .filter(([k, v]) => k && v)
        .map(([k, ...v]) => [k!, v.join(":")]),
    );
    for (const sel of prelude.split(",")) {
      const key = sel.trim();
      out.set(key, { ...out.get(key), ...decls });
    }
  }
  return out;
}
