// SPDX-License-Identifier: MIT
/**
 * The one front-end path helper. It accepts POSIX, drive-letter (`C:\`, `C:/`)
 * and UNC (`\\server\share`) paths on every OS and never branches on the host:
 * both separators always count. Rust hands the front end display and relative
 * paths already simplified, so this only splits and joins; it never touches
 * the disk.
 *
 * Content-repo logical paths, URLs, keys and slugs are always `/`-delimited and
 * are not file-system paths; they do not need this module.
 */

/** A UNC share (`\\server\share`), a drive root (`C:\`), or a lone separator. */
const ROOT = /^(?:\\{2}[^\\/]+[\\/]+[^\\/]+|[A-Za-z]:[\\/]|[\\/])/;
const SEPARATORS = /[\\/]+/g;
const TRAILING_SEPARATORS = /[\\/]+$/;
const DRIVE_ROOT = /^[A-Za-z]:/;

/** The path's own separator: its first `\` or `/`, else `/`. */
export function separator(path: string): string {
  const match = /[\\/]/.exec(path);
  return match ? match[0] : "/";
}

function segmentsAfter(path: string, root: string): string[] {
  return path.slice(root.length).split(SEPARATORS).filter(Boolean);
}

/** The root, comparable across separators and drive-letter case. */
function normalizedRoot(root: string): string {
  const slashed = root.replace(/\\/g, "/");
  return DRIVE_ROOT.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** The path's root: `/`, `C:\`, `C:/` or `\\server\share`; `""` for a relative path. */
export function root(path: string): string {
  return ROOT.exec(path)?.[0] ?? "";
}

/** The path's non-empty segments, without its root (`C:\Users\a` → `Users`, `a`). */
export function split(path: string): string[] {
  return segmentsAfter(path, root(path));
}

/** True for `/x`, `C:\x`, `C:/x` and `\\server\share`; false for `x/y` and `C:x`. */
export function isAbsolute(path: string): boolean {
  return ROOT.test(path);
}

/**
 * Join segments with the first segment's separator (`/` when it has none), also
 * for separators inside the later segments. Empty segments are skipped; `.` and
 * `..` are kept as given.
 */
export function join(...parts: string[]): string {
  const sep = separator(parts[0] ?? "");
  let out = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    const trimmed = part
      .replace(/^[\\/]+/, "")
      .replace(TRAILING_SEPARATORS, "")
      .replace(SEPARATORS, sep);
    if (!trimmed) continue;
    out = out ? out.replace(TRAILING_SEPARATORS, "") + sep + trimmed : trimmed;
  }
  return out;
}

/**
 * `path` without trailing separators, keeping a bare root (`/`, `C:\`,
 * `\\server\share`) intact so trimming never turns a root into `""`.
 */
export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(TRAILING_SEPARATORS, "");
  const rt = root(path);
  return trimmed.length < rt.length ? rt : trimmed;
}

/**
 * The final segment, tolerant of trailing separators (`a/b/` → `b`). A bare
 * root (`/`, `C:\`) has none and gives `""`.
 */
export function basename(path: string): string {
  return split(path).pop() ?? "";
}

/**
 * Everything before the last separator. No separator → `""`; a root stays its
 * own parent (`/` → `/`, `C:\` → `C:\`, `\\server\share` → itself).
 */
export function dirname(path: string): string {
  const rt = root(path);
  if (path.length <= rt.length) return rt;
  let i = path.length - 1;
  while (i >= 0 && path[i] !== "/" && path[i] !== "\\") i--;
  if (i < rt.length) return rt;
  return path.slice(0, i);
}

/**
 * `path` relative to `dir`, always `/`-joined (the form Rust and git use), or
 * `null` when `path` is not inside `dir`. `dir` itself gives `""`.
 */
export function relative(dir: string, path: string): string | null {
  const dirRoot = root(dir);
  const pathRoot = root(path);
  if (normalizedRoot(dirRoot) !== normalizedRoot(pathRoot)) return null;
  const base = segmentsAfter(dir, dirRoot);
  const target = segmentsAfter(path, pathRoot);
  if (target.length < base.length) return null;
  if (!base.every((seg, i) => seg === target[i])) return null;
  return target.slice(base.length).join("/");
}

/** `parts` with `.` and empty segments dropped and `..` popping, never above the start. */
function resolveSegments(parts: string[]): string[] {
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return out;
}

/** `rt` followed by `parts` joined with `sep`. */
function withRoot(rt: string, parts: string[], sep: string): string {
  const body = parts.join(sep);
  if (!rt) return body;
  if (/[\\/]$/.test(rt)) return rt + body;
  return body ? rt + sep + body : rt;
}

/**
 * Resolve `rel` against the absolute directory `base`, collapsing `.`, `..` and
 * empty segments. Pure and safe against traversal: `..` never pops above the
 * root, the drive or the UNC share. The result uses `base`'s separator.
 */
export function resolveRelative(base: string, rel: string): string {
  const rt = root(base);
  const parts = resolveSegments([...segmentsAfter(base, rt), ...rel.split(SEPARATORS)]);
  return withRoot(rt, parts, separator(base));
}

/**
 * `path` with `.`, `..` and repeated separators resolved, keeping its own
 * separator. `..` never climbs above the root (or, for a relative path, above
 * its start).
 */
export function normalize(path: string): string {
  const rt = root(path);
  return withRoot(rt, resolveSegments(segmentsAfter(path, rt)), separator(path));
}

/**
 * One spelling per path, for keys and equality: the root, then the segments
 * joined by one separator, with trailing separators dropped (a bare root is
 * kept). A drive-letter or UNC path is written with `\` and an upper-case drive
 * letter; a POSIX path keeps `/`; a relative path keeps its first separator.
 * Segments are not case-folded and `.`/`..` are kept (see {@link normalize}).
 */
export function canonicalPath(path: string): string {
  const rt = root(path);
  const segments = segmentsAfter(path, rt);
  if (DRIVE_ROOT.test(rt)) return withRoot(`${rt[0].toUpperCase()}:\\`, segments, "\\");
  if (rt.length > 1) {
    const share = "\\\\" + rt.slice(2).split(SEPARATORS).filter(Boolean).join("\\");
    return withRoot(share, segments, "\\");
  }
  return withRoot(rt, segments, separator(rt || path));
}

/**
 * True when `a` and `b` name the same path whatever their separators (git for
 * Windows prints `C:/…` where the front end builds `C:\…`). Only the drive
 * letter folds case.
 */
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/** True when `path` is `dir` itself or inside it, across separators. */
export function isWithin(dir: string, path: string): boolean {
  return relative(dir, path) !== null;
}
