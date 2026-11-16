// SPDX-License-Identifier: MIT
// Types for roving.js, the chat thread's one-Tab-stop rule the kit's chat and the app's agent chat overlay share.
export interface RovingThread {
  /** The message focus is in, if any. */
  focused(): string | null;
  /** Apply the Tab order after a render; `held` (focused() from before it) refocuses a rebuilt or departed message. */
  refresh(held?: string | null): void;
  /** Focus the newest message, as when the thread is entered from outside it. */
  focusNewest(): void;
  /** Stop watching the thread. */
  release(): void;
}
export function rovingThread(log: HTMLElement): RovingThread;
