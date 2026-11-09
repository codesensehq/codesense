// SPDX-License-Identifier: MIT
import { formatSessionHandle } from "@/features/viewer/lib/agent-row-presentation";

const ROUTINE_HANDLE = /^routine:(.+)@[^@]*$/;

/**
 * A readable name for a run from the handle it ran under: a routine run reads as its routine's
 * id, anything else through the same handle formatter the live agent rows use.
 */
export function runLabel(storyId: string | null | undefined): string | null {
  const handle = storyId?.trim();
  if (!handle) return null;
  const routine = ROUTINE_HANDLE.exec(handle);
  if (routine) return routine[1].split("/").filter(Boolean).pop() ?? routine[1];
  return formatSessionHandle(handle);
}

/** What kind of run a finished run was. */
export type RunKind = "Routine" | "Agent" | "Headless";
