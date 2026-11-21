// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOT,
  checkContract,
  contractInputs,
  sealContract,
} from "./generate-live-data-contract.mjs";
import { REFRESH_ROUTE } from "./lib/sealed-export.mjs";

const OUTPUT = "codesense-docs/getting-started/content/generated/live-data-contract.json";

describe("live-data contract PR gate", () => {
  it("tolerates a re-exported PR's drift only in inputs that main changed", () => {
    const root = mkdtempSync(join(tmpdir(), "live-data-contract-inherited-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: root,
        stdio: "pipe",
      });
    try {
      const inputs = Object.keys(contractInputs(ROOT));
      for (const path of inputs) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        copyFileSync(join(ROOT, path), join(root, path));
      }
      mkdirSync(dirname(join(root, OUTPUT)), { recursive: true });
      writeFileSync(join(root, OUTPUT), '{"contract":"fixture"}\n');
      sealContract(root);
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      // The PR edits one input and re-exports, so it changes the sealed export.
      const [ours, theirs] = inputs.filter((path) => path.endsWith(".rs"));
      git("switch", "-q", "-c", "pr");
      appendFileSync(join(root, ours), "// the PR's change\n");
      sealContract(root);
      git("commit", "-q", "-am", "pr");
      // Meanwhile main changes another input; the check runs on the merge, as CI does.
      git("switch", "-q", "main");
      appendFileSync(join(root, theirs), "// another PR's change\n");
      git("commit", "-q", "-am", "main");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("switch", "-q", "pr");
      git("merge", "-q", "--no-edit", "main");
      const notices: string[] = [];
      const tolerant = () =>
        checkContract(root, { allowStaleExport: true, warn: (line: string) => notices.push(line) });
      expect(tolerant).not.toThrow();
      expect(notices.join("\n")).toMatch(/^NOTICE: Stale generated file: .*source inputs changed/);
      // The strict check (the docs wave) still asks for the refresh.
      expect(() => checkContract(root)).toThrow(/source inputs changed/);
      // Drift in an input the PR changed is the PR's own: strict.
      appendFileSync(join(root, ours), "// changed after the export\n");
      expect(tolerant).toThrow(/source inputs changed/);
      git("checkout", "-q", "--", ours);
      // So is a payload that no longer matches its seal.
      appendFileSync(join(root, OUTPUT), "\n");
      expect(tolerant).toThrow(/payload changed/);
      // Write mode (`pnpm gen:docs`) warns on any stale seal and never throws.
      const written: string[] = [];
      expect(() =>
        checkContract(root, {
          check: false,
          strict: false,
          warn: (line: string) => written.push(line),
        }),
      ).not.toThrow();
      // Under CS_STRICT_EXPORTS=1 (the refresh run) write mode is strict.
      expect(() => checkContract(root, { check: false, strict: true })).toThrow(/payload changed/);
      expect(written.join("\n")).toMatch(/^NOTICE: Stale generated file: .*payload changed/);
      expect(written.join("\n")).toContain(REFRESH_ROUTE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
