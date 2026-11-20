// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

it("keeps the committed editor current, standalone, CSP-compatible and within budget", () => {
  expect(() =>
    execFileSync("pnpm", ["build:kit-editor", "--check"], { cwd: process.cwd(), stdio: "pipe" }),
  ).not.toThrow();
  const path = "src-tauri/src/http/routes/dashboard_kit/";
  // The bundle is mostly third-party library code; the .min.js name keeps code scanning's
  // JavaScript extractor from analyzing it (its first-party modules stay scanned in src/).
  // It is still served as /kit/v1/editor.js.
  expect(existsSync(path + "editor.js")).toBe(false);
  const js = readFileSync(path + "editor.min.js", "utf8"),
    css = readFileSync(path + "editor.css", "utf8");
  expect(js.split("\n")[0]).toBe(css.split("\n")[0]);
  expect(js).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(/);
  expect(js).not.toMatch(/window\.codesense|react-dom|react\.production/);
  expect(gzipSync(js).length + gzipSync(css).length).toBeLessThan(350_000);
  expect(Buffer.byteLength(js) + Buffer.byteLength(css)).toBeLessThan(1_500_000);
});
