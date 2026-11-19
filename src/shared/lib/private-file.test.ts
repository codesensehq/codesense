// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { privateFile } from "./private-file";

describe("privateFile", () => {
  it("reads an org-scoped private file and its content root", () => {
    expect(privateFile("/h/.codesense/users/42/scratch/orgs/o/t/content/a/b.md")).toEqual({
      repoRoot: "/h/.codesense/users/42/scratch",
      relative: "content/a/b.md",
      contentRoot: "/h/.codesense/users/42/scratch/orgs/o/t/content",
    });
  });

  it("reads an all-orgs private file", () => {
    expect(privateFile("/h/users/42/scratch/all-orgs/x/y.md")).toEqual({
      repoRoot: "/h/users/42/scratch",
      relative: "x/y.md",
      contentRoot: null,
    });
  });

  it("reads a Windows private file in its own separator", () => {
    expect(privateFile("C:\\h\\users\\42\\scratch\\orgs\\o\\t\\content\\b.md")).toEqual({
      repoRoot: "C:\\h\\users\\42\\scratch",
      relative: "content/b.md",
      contentRoot: "C:\\h\\users\\42\\scratch\\orgs\\o\\t\\content",
    });
  });

  it("is null outside a scratch repo", () => {
    expect(privateFile("/h/users/42/notes/orgs/o/t/content/b.md")).toBeNull();
    expect(privateFile("/h/users/42/scratch/orgs/o/t")).toBeNull();
  });
});
