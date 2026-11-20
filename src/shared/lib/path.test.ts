// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  basename,
  binaryStem,
  canonicalPath,
  dirname,
  isAbsolute,
  isWithin,
  join,
  normalize,
  relative,
  resolveRelative,
  root,
  samePath,
  separator,
  split,
  trimTrailingSeparators,
} from "./path";

describe("separator", () => {
  it("is the path's first separator, or / when it has none", () => {
    expect(separator("C:\\Users\\a")).toBe("\\");
    expect(separator("C:/Users")).toBe("/");
    expect(separator("a/b\\c")).toBe("/");
    expect(separator("file.txt")).toBe("/");
    expect(separator("")).toBe("/");
  });
});

describe("root", () => {
  it.each([
    ["/a/b", "/"],
    ["C:\\Users", "C:\\"],
    ["C:/Users", "C:/"],
    ["\\\\server\\share\\a", "\\\\server\\share"],
    ["a/b", ""],
    ["C:x", ""],
  ])("is the root of %j", (input, expected) => {
    expect(root(input)).toBe(expected);
  });
});

describe("split", () => {
  it.each([
    ["a/b/c.md", ["a", "b", "c.md"]],
    ["/a/b", ["a", "b"]],
    ["C:\\Users\\a", ["Users", "a"]],
    ["C:/Users/a", ["Users", "a"]],
    ["\\\\server\\share\\a\\b", ["a", "b"]],
    ["a\\b/c", ["a", "b", "c"]],
    ["a/b///", ["a", "b"]],
    ["/", []],
    ["", []],
  ])("splits %j", (input, expected) => {
    expect(split(input)).toEqual(expected);
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("a/b/c.md")).toBe("c.md");
  });

  it("returns the input when there is no separator", () => {
    expect(basename("file.md")).toBe("file.md");
  });

  it("tolerates trailing separators", () => {
    expect(basename("a/b/")).toBe("b");
    expect(basename("a/b///")).toBe("b");
    expect(basename("C:\\a\\b\\")).toBe("b");
  });

  it("handles an empty string and bare roots", () => {
    expect(basename("")).toBe("");
    expect(basename("/")).toBe("");
    expect(basename("C:\\")).toBe("");
  });

  it("handles drive letters, UNC and mixed separators", () => {
    expect(basename("C:\\Users\\a\\repo")).toBe("repo");
    expect(basename("C:/Users/a/repo")).toBe("repo");
    expect(basename("\\\\server\\share\\dir\\f.txt")).toBe("f.txt");
    expect(basename("C:\\Users/a\\repo/src")).toBe("src");
  });
});

describe("binaryStem", () => {
  // The backend's `agent_cli::binary_stem` asserts the same table.
  const { rows } = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "../../../src-tauri/crates/codesense-pty-core/src/agent_cli/fixtures/binary-stem.json",
      ),
      "utf-8",
    ),
  ) as { rows: [string, string][] };

  it.each(rows)("%s names %s", (path, stem) => {
    expect(binaryStem(path)).toBe(stem);
  });
});

describe("dirname", () => {
  it("mirrors POSIX at the root boundary", () => {
    expect(dirname("a/b/c")).toBe("a/b");
    expect(dirname("file.md")).toBe("");
    expect(dirname("/a")).toBe("/");
    expect(dirname("/")).toBe("/");
  });

  it("handles drive letters", () => {
    expect(dirname("C:\\Users\\a")).toBe("C:\\Users");
    expect(dirname("C:\\Users")).toBe("C:\\");
    expect(dirname("C:\\")).toBe("C:\\");
    expect(dirname("C:/Users")).toBe("C:/");
  });

  it("handles UNC", () => {
    expect(dirname("\\\\server\\share")).toBe("\\\\server\\share");
    expect(dirname("\\\\server\\share\\a")).toBe("\\\\server\\share");
    expect(dirname("\\\\server\\share\\a\\b")).toBe("\\\\server\\share\\a");
  });

  it("handles mixed separators", () => {
    expect(dirname("C:\\a/b\\c")).toBe("C:\\a/b");
  });
});

