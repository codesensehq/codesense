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
const SEPARATORS = /[\\/]+/;
const TRAILING_SEPARATORS = /[\\/]+$/;
const DRIVE_ROOT = /^[A-Za-z]:/;

function rootOf(path: string): string {
  return ROOT.exec(path)?.[0] ?? "";
}

/** The path's own separator: its first `\` or `/`, else `/`. */
function separatorOf(path: string): string {
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

/**
 * The path's segments. An absolute path's root (`/`, `C:\`, `\\server\share`)
 * is its first element, so `join(...split(p))` rebuilds the path.
 */
export function split(path: string): string[] {
  const root = rootOf(path);
  const segments = segmentsAfter(path, root);
  return root ? [root, ...segments] : segments;
}

/** True for `/x`, `C:\x`, `C:/x` and `\\server\share`; false for `x/y` and `C:x`. */
export function isAbsolute(path: string): boolean {
  return ROOT.test(path);
}

/**
 * Join segments with the first segment's separator (`/` when it has none).
 * Empty segments are skipped; `.` and `..` are kept as given.
 */
export function join(first: string, ...rest: string[]): string {
  const sep = separatorOf(first);
  let out = first;
  for (const part of rest) {
    const trimmed = part.replace(/^[\\/]+/, "").replace(TRAILING_SEPARATORS, "");
    if (!trimmed) continue;
    out = out ? out.replace(TRAILING_SEPARATORS, "") + sep + trimmed : trimmed;
  }
  return out;
}

/**
 * The final segment, tolerant of trailing separators (`a/b/` → `b`). A bare
 * root (`/`, `C:\`) has none and gives `""`.
 */
export function basename(path: string): string {
  const root = rootOf(path);
  return segmentsAfter(path, root).pop() ?? "";
}

/**
 * Everything before the last separator. No separator → `""`; a root stays its
 * own parent (`/` → `/`, `C:\` → `C:\`, `\\server\share` → itself).
 */
export function dirname(path: string): string {
  const root = rootOf(path);
  if (path.length <= root.length) return root;
  let i = path.length - 1;
  while (i >= 0 && path[i] !== "/" && path[i] !== "\\") i--;
  if (i < root.length) return root;
  return path.slice(0, i);
}

/**
 * `path` relative to `root`, always `/`-joined (the form Rust and git use), or
 * `null` when `path` is not inside `root`. The root itself gives `""`.
 */
export function relative(root: string, path: string): string | null {
  const rootRoot = rootOf(root);
  if (normalizedRoot(rootRoot) !== normalizedRoot(rootOf(path))) return null;
  const base = segmentsAfter(root, rootRoot);
  const target = segmentsAfter(path, rootOf(path));
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
  const root = rootOf(base);
  const parts = segmentsAfter(base, root);
  for (const seg of rel.split(SEPARATORS)) {
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
    } else if (seg !== "." && seg !== "") {
      parts.push(seg);
    }
  }
  const sep = separatorOf(base);
  const body = parts.join(sep);
  if (!root) return body;
  if (/[\\/]$/.test(root)) return root + body;
  return body ? root + sep + body : root;
}
