// SPDX-License-Identifier: MIT
pub mod agent_accounts;
pub mod context_attachments;
pub mod context_operation;
pub mod context_query;
pub mod local_organization;
pub mod local_profile;
// SW-DX-17a: durable JSONL agent-lifecycle audit trail (spawn / kill / abort).
pub mod agent_audit;
pub(crate) mod agent_autoconnect;
pub(crate) mod agent_prompt;
pub mod agent_usage;
// The Agents tab (`agents_list`, `agent_detail`, archive, delete, copy, binding).
pub mod agents;
pub mod avatars;
// The frontend's interactive launch of a named agent (`agent_launch_prepare`).
pub mod agent_provision;
pub mod agents_launch;
pub mod story_create;
// SW-SD-2: account/CLI-agnostic headless agent runner + `analyze` bridge verb.
pub mod agent_runner;
// SW-AGR-14: no App Nap while remote machines are connected.
pub mod app_nap;
pub mod async_helpers;
pub mod attach_policy;
pub mod attachments;
pub mod auth;
pub mod remote_usage_pull;
// SW-AU-34: background-on-close policy — the quit-on-close preference mirror + the
// pure hide-vs-quit decision the window-close handler reads.
pub mod background_mode;
pub mod claude_session;
pub mod content_engine;
// SLW-PT-17: the agent-facing content-mobility spine (ContextId parse + §P typed
// gate ladder + context enumeration) the MCP tools adapt over.
pub mod context_git_watch;
pub mod context_mobility;
pub mod credential_store;
// SW-CN-15: unified DataSource model — one origin-tagged catalog over the builtin
// provider registry + the declared connector store (reconciles the two mechanisms).
pub mod context_repo_git;
pub mod deps;
pub mod export_pdf;
pub mod file_index;
pub mod file_surface;
pub mod files;
pub mod forge;
pub mod frontmatter_editor;
pub mod frontmatter_fields;
pub mod frontmatter_validation;
pub mod git;
pub mod git_sync;
pub mod session_text;
pub mod raster_bytes;
pub mod host_connection;
pub mod host_connection_manager;
pub mod install;
// SW-CR-8: Tauri surface for the retired-install-tree fold migration (the
// validate finding + the heal action; `migrate_install_tree` is the shared
// core, also called from `load_org_cmd` for boot-time folds).
pub mod install_tree_heal;
// SW-OR-1 (AC-3): the trusted-side `Interactive` autonomy gate fronting the
// UI-driving MCP tools. Sibling of `dashboard_launch` (shares its `SpawnCap`).
pub mod interactive_gate;
// SW-WA-F11: launch telemetry — a per-session legibility record attached to each
// saved-agent launch (shell or argv) and surfaced on `list_sessions`.
pub mod launch_telemetry;
pub mod layout_resolver;
// Remote Machines: the machine registry and the SSH connector.
pub mod machines;
// SW-AN-42: the interactive launch's MCP scope projection (project_mcp_scope_config).
pub mod mcp_authoring;
// SW-OR-1 (AC-1): the trusted-side story-session launch spine `open_workspace`
// drives — the Rust mirror of the FE `launchAgentSession` orchestration.
pub mod managed_worktree_config;
pub mod mcp_scope;
pub mod mcp_workspace;
pub mod move_between_contexts;
// Who changed a note, the notes' local history, and the `notes-changed` event.
pub mod notes_history;
pub mod org;
// Custom right panes (`<space>/panes/<id>.html`): the `list_panes` command.
pub mod pane_bridge;
pub mod panes;
pub mod paths;
pub mod pipeline_format;
pub mod pipeline_scanner;
pub mod pty;
pub mod pty_backend;
pub mod pty_host;
pub mod pty_layout;
pub mod pty_runner;
pub mod pty_viewer;
pub mod reconcile_workspace;
pub mod registry;
pub mod registry_local;
pub mod remove_from_context;
pub mod scratch_identity;
pub mod scratch_space_view;
pub mod scratch_use;
pub mod scratch_watch;
// SW-LN-35: the user's login shell for terminals.
pub mod team_file_edits;
pub mod team_landing;
pub mod user_shell;
// SW-CN-10: the in-process OAuth2 token broker — the single mint authority
// (device completion + refresh grant + the SW-CN-23 auth-code seam).
// SLW-RI-2: CI backstop for the blocking-offload guardrail (test-only scan).
#[cfg(test)]
mod ri2_backstop;
// SW-LN-B20: the declared local guest session (the no-login first run).
pub mod guest_session;
// What the app knows of each tab's inbox waiter, through the tab's host.
pub(crate) mod host_inbox;
// DESIGN-remote-source.md — remote source/editor Tauri commands (host side of
// the per-tab primitives on a Machine-origin tab).
pub mod remote_source;
pub mod worktree_editor;
// SLW-WD-4: app-side bridge to WD-3's route/un-route verbs (shared with MCP).
pub mod route_to_context;
// The inbox and roles reads' cache of resolved teams.
pub(crate) mod team_resolution_cache;
// Kept config reads on the hot paths (synced teams, role configs, media policy).
pub(crate) mod config_cache;
// The Routines tab's commands over the routine service.
pub mod routines;
pub mod scratch;
// SW-GT-6: the team config write commands (save_team_config, can_declare_team_field,
// declare_team_field) over the status-taxonomy / transitions / field-schema loaders.
pub mod config_editor;
// SW-GT-18: per-team metadata field schema (official ∪ custom) + the pure per-story field
// validation + the `{fieldName}` template-var extractor. Its live consumer is MCP
// `validate_candidate`.
pub mod field_schema;
// The one add-repo core: the add/attach forms and the MCP setup tools share it.
pub mod source_repo_add;
// SW-SB-2: per-team sprint definition registry loader (read side; SW-SB-11 owns
// the write/lifecycle side + SPRINTS.md generation).
pub mod sprint_registry;
// SW-CP-24: the merge-mark set/clear seam (C-layer) the CP-27 toggle + pack
// install invoke; the projection engine reads the store via `install::merge_marks`.
pub mod merge_marks;
// SW-CP-28: team-level projection-exclude read/write seam for the Settings section;
// the projection engine reads the store via `install::projection_excludes`.
pub mod projection_excludes;
// SW-GT-1: per-team status taxonomy source-of-truth + loader (SE-6 foundation;
// consumers migrate in GT-2/GT-3/GT-4).
pub mod status_taxonomy;
pub mod trigger_source;
// Run plumbing shared by routines and managed agent launches (claim loop, run identity,
// evidence, artifacts, transcripts).
pub mod sprint_run;
// SW-DX-6 AC-12: bounded concurrency cap for spawn-class dashboard actions
// (standalone primitive; SW-DX-7 wires it around real spawns).
pub mod spawn_cap;
// SW-DX-7: trusted-side storyId↔sessionId binding + SpawnCap consumer for the
// dashboard execution loop (openWorkspace / runPrompt).
// The inbox agent sessions and the human message each other through.
pub mod agent_inbox;
// The person's messages each agent session took and hasn't answered (the reply reminder).
pub(crate) mod reply_owed;
// One read model of agents and their inboxes for dashboards and agents (sessions, an
// agent's instances, the inbox, role queues, updates, the human's status).
pub mod agent_read_model;
pub mod data_read_model;
// SW-BSI-2: role-keyed delivery on top of the inbox — register_role,
// claim_role_messages, accept_role_message, ack_role_message, release_role,
// send_role_message.
pub mod dashboard_launch;
pub mod role_inbox;
pub(crate) mod role_startup;
pub mod roles;
pub mod system;
// This instance's terminal server in the macOS menu bar, the Linux tray or the
// Windows notification area.
pub mod terminal_server_tray;
pub mod tools;
pub mod update;
pub mod wake;
pub mod watch;
// RF-perf-8: shared self-pruning Arc registry (bounds SyncLockManager / cancels).
pub mod weak_registry;
// SW-WV-B3: the sibling-ledger Tauri command surface (roster + settle + watermark),
// thin delegations to the sanctioned `weft::` write handlers.
pub mod weft_ledger;
// SW-WV-B5: the scope-layer Tauri command surface (scopes + watches), thin
// delegations to the sanctioned `weft::` scope/watch handlers.
pub mod weft_scopes;
pub mod workspace_config;
// SW-WC-1: per-workspace archive flag (one nullable `archived_at_ms` field in
// a tiny registry under `~/.codesense/workspace-registry.json`; SW-WC-2 reads it).
pub mod workspace_registry;
// SW-WC-2: the workspace chat engine (per-workspace JSONL log + MCP tool pair
// + routine event trigger).
pub mod workspace_chat;
// `open_workspace` with a target: agents launch agents in a story or a team workspace.
pub(crate) mod workspace_open;
pub mod worktree;
// SW-XS-3 (K6): live-session worktree attribution, moved out of `watch`.
pub mod worktree_liveness;
pub mod worktree_probe;
pub mod worktree_provenance;
// SLW-WDE-3: lazy per-inset worktree file watcher (external-change reload).
pub mod worktree_watch;