describe("join", () => {
  it("keeps the first segment's separator", () => {
    expect(join("C:\\Users", "a")).toBe("C:\\Users\\a");
    expect(join("C:/Users", "a")).toBe("C:/Users/a");
    expect(join("a", "b", "c")).toBe("a/b/c");
    expect(join("\\\\server\\share", "a")).toBe("\\\\server\\share\\a");
  });

  it("uses the first segment's separator inside later segments too", () => {
    expect(join("C:\\r", "src/x.ts")).toBe("C:\\r\\src\\x.ts");
    expect(join("/r", "src\\x.ts")).toBe("/r/src/x.ts");
  });

  it("rewrites every separator in a nested later segment", () => {
    expect(join("C:\\r", "src/a/x.ts")).toBe("C:\\r\\src\\a\\x.ts");
    expect(join("\\\\server\\share", "a/b/c")).toBe("\\\\server\\share\\a\\b\\c");
    expect(join("/r", "a\\b/c\\d")).toBe("/r/a/b/c/d");
  });

  it("defaults to / when the first segment has no separator", () => {
    expect(join("a", "b")).toBe("a/b");
  });

  it("does not double separators at the seams or after a root", () => {
    expect(join("/", "a")).toBe("/a");
    expect(join("C:\\", "a")).toBe("C:\\a");
    expect(join("a/", "/b/")).toBe("a/b");
    expect(join("C:\\a\\", "b\\")).toBe("C:\\a\\b");
  });

  it("skips empty segments and rebuilds a split path", () => {
    expect(join("a", "", "b")).toBe("a/b");
    expect(join("", "b")).toBe("b");
    expect(join(root("C:\\Users\\a"), ...split("C:\\Users\\a"))).toBe("C:\\Users\\a");
    expect(join(root("/a/b"), ...split("/a/b"))).toBe("/a/b");
  });
});

describe("relative", () => {
  it("is always /-joined", () => {
    expect(relative("C:\\r", "C:\\r\\src\\x.ts")).toBe("src/x.ts");
    expect(relative("/r", "/r/src/x.ts")).toBe("src/x.ts");
    expect(relative("C:/r", "C:\\r\\src/x.ts")).toBe("src/x.ts");
    expect(relative("\\\\s\\h\\r", "\\\\s\\h\\r\\x")).toBe("x");
  });

  it("is empty for the root itself and tolerates trailing separators", () => {
    expect(relative("/r", "/r")).toBe("");
    expect(relative("/r/", "/r/a")).toBe("a");
  });

  it("is null outside the root", () => {
    expect(relative("C:\\r", "C:\\other\\x.ts")).toBeNull();
    expect(relative("C:\\r", "C:\\rx\\x.ts")).toBeNull();
    expect(relative("C:\\r", "D:\\r\\x.ts")).toBeNull();
    expect(relative("/r/a", "/r")).toBeNull();
    expect(relative("/r", "r/x")).toBeNull();
  });

  it("ignores drive-letter case", () => {
    expect(relative("c:\\r", "C:\\r\\x")).toBe("x");
  });
});

describe("resolveRelative", () => {
  it("resolves a same-dir sibling", () => {
    expect(resolveRelative("/a/b/epic", "sibling.md")).toBe("/a/b/epic/sibling.md");
  });

  it("resolves a `./`-prefixed ref (drops the `.`)", () => {
    expect(resolveRelative("/a/b/epic", "./doc.md")).toBe("/a/b/epic/doc.md");
  });

  it("climbs with `..` into a sibling sub-epic", () => {
    expect(resolveRelative("/a/b/epic", "../other/W-5-foo.md")).toBe("/a/b/other/W-5-foo.md");
  });

  it("climbs multiple levels", () => {
    expect(resolveRelative("/a/b/c/d", "../../x/y.md")).toBe("/a/b/x/y.md");
  });

  it("floors at root — `..` never pops above `/`", () => {
    expect(resolveRelative("/a", "../../../etc/passwd")).toBe("/etc/passwd");
  });

  it("preserves the leading slash for absolute bases and drops it for relative bases", () => {
    expect(resolveRelative("/root", "child")).toBe("/root/child");
    expect(resolveRelative("root", "child")).toBe("root/child");
  });

  it("collapses empty and `.` segments", () => {
    expect(resolveRelative("/a/b", ".//./c//d.md")).toBe("/a/b/c/d.md");
  });

  it("floors at a drive root", () => {
    expect(resolveRelative("C:\\a", "..\\..\\b")).toBe("C:\\b");
    expect(resolveRelative("C:/a/b", "../c")).toBe("C:/a/c");
    expect(resolveRelative("C:\\", "..")).toBe("C:\\");
  });

  it("floors at a UNC share", () => {
    expect(resolveRelative("\\\\server\\share\\a", "../../b")).toBe("\\\\server\\share\\b");
    expect(resolveRelative("\\\\server\\share", "..")).toBe("\\\\server\\share");
  });

  it("accepts either separator in the reference", () => {
    expect(resolveRelative("C:\\a\\b", "..\\c/d.md")).toBe("C:\\a\\c\\d.md");
  });
});

