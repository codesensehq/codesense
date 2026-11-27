// SPDX-License-Identifier: MIT
// The live prefs, apart from the client that fills them, so app-state readers can use them
// without importing the live hub.
import { create } from "zustand";

export type PrefsState = Record<string, unknown> & { viewer?: Record<string, unknown> };
export const usePrefsStore = create<{
  principal: string | null;
  global: PrefsState;
  owned: PrefsState;
  globalReady: boolean;
  ownedReady: boolean;
}>(() => ({ principal: null, global: {}, owned: {}, globalReady: false, ownedReady: false }));