// Re-exports for ergonomic call sites: `use crate::commands::await_blocking;`
pub use async_helpers::await_blocking;

#[cfg(test)]
mod tests {
    /// SW-XS-17 (AC-1/AC-2): CodeSense no longer caps worktrees or reaps idle ones,
    /// so none of the cap, admission, idle-threshold, pin or reap-now commands is
    /// registered, and the module that held them is gone. Names are assembled at
    /// runtime so this guard does not match itself in the source scan below.
    #[test]
    fn cap_and_idle_reaper_commands_are_gone() {
        let lib_rs = include_str!("../lib.rs");
        let start = lib_rs
            .find("tauri::generate_handler![")
            .expect("generate_handler! block not found in lib.rs");
        let end = lib_rs[start..].find("])").expect("closing `])` not found");
        let block = &lib_rs[start..start + end];
        let cap = ["worktree", "_cap"].concat();
        for name in [
            format!("set_{cap}"),
            ["ensure_worktree", "_capacity"].concat(),
            ["set_worktree", "_idle_threshold"].concat(),
            ["set_worktree", "_pins"].concat(),
            ["reap_worktrees", "_now"].concat(),
        ] {
            assert!(
                !block.contains(&format!("::{name},")),
                "`{name}` is still registered; SW-XS-17 removed the worktree cap and reaper"
            );
        }
        let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/commands")
            .join(format!("{cap}.rs"));
        assert!(!module.exists(), "{} still exists", module.display());
    }