describe("isAbsolute", () => {
  it.each(["/x", "C:\\x", "C:/x", "\\\\s\\h"])("is true for %j", (p) => {
    expect(isAbsolute(p)).toBe(true);
  });

  it.each(["x/y", "C:x", "", "..\\x"])("is false for %j", (p) => {
    expect(isAbsolute(p)).toBe(false);
  });
});

describe("trimTrailingSeparators", () => {
  it("drops trailing separators of either kind", () => {
    expect(trimTrailingSeparators("/a/b/")).toBe("/a/b");
    expect(trimTrailingSeparators("C:\\a\\b\\\\")).toBe("C:\\a\\b");
    expect(trimTrailingSeparators("a/b")).toBe("a/b");
    expect(trimTrailingSeparators("")).toBe("");
  });

  it("keeps a bare root", () => {
    expect(trimTrailingSeparators("/")).toBe("/");
    expect(trimTrailingSeparators("//")).toBe("/");
    expect(trimTrailingSeparators("C:\\")).toBe("C:\\");
    expect(trimTrailingSeparators("C:/")).toBe("C:/");
    expect(trimTrailingSeparators("\\\\server\\share")).toBe("\\\\server\\share");
    expect(trimTrailingSeparators("\\\\server\\share\\")).toBe("\\\\server\\share");
  });
});

describe("canonicalPath", () => {
  it.each([
    ["\\\\s\\h\\a\\\\b\\", "\\\\s\\h\\a\\b"],
    ["c:/a//b", "C:\\a\\b"],
    ["//foo//bar/", "/foo/bar"],
    ["a\\\\b/", "a\\b"],
    ["/a/b", "/a/b"],
    ["/", "/"],
    ["C:\\", "C:\\"],
    ["c:/", "C:\\"],
    ["\\\\server\\share\\", "\\\\server\\share"],
    ["\\\\server/share/a", "\\\\server\\share\\a"],
    ["a/b", "a/b"],
    ["", ""],
  ])("is %j → %j", (input, expected) => {
    expect(canonicalPath(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const p of ["c:/a//b", "\\\\s\\h\\a\\\\b\\", "//foo//bar/", "a\\\\b/"]) {
      expect(canonicalPath(canonicalPath(p))).toBe(canonicalPath(p));
    }
  });
});

describe("samePath", () => {
  it.each([
    ["C:\\a\\b", "c:/a/b/", true],
    ["/a//b/", "/a/b", true],
    ["\\\\s\\h\\a", "\\\\s\\h\\a\\", true],
    ["/a/b", "/a/B", false],
    ["C:\\a", "D:\\a", false],
    ["C:\\A\\b", "C:\\a\\b", false],
    ["a/b", "/a/b", false],
  ])("%j vs %j is %s", (a, b, expected) => {
    expect(samePath(a, b)).toBe(expected);
  });
});

describe("isWithin", () => {
  it.each([
    ["/a", "/a", true],
    ["/a", "/a/b", true],
    ["/a/", "/a/b", true],
    ["/a", "/ab", false],
    ["/a/b", "/a", false],
    ["C:\\a", "C:/a/b", true],
    ["C:\\a", "c:\\a", true],
    ["C:\\a", "C:\\a2\\b", false],
    ["C:\\a", "D:\\a\\b", false],
    ["\\\\s\\h\\a", "\\\\s\\h\\a\\b", true],
    ["\\\\s\\h\\a", "\\\\s\\h2\\a\\b", false],
  ])("%j holds %j: %s", (dir, p, expected) => {
    expect(isWithin(dir, p)).toBe(expected);
  });
});

describe("normalize", () => {
  it.each([
    ["/r/a/../b.html", "/r/b.html"],
    ["/r/./a//b/", "/r/a/b"],
    ["/../x", "/x"],
    ["C:\\r\\a\\..\\b.html", "C:\\r\\b.html"],
    ["C:/r/a/../b.html", "C:/r/b.html"],
    ["C:\\..\\x", "C:\\x"],
    ["\\\\s\\h\\a\\..\\..\\b", "\\\\s\\h\\b"],
    ["a/./b/../c", "a/c"],
    ["a\\b\\..\\c", "a\\c"],
  ])("is %j → %j", (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });
});
