// SPDX-License-Identifier: MIT
import type { ContextFile } from "@/tauri/commands";
import type { DerivedPipelineTree } from "./types";
import { basename } from "@/shared/lib/path";

/** Reuse the effective nav overlay for inherited docs; retain own code/config search. */
export function quickOpenContentFiles(
  ownFiles: ContextFile[],
  tree: DerivedPipelineTree | null,
): ContextFile[] {
  const files = new Map(ownFiles.map((file) => [file.relativePath, file]));
  if (tree) {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      const add = (filePath: string, name: string) => {
        const relativePath = node.dirPath ? `${node.dirPath}/${name}` : name;
        files.set(relativePath, { fullPath: filePath, relativePath, name });
      };
      for (const file of [...node.stories, ...(node.docs ?? [])]) add(file.filePath, file.fileName);
      if (node.mainDoc) add(node.mainDoc.filePath, basename(node.mainDoc.filePath));
      pending.push(...node.subEpics);
    }
  }
  return [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
