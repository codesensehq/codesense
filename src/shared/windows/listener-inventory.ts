// SPDX-License-Identifier: MIT
/**
 * Every global Tauri listener in the app, one row per call site, with the
 * scope `listenScoped` registers it under (see `listen-scoped.ts` for what
 * each scope does). A row is keyed by `{file, event}`: `file` is relative to
 * `src/`, and `event` is the literal or constant named at the call, or
 * `{name}` / `{prefix-*}` for an event name built at run time.
 *
 * How a row is classed:
 * - `main-only`: the handler acts for the app rather than reading for its
 *   window: persistence, MCP actions, pane-open, render replies, prompts and
 *   one-off toasts, app lifecycle, and path events (Rust broadcasts them;
 *   they become `owning-window` once they are routed to one window).
 *   `main`'s `context-file-change` rows stay here: Rust sends every change
 *   to `main`, and those handlers bump refresh keys for the whole app.
 * - `every-window`: the handler re-reads or caches something its own window
 *   shows; doing it in each window is correct and idempotent.
 * - `owning-window`: the event is about one terminal session or stream, which a
 *   satellite shows only once a later story gives it workspaces and an `owns`,
 *   or about a file a satellite holds (`shared/windows/path-listeners.ts`).
 * - `this-window`: as `owning-window`, for an event Rust emits to one window's
 *   label (a terminal stream's output), so no other window hears it.
 *
 * `listener-inventory.test.ts` keeps this list and the code in step: a call
 * with no row, a scope that differs from its row, or a row whose site is gone
 * fails it. A new global listener goes through `listenScoped` with a row here.
 */
import type { ListenerScope } from "./listen-scoped";

export interface ListenerRow {
  /** The file of the call, relative to `src/`. */
  file: string;
  /** The event as named at the call: a literal, a constant, or `{…}` when built at run time. */
  event: string;
  scope: ListenerScope;
  /** Why the row has its scope. */
  why: string;
}

