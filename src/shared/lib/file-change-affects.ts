// SPDX-License-Identifier: MIT
/** A coarse refresh, exact file event, or directory event containing this file. */
export function fileChangeAffects(
  changedPaths: Set<string> | null | undefined,
  filePath: string | null,
): boolean {
  if (!changedPaths) return true;
  if (!filePath) return false;
  for (const changed of changedPaths) {
    if (
      filePath === changed ||
      filePath.startsWith(changed.endsWith("/") ? changed : `${changed}/`)
    )
      return true;
  }
  return false;
}

/** Every possible nearest declaration, including one created or deleted by this edit. */
export function frameDeclarationPaths(filePath: string | null, contentRoot: string): string[] {
  const root = contentRoot.replace(/\/+$/, "");
  if (!filePath) return [];
  const paths: string[] = [];
  const parent = filePath.slice(0, filePath.lastIndexOf("/"));
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  // Native list_layer discovers direct HTML children with valid pane ids only.
  if (parent.endsWith("/panes") && name.length <= 69 && /^[a-z0-9][a-z0-9-]*\.html$/.test(name))
    paths.push(`${parent}/pane-manifest.yaml`);
  if (!root || !filePath.startsWith(`${root}/`)) return paths;
  let directory = parent;
  while (directory.length >= root.length) {
    paths.push(`${directory}/dashboard.yml`);
    if (directory === root) break;
    directory = directory.slice(0, directory.lastIndexOf("/"));
  }
  return paths;
}
