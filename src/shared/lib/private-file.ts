// SPDX-License-Identifier: MIT
import { join, root, split } from "@/shared/lib/path";

/** Recognize private files wherever opened; this never constructs a private target. */
export function privateFile(
  path: string,
): { repoRoot: string; relative: string; contentRoot: string | null } | null {
  // `…/users/{id}/scratch/orgs/{org}/{team}/{relative}` or `…/scratch/all-orgs/{relative}`;
  // the last `users/{id}/scratch` that is followed by one of those wins.
  const segments = split(path);
  for (let i = segments.length - 4; i >= 0; i--) {
    if (segments[i] !== "users" || segments[i + 2] !== "scratch") continue;
    const rest = segments.slice(i + 3);
    const scoped = rest[0] === "orgs" && rest.length > 3;
    if (!scoped && !(rest[0] === "all-orgs" && rest.length > 1)) continue;
    const repoRoot = join(root(path), ...segments.slice(0, i + 3));
    return {
      repoRoot,
      relative: rest.slice(scoped ? 3 : 1).join("/"),
      contentRoot: scoped && rest[3] === "content" ? join(repoRoot, ...rest.slice(0, 4)) : null,
    };
  }
  return null;
}