// prettier-ignore
export const LISTENER_INVENTORY: readonly ListenerRow[] = [
  { file: "app/App.tsx", event: "dep-status-changed", scope: "every-window", why: "re-reads dependency status for this window's gate" },
  { file: "app/App.tsx", event: "menu:action", scope: "main-only", why: "the app menu acts on main until menus follow the focused window" },
  { file: "app/App.tsx", event: "worktree-file-change", scope: "main-only", why: "path event, broadcast by Rust until it is routed to one window" },
  { file: "app/App.tsx", event: "local-profiles-changed", scope: "every-window", why: "profile event: each window re-reads auth" },
  { file: "app/App.tsx", event: "app:quit-flush", scope: "main-only", why: "Rust waits for one ack, so only main may send it" },
  { file: "app/App.tsx", event: "CONTEXT_FILE_CHANGE_EVENT", scope: "main-only", why: "path event, broadcast by Rust until it is routed to one window" },
  { file: "app/hooks/use-composite-overlay-refresh.ts", event: "SYNC_WAVE_COMPLETED_EVENT", scope: "every-window", why: "refreshes this window's overlay" },
  { file: "app/hooks/use-composite-overlay-refresh.ts", event: "CONTEXT_FILE_CHANGE_EVENT", scope: "main-only", why: "path event, broadcast by Rust until it is routed to one window" },
  { file: "app/hooks/use-dashboard-stream.ts", event: "AGENT_DONE_EVENT", scope: "every-window", why: "feeds this window's dashboard streams" },
  { file: "app/hooks/use-dashboard-stream.ts", event: "AGENT_MESSAGE_EVENT", scope: "every-window", why: "feeds this window's dashboard streams" },
  { file: "app/hooks/use-dashboard-stream.ts", event: "AGENT_PROGRESS_EVENT", scope: "every-window", why: "feeds this window's dashboard streams" },
  { file: "app/hooks/use-epic-repos-reassembly.ts", event: "EPIC_REPOS_CHANGED_EVENT", scope: "main-only", why: "re-assembles worktrees: one window acts" },
  { file: "app/hooks/use-sync-wave-rescan.ts", event: "SYNC_WAVE_COMPLETED_EVENT", scope: "every-window", why: "refreshes this window's file views" },
  { file: "app/update-toast.tsx", event: "update-download-progress", scope: "main-only", why: "the app update runs from main" },
  { file: "features/agent-context/hooks/use-agent-context.ts", event: "AGENTS_CHANGED_EVENT", scope: "every-window", why: "re-reads an agent's context" },
  { file: "features/agent-context/hooks/use-agent-context.ts", event: "CONTEXT_FILE_CHANGE_EVENT", scope: "main-only", why: "path event, broadcast by Rust until it is routed to one window" },
  { file: "features/agents/lib/agent-names.ts", event: "AGENTS_CHANGED_EVENT", scope: "every-window", why: "re-reads agent names" },
  { file: "features/agents/lib/agent-names.ts", event: "CONTEXT_INDEX_CHANGED_EVENT", scope: "every-window", why: "re-reads agent names" },
  { file: "features/agents/lib/agent-names.ts", event: "SESSION_STATE_CHANGED_EVENT", scope: "every-window", why: "re-reads agent names" },
  { file: "features/agents/lib/agent-names.ts", event: "PTY_EXIT_EVENT", scope: "every-window", why: "re-reads agent names" },
  { file: "features/agents/lib/agent-prepare-progress.ts", event: "AGENT_PREPARE_PROGRESS_EVENT", scope: "every-window", why: "progress for the window that asked" },
  { file: "features/agents/lib/use-agent-preview.ts", event: "dep-status-changed", scope: "every-window", why: "re-reads dependency status" },
  { file: "features/attachment/components/source-repo-pill.tsx", event: "SYNC_REPO_LOOKS_GONE_EVENT", scope: "every-window", why: "this pill's state" },
  { file: "features/dashboard-publishing/use-dashboard-manager.ts", event: "CONTEXT_INDEX_CHANGED_EVENT", scope: "every-window", why: "re-reads dashboards when the index changes" },
  { file: "features/dashboard/components/nav-selection.ts", event: "CONTEXT_INDEX_CHANGED_EVENT", scope: "every-window", why: "re-reads the nav when the index changes" },
  { file: "features/dashboard/lib/dashboard-commands.ts", event: "COMMAND_RUN_EVENT", scope: "main-only", why: "runs a command: one window acts" },
  { file: "features/dashboard/lib/live-hub.ts", event: "{event}", scope: "every-window", why: "the live hub's injected listen; the host releases a window's subscriptions on Destroyed" },
  { file: "features/git-sync/lib/use-context-git-source.ts", event: "CONTEXT_GIT_MOVED_EVENT", scope: "every-window", why: "re-reads a repo's git state" },
  { file: "features/git-sync/lib/use-context-git-source.ts", event: "CONTEXT_REPO_STATUS_CHANGED_EVENT", scope: "every-window", why: "re-reads a repo's git state" },
  { file: "features/git-sync/lib/use-file-redline.ts", event: "CONTEXT_GIT_MOVED_EVENT", scope: "every-window", why: "re-reads a repo's baseline" },
  { file: "features/inbox/hooks/use-agent-pins.ts", event: "AGENT_PINS_CHANGED_EVENT", scope: "every-window", why: "re-reads pins" },
  { file: "features/inbox/hooks/use-inbox-read.ts", event: "{event}", scope: "every-window", why: "re-reads the inbox, which the title-bar count shows in every window" },
  { file: "features/inbox/hooks/use-session-record.ts", event: "{event}", scope: "every-window", why: "re-reads a session record (live-hub's SESSION_RECORD_EVENTS)" },
  { file: "features/license/api.ts", event: "LICENSE_STATE_EVENT", scope: "every-window", why: "license state shown in every window" },
  { file: "features/machines/components/machines-group.tsx", event: "terminal-restore-changed", scope: "every-window", why: "re-reads a machine's recorded tabs" },
  { file: "features/machines/lib/remote-story-workspace.ts", event: "REMOTE_WORKSPACE_PROGRESS_EVENT", scope: "every-window", why: "progress for the window that asked" },
  { file: "features/machines/lib/update-all.ts", event: "UPDATE_RUN_EVENT", scope: "every-window", why: "shows update runs" },
  { file: "features/machines/stores/machines-store.ts", event: "MACHINES_CHANGED_EVENT", scope: "every-window", why: "re-reads machines" },
  { file: "features/notes/lib/use-note-history.ts", event: "NOTES_CHANGED_EVENT", scope: "every-window", why: "re-reads note history" },
  { file: "features/org/components/context-attachments.tsx", event: "context-attachments-changed", scope: "every-window", why: "re-reads attachments" },
  { file: "features/org/components/missing-context-repos.tsx", event: "context-attachments-changed", scope: "every-window", why: "re-reads attachments" },
  { file: "features/org/hooks/use-org-discovery.ts", event: "context-attachments-changed", scope: "every-window", why: "re-reads attachments" },
  { file: "features/org/hooks/use-org-registry-sync.ts", event: "SOURCE_ATTACHMENTS_CHANGED_EVENT", scope: "every-window", why: "keeps this window's org store current" },
  { file: "features/org/hooks/use-org-registry-sync.ts", event: "ORG_REGISTRY_CHANGED_EVENT", scope: "every-window", why: "keeps this window's org store current; main makes the registry calls" },
  { file: "features/org/hooks/use-org-registry-sync.ts", event: "ACTIVE_TEAM_SWITCH_EVENT", scope: "main-only", why: "an agent's team switch (mcp:set-active-team) applies to main" },
  { file: "features/routines/stores/routines-store.ts", event: "ROUTINES_CHANGED_EVENT", scope: "every-window", why: "re-reads routines" },
  { file: "features/routines/stores/routines-store.ts", event: "AGENTS_CHANGED_EVENT", scope: "every-window", why: "re-reads routines" },
  { file: "features/settings/components/general-section.tsx", event: "dep-status-changed", scope: "every-window", why: "settings read" },
  { file: "features/shell/components/terminal-activity-upgrade.tsx", event: "terminal-activity-upgrade-required", scope: "main-only", why: "one upgrade prompt, in main" },
  { file: "features/shell/components/terminal-server-prompt.tsx", event: "TERMINAL_SERVER_INCOMPATIBLE_EVENT", scope: "main-only", why: "one install prompt, in main" },
  { file: "features/shell/components/terminal-server-prompt.tsx", event: "TERMINAL_SERVER_REFUSED_EVENT", scope: "main-only", why: "one install prompt, in main" },
  { file: "features/shell/components/terminal-server-prompt.tsx", event: "TERMINAL_SERVER_RESTARTED_EVENT", scope: "main-only", why: "one restart toast, in main" },
  { file: "features/shell/hooks/use-epic-assembly-listener.ts", event: "WORKTREE_RUN_COMPLETED_EVENT", scope: "every-window", why: "this window's sync chip" },
  { file: "features/shell/right-pane/panes/use-register-pane-panels.ts", event: "PANE_OPEN_EVENT", scope: "main-only", why: "pane-open opens in main (AC 3)" },
  { file: "features/story-launch/use-story-agent-launch.tsx", event: "dep-status-changed", scope: "every-window", why: "re-reads dependency status" },
  { file: "features/viewer/components/agent-result-panel.tsx", event: "{mcp:agent-output-*}", scope: "every-window", why: "one run's output, for the panel showing it" },
  { file: "features/viewer/hooks/use-background-mode-notification.ts", event: "BACKGROUND_MODE_ENTERED_EVENT", scope: "main-only", why: "one explainer, which writes a setting" },
  { file: "features/viewer/hooks/use-role-holdings.ts", event: "AGENT_STATE_CHANGED_EVENT", scope: "every-window", why: "re-reads role holdings" },
  { file: "features/viewer/hooks/use-session-cwd-revision.ts", event: "pty-osc7", scope: "owning-window", why: "a terminal session's cwd" },
  { file: "features/viewer/hooks/use-session-prompt.ts", event: "pty-osc133", scope: "owning-window", why: "a terminal session's prompt marks" },
  { file: "features/viewer/hooks/use-team-landing-page.ts", event: "CONTEXT_FILE_CHANGE_EVENT", scope: "main-only", why: "path event, broadcast by Rust until it is routed to one window" },
  { file: "features/viewer/hooks/use-team-landing-page.ts", event: "ORG_REGISTRY_CHANGED_EVENT", scope: "every-window", why: "keeps this window's landing pages current" },
  { file: "features/viewer/hooks/use-worktree-roster-listener.ts", event: "WORKTREE_CHANGED_EVENT", scope: "every-window", why: "re-reads the worktree roster" },
  { file: "features/viewer/lib/agent-list-inputs.ts", event: "agent-list-identity-changed", scope: "every-window", why: "keeps this window's agent identities current" },
  { file: "features/viewer/lib/cli-workspace/transport/terminal-layout-source.ts", event: "TERMINAL_RUNTIME_EVENT", scope: "owning-window", why: "a terminal layout change" },
  { file: "features/viewer/lib/cli-workspace/transport/terminal-layout-source.ts", event: "TERMINAL_LAYOUT_ADMISSION_CHANGED_EVENT", scope: "owning-window", why: "a terminal layout admission" },
  { file: "features/viewer/lib/cli-workspace/transport/terminal-layout-source.ts", event: "TERMINAL_LAYOUT_RESYNC_EVENT", scope: "every-window", why: "no payload; a resync is idempotent" },
  { file: "features/viewer/lib/use-remote-worktree-watch.ts", event: "{eventName}", scope: "main-only", why: "path event (a remote worktree's file change), broadcast until it is routed to one window" },
  { file: "features/viewer/lib/use-scratch-overlay-files.ts", event: "SYNC_WAVE_COMPLETED_EVENT", scope: "every-window", why: "re-reads overlay files" },
  { file: "features/viewer/lib/use-scratch-overlay-files.ts", event: "SCRATCH_USE_CHANGED_EVENT", scope: "every-window", why: "re-reads overlay files" },
  { file: "features/viewer/stores/session-timers-store.ts", event: "SESSION_TIMERS_CHANGED_EVENT", scope: "every-window", why: "re-reads timers this window shows" },
  { file: "features/viewer/stores/session-timers-store.ts", event: "WAKE_DELIVERED_EVENT", scope: "every-window", why: "marks this window's terminals and timers" },
  { file: "features/viewer/stores/session-timers-store.ts", event: "WAKE_OUTCOME_EVENT", scope: "every-window", why: "re-reads timers this window shows" },
  { file: "features/weft/hooks/use-agent-updates.ts", event: "AGENT_MESSAGE_EVENT", scope: "every-window", why: "re-reads agent updates" },
  { file: "features/weft/hooks/use-attention-board.ts", event: "WEFT_ATTENTION_CHANGED_EVENT", scope: "every-window", why: "re-reads the board" },
  { file: "features/weft/hooks/use-wv-endorsement-events.ts", event: "WV_ASSERTION_POSTED_EVENT", scope: "every-window", why: "updates this view" },
  { file: "features/weft/hooks/use-wv-endorsement-events.ts", event: "WV_ASSERTION_RATIFIED_EVENT", scope: "every-window", why: "updates this view" },
  { file: "features/weft/hooks/use-wv-endorsement-events.ts", event: "WV_ASSERTION_REVOKED_EVENT", scope: "every-window", why: "updates this view" },
  { file: "features/workspace-chat/hooks/use-workspace-chat.ts", event: "EVENT_NAME", scope: "every-window", why: "re-reads a workspace chat" },
  { file: "features/workspace-chat/hooks/use-workspace-chat.ts", event: "MEDIA_EVENT_NAME", scope: "every-window", why: "re-reads a workspace chat's media" },
  { file: "features/workspace/hooks/use-move-workspace-sync.ts", event: "HYDRATE_EVENT", scope: "main-only", why: "moves main's workspace list" },
  { file: "features/workspace/hooks/use-move-workspace-sync.ts", event: "CLEARED_EVENT", scope: "main-only", why: "moves main's workspace list" },
  { file: "features/workspace/hooks/use-move-workspace-sync.ts", event: "PROGRESS_EVENT", scope: "main-only", why: "moves main's workspace list" },
  { file: "shared/hooks/use-agent-message-listener.ts", event: "mcp:agent-message", scope: "every-window", why: "appends to this window's agent chat" },
  { file: "shared/hooks/use-avatar-packs.ts", event: "AVATARS_CHANGED_EVENT", scope: "every-window", why: "re-reads avatars" },
  { file: "shared/hooks/use-avatar-packs.ts", event: "AGENTS_CHANGED_EVENT", scope: "every-window", why: "re-reads avatars" },
  { file: "shared/hooks/use-canvas-render-bridge.ts", event: "canvas:render-request", scope: "main-only", why: "render replies come from main (AC 3); Rust sends the request to main" },
  { file: "shared/hooks/use-managed-session-bridge.ts", event: "mcp:ask-user", scope: "main-only", why: "MCP questions are answered in main" },
  { file: "shared/hooks/use-managed-session-bridge.ts", event: "mcp:ask-user-closed", scope: "main-only", why: "MCP questions are answered in main" },
  { file: "shared/hooks/use-managed-session-bridge.ts", event: "mcp:agent-done", scope: "main-only", why: "managed-session outcomes are recorded once, in main" },
  { file: "shared/hooks/use-managed-session-bridge.ts", event: "pty-exit", scope: "main-only", why: "managed-session deaths are recorded once, in main" },
  { file: "shared/hooks/use-mcp-actions.ts", event: "mcp:reorder-workspace", scope: "main-only", why: "an MCP action on main's viewer (AC 3)" },
  { file: "shared/hooks/use-mcp-actions.ts", event: "REMOTE_TERMINAL_REVEAL_EVENT", scope: "main-only", why: "an MCP action on main's viewer (AC 3)" },
  { file: "shared/hooks/use-mcp-actions.ts", event: "mcp:set-viewer-state", scope: "main-only", why: "an agent's viewer patch applies to main only (AC 3)" },
  { file: "shared/hooks/use-mcp-actions.ts", event: "mcp:workspace-groups-changed", scope: "main-only", why: "an MCP action on main's viewer (AC 3)" },
  { file: "shared/hooks/use-mcp-actions.ts", event: "mcp:workspace-retired", scope: "main-only", why: "an MCP action on main's viewer (AC 3)" },
  { file: "shared/hooks/use-open-workspace-reveal.ts", event: "OPEN_WORKSPACE_REVEAL_EVENT", scope: "main-only", why: "an MCP reveal (mcp:open-workspace-reveal) acts on main" },
  { file: "shared/hooks/use-role-configs.ts", event: "roles:changed", scope: "every-window", why: "re-reads role configs" },
  { file: "shared/hooks/use-role-configs.ts", event: "sync-wave-completed", scope: "every-window", why: "re-reads role configs" },
  { file: "shared/hooks/use-role-queues.ts", event: "agent-state-changed", scope: "every-window", why: "re-reads role queues" },
  { file: "shared/hooks/use-terminal-activity.ts", event: "TERMINAL_RUNTIME_EVENT", scope: "owning-window", why: "a terminal session's runtime event" },
  { file: "shared/hooks/use-terminal-activity.ts", event: "TERMINAL_LAYOUT_RESYNC_EVENT", scope: "every-window", why: "no payload; a resync is idempotent" },
  { file: "shared/hooks/use-terminal-status-events.ts", event: "terminal-status-update", scope: "owning-window", why: "a terminal session's status" },
  { file: "shared/hooks/use-terminal-status-events.ts", event: "pty-exit", scope: "owning-window", why: "a terminal session exited" },
  { file: "shared/hooks/use-terminal-status-events.ts", event: "pty-osc133", scope: "owning-window", why: "a terminal session's command end" },
  { file: "shared/lib/agent-handshake.ts", event: "mcp:agent-message", scope: "every-window", why: "a launch handshake, in the window that launched" },
  { file: "shared/lib/context-query/subscribe-context.ts", event: "CONTEXT_INDEX_CHANGED_EVENT", scope: "every-window", why: "a satellite loads the content index and must see it change" },
  { file: "shared/lib/pipeline-graph/content-scan-queue.ts", event: "CONTEXT_INDEX_CHANGED_EVENT", scope: "every-window", why: "drops this window's cached lists" },
  { file: "shared/lib/private-terminal-authority.ts", event: "private-authority-retired", scope: "every-window", why: "session-server reconnect: each window drops its authority" },
  { file: "shared/lib/worktree/setup.ts", event: "{worktree-run-*}", scope: "every-window", why: "one run's progress, for the window that started it" },
  { file: "shared/stores/scratch-team-use-store.ts", event: "SCRATCH_USE_CHANGED_EVENT", scope: "every-window", why: "re-reads scratch use" },
  { file: "shared/stores/workspace-archive-store.ts", event: "codesense:workspace-archive-changed", scope: "every-window", why: "keeps the archive state current" },
  { file: "shared/terminal/terminal-manager.ts", event: "pty-exit", scope: "owning-window", why: "a terminal session exited" },
  { file: "shared/terminal/terminal-manager.ts", event: "TERMINAL_STREAMS_LOST_EVENT", scope: "every-window", why: "session-server reconnect: each window reconnects its own streams" },
  { file: "shared/terminal/terminal-manager.ts", event: "{channel}", scope: "this-window", why: "pty-output-stream: one terminal stream's output, emitted to the window that subscribed it" },
  { file: "shared/windows/path-listeners.ts", event: "CONTEXT_FILE_CHANGE_EVENT", scope: "owning-window", why: "Rust routes it here; refreshes this satellite's held tab" },
];
