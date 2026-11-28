import "../../../src/index.css";
import { createRoot } from "react-dom/client";
import { SlotDashboardHost } from "../../../src/features/shell/slots/slot-dashboard-host";
import { dashboardRefKey } from "../../../src/features/dashboard/lib/dashboard-ref";
import { useDashboardProfileStore } from "../../../src/features/dashboard/lib/dashboard-profile";
import { usePaneStore } from "../../../src/features/shell/right-pane/panes/pane-store";
import { useOrgStore } from "../../../src/shared/stores/org-store";
import type { DashboardRef, PaneEntry } from "../../../src/tauri/commands";

// A right-pane dashboard host whose native side admits every verb, so the only thing between
// the page and a host-only topic is the bridge's own refusal. `api.calls` records each command
// the host sends to the native side.
const api = window as any;
api.calls = [];
const ref: DashboardRef = { scope: "team", org: "fixture", team: "dev", id: "topics" };
const entry: PaneEntry = {
  id: "topics",
  title: "Topics",
  scope: "team",
  team: "dev",
  path: "/fixture/panes/topics.html",
  panesDir: "/fixture/panes",
  panelId: "pane:fixture:dev/topics",
  dashboardRef: ref,
  status: "ready",
  declaration: { slots: ["right-pane"], capabilities: [], commands: [] },
};
api.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
api.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => 1,
  unregisterCallback: () => {},
  invoke: async (command: string, args: any) => {
    api.calls.push([command, args]);
    if (command === "plugin:event|listen") return 1;
    if (command === "get_http_api_port") return api.framePort;
    const grant = {
      frameId: "topics:1",
      principal: "fixture",
      dashboard: dashboardRefKey(ref),
      slot: "right-pane",
      team: { org: "fixture", team: "dev" },
      scope: "open",
    };
    if (command === "mint_frame")
      return {
        frameId: "topics:1",
        token: "topics",
        origin: `http://127.0.0.1:${api.framePort}`,
        kind: "team",
        documentPath: args.args.documentPath,
        grant,
      };
    if (command === "resolve_frame_grant") return grant;
    if (command === "verb_dispatch") return { status: "admit", callId: crypto.randomUUID() };
    if (command === "live_hub_view_key") return "all";
    if (command === "live_hub_subscribe")
      return { topic: args.topic, viewKey: args.viewKey, rev: 1, snapshot: [] };
    if (command === "local_profile_status") return { active: { principal: "fixture" } };
    if (command === "load_app_state") return "{}";
    return null;
  },
};
useOrgStore.setState({ activeOrgSlug: "fixture", activeTeamName: "dev" });
usePaneStore.setState({
  teamKey: "fixture:dev",
  listing: { contentRoot: "/fixture", chain: ["dev"], panes: [entry] },
  knownEntries: {},
});
useDashboardProfileStore.setState({
  org: "fixture",
  profile: {
    id: "default",
    name: "Default",
    posture: "",
    slots: { "right-pane": [ref] },
    cliLayout: "default",
    chrome: {},
  },
});

createRoot(document.getElementById("root")!).render(
  <div style={{ width: 300, height: 300 }}>
    <SlotDashboardHost
      slotId="right-pane"
      panelId={entry.panelId}
      contentRoot="/fixture"
      visible
      entry={entry}
    />
  </div>,
);
