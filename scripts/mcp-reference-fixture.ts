// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT, ROOT, readCatalog } from "./generate-mcp-reference.mjs";

type Family = {
  id: string;
  title: string;
  docs: string;
  searchTerms: string[];
  tools: string[];
  calls: Array<{ tool: string; arguments: Record<string, unknown> }>;
};

// Strict fixtures model the last refresh. A story can add catalog tools, or examples using a
// param its Rust adds, before that refresh; their PR-mode behavior has its own tests.
export function exportedCatalog(root = ROOT) {
  const catalog = readCatalog(root) as { schema: number; families: Family[] };
  const params = new Map<string, Set<string>>(
    JSON.parse(
      readFileSync(join(root, CONTENT, "generated/mcp-tools.dashboard-publish.json"), "utf8"),
    ).tools.map((tool: { name: string; inputSchema: { properties?: object } }) => [
      tool.name,
      new Set(Object.keys(tool.inputSchema.properties ?? {})),
    ]),
  );
  const exported = (call: Family["calls"][number]) =>
    params.has(call.tool) &&
    Object.keys(call.arguments).every((key) => params.get(call.tool)!.has(key));
  return {
    ...catalog,
    families: catalog.families
      .map((family) => ({
        ...family,
        tools: family.tools.filter((name) => params.has(name)),
        calls: family.calls.filter(exported),
      }))
      .filter((family) => family.tools.length),
  };
}
