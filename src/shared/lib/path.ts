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
 * `null` when `path` is not inside `dir`. The root itself gives `""`.
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

/**
 * Resolve `rel` against the absolute directory `base`, collapsing `.`, `..` and
 * empty segments. Pure and safe against traversal: `..` never pops above the
 * root, the drive or the UNC share. The result uses `base`'s separator.
 */
export function resolveRelative(base: string, rel: string): string {
  const rt = root(base);
  const parts = segmentsAfter(base, rt);
  for (const seg of rel.split(SEPARATORS)) {
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
    } else if (seg !== "." && seg !== "") {
      parts.push(seg);
    }
  }
  const sep = separator(base);
  const body = parts.join(sep);
  if (!rt) return body;
  if (/[\\/]$/.test(rt)) return rt + body;
  return body ? rt + sep + body : rt;
}
