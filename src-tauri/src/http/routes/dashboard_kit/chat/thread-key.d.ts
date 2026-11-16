// SPDX-License-Identifier: MIT
/** A thread's key, as the engine keys it: the saved agent (the id before `@`) and the story, `""` for none. */
export function threadOf(
  agent: string | null | undefined,
  story: string | null | undefined,
): { agentId: string; storyId: string };
