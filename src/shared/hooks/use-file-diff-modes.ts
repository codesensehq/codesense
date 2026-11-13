// SPDX-License-Identifier: MIT
import { resolveFileDiffModes, type FileDiffModes } from "@/shared/lib/file-diff-mode";
import { useViewerStore } from "@/shared/stores/viewer-store";

/**
 * The shared per-type diff modes and their writer. Every file-diff surface reads
 * its modes here and its mode switch writes back, so a choice made on one
 * surface is where the next diff opens on all of them.
 */
export function useFileDiffModes(): {
  modes: FileDiffModes;
  setMode: ReturnType<typeof useViewerStore.getState>["setFileDiffMode"];
} {
  const raw = useViewerStore((s) => s.settings.defaultFileDiffMode);
  const setMode = useViewerStore((s) => s.setFileDiffMode);
  // Resolve outside the selector: a fresh object per read would re-render forever.
  return { modes: resolveFileDiffModes(raw), setMode };
}