    /// SW-XS-17 (AC-5): the crate's source holds no trace of the cap, the reap
    /// planner, the automatic reap primitive or the idle clock. The one allowed
    /// mention of the old idle-clock file is the launch cleanup that deletes it
    /// (`install/worktree_index.rs`).
    #[test]
    fn no_cap_or_idle_reaper_code_remains() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let idle_clock_file = ["session-activity", ".state"].concat();
        let tokens = [
            ["worktree", "_cap"].concat(),
            ["plan", "_reap"].concat(),
            ["enforce_worktree", "_cap"].concat(),
            ["flush_then_prune", "_worktree"].concat(),
            ["note_session", "_activity"].concat(),
            ["WORKTREE_REAP", "ED_EVENT"].concat(),
            ["WORKTREE_REAP", "ING_EVENT"].concat(),
            idle_clock_file.clone(),
        ];
        let mut hits = Vec::new();
        for entry in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
        {
            let rel = entry.path().strip_prefix(&src).unwrap().to_path_buf();
            let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
            for token in &tokens {
                if *token == idle_clock_file
                    && rel == std::path::Path::new("install/worktree_index.rs")
                {
                    continue;
                }
                if text.contains(token.as_str()) {
                    hits.push(format!("{} contains `{token}`", rel.display()));
                }
            }
        }
        assert!(
            hits.is_empty(),
            "leftover cap/reaper code:\n{}",
            hits.join("\n")
        );
    }
}

pub mod private_nav;

pub mod dashboard_commands;
pub mod frames;
pub(crate) use crate::live_hub::agent_list::preferences as agent_list_preferences;
