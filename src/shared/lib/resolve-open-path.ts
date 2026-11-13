// SPDX-License-Identifier: MIT
/**
 * Resolve a file path someone asked to open, where a `#` may start a fragment. An
 * admitted, existing literal path wins; only when `resolve` refuses it is the part
 * after the first `#` taken as the hash, with the part before it passing through the
 * same `resolve`.
 */
export async function resolveOpenPath<T>(
  path: string,
  resolve: (path: string) => Promise<T>,
): Promise<{ target: T; hash?: string }> {
  try {
    return { target: await resolve(path) };
  } catch (error) {
    const fragmentAt = path.indexOf("#");
    if (fragmentAt < 0) throw error;
    return { target: await resolve(path.slice(0, fragmentAt)), hash: path.slice(fragmentAt) };
  }
}
