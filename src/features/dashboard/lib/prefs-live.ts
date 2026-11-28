// SPDX-License-Identifier: MIT
import { useEffect } from "react";
import { isMainWindow } from "@/shared/lib/current-window";
import { useCurrentUser } from "@/shared/lib/get-current-user";
import { applyGlobalViewerPrefs, applyOwnedViewerPrefs } from "@/shared/stores/viewer-store";
import { applyShortcutPrefs } from "@/shared/stores/shortcuts-store";
import { ensurePrefsConnection, resetPrefsConnection, usePrefsStore } from "./prefs-client";

/** Applies the prefs to the stores. A satellite takes only the global prefs: the owned
 *  viewer prefs carry `main`'s layout keys, which a satellite neither shows nor writes. */
export function bindPrefsConsumers() {
  const owned = isMainWindow();
  const apply = (
    next: ReturnType<typeof usePrefsStore.getState>,
    previous?: ReturnType<typeof usePrefsStore.getState>,
  ) => {
    if (owned && next.principal !== previous?.principal) applyOwnedViewerPrefs({}, true);
    if (next.globalReady && next.global !== previous?.global) {
      applyGlobalViewerPrefs(next.global.viewer?.settings);
      applyShortcutPrefs(next.global.shortcuts);
    }
    if (owned && next.ownedReady && next.owned !== previous?.owned)
      applyOwnedViewerPrefs(next.owned.viewer ?? {});
  };
  apply(usePrefsStore.getState());
  return usePrefsStore.subscribe(apply);
}

export function usePrefsLive() {
  const principal = useCurrentUser()?.principal;
  useEffect(bindPrefsConsumers, []);
  useEffect(() => {
    if (!principal) {
      resetPrefsConnection();
      return;
    }
    const connection = ensurePrefsConnection(principal);
    const visibility = () => connection.visible(document.visibilityState !== "hidden");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    void connection.ready.catch(console.error);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      resetPrefsConnection();
    };
  }, [principal]);
}
