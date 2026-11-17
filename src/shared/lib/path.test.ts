// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { basename, dirname, isAbsolute, join, relative, resolveRelative, split } from "./path";

describe("split", () => {
  it.each([
    ["a/b/c.md", ["a", "b", "c.md"]],
    ["/a/b", ["/", "a", "b"]],
    ["C:\\Users\\a", ["C:\\", "Users", "a"]],
    ["C:/Users/a", ["C:/", "Users", "a"]],
    ["\\\\server\\share\\a\\b", ["\\\\server\\share", "a", "b"]],
    ["a\\b/c", ["a", "b", "c"]],
    ["a/b///", ["a", "b"]],
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
    expect(join(...split("C:\\Users\\a"))).toBe("C:\\Users\\a");
    expect(join(...split("/a/b"))).toBe("/a/b");
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
