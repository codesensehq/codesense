// SPDX-License-Identifier: MIT
// @vitest-environment node
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

/** The messages ESLint reports for `code` linted as the repo file `filePath`. */
async function lint(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.message);
}

const VIEWER = "src/features/viewer/lib/x.ts";
const PATH_RULE = /file-system paths/;

describe("path splitting lint rule", () => {
  it("rejects split on a path-named identifier in the viewer and shell", async () => {
    for (const file of [VIEWER, "src/features/shell/x.ts"]) {
      const messages = await lint(
        'export const f = (relPath: string) => relPath.split("/");\n',
        file,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(PATH_RULE);
    }
  });

  it("rejects a path-named member property", async () => {
    const messages = await lint(
      'export const f = (file: { path: string }) => file.path.split("/");\n',
      VIEWER,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(PATH_RULE);
  });

  it("rejects lastIndexOf and indexOf too", async () => {
    const code = [
      'export const a = (cwd: string) => cwd.lastIndexOf("/");',
      'export const b = (rootDir: string) => rootDir.indexOf("/");',
      "",
    ].join("\n");
    expect(await lint(code, VIEWER)).toHaveLength(2);
  });

  it("passes outside the two folders", async () => {
    const code = 'export const f = (relPath: string) => relPath.split("/");\n';
    expect(await lint(code, "src/features/dashboard/x.ts")).toEqual([]);
  });

  it("passes a dashboard file path split on a content-repo logical path (AC 3)", async () => {
    const code = 'export const f = (file: { path: string }) => file.path.split("/");\n';
    expect(await lint(code, "src/features/dashboard/x.ts")).toEqual([]);
  });

  it("passes a receiver whose name does not look like a path", async () => {
    const code = 'export const f = (agentKey: string) => agentKey.split("/");\n';
    expect(await lint(code, VIEWER)).toEqual([]);
  });

  it("passes in tests and fixtures inside the folders", async () => {
    const code = 'export const f = (relPath: string) => relPath.split("/");\n';
    expect(await lint(code, "src/features/viewer/lib/x.test.ts")).toEqual([]);
    expect(await lint(code, "src/features/viewer/__fixtures__/x.ts")).toEqual([]);
  });

  it("keeps the first-use rules and the path rule together on a first-use surface", async () => {
    const code = [
      'import { Loader2 } from "lucide-react";',
      'export const f = (relPath: string) => [Loader2, relPath.split("/")];',
      "",
    ].join("\n");
    const messages = await lint(code, "src/features/shell/components/boot-wait.tsx");
    expect(messages.some((m) => PATH_RULE.test(m))).toBe(true);
    expect(messages.some((m) => /Spinner/.test(m))).toBe(true);
  });
});
