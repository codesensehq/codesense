// SPDX-License-Identifier: MIT
//! SW-OR-1 (AC-1) — the trusted-side **story-session launch spine** the
//! `open_workspace` MCP tool drives.
//!
//! **Why a Rust spine exists.** The dashboard's `openWorkspace` spawn
//! orchestration lives entirely in the FE controller (`dashboard-launch.ts`
//! `launchAgentSession` → `agent-session-launcher.ts`): resolve story → ensure
//! worktree → per-session config → spawn PTY → inject the agent launch line → wait-live →
//! bind. An MCP orchestrator runs in the trusted process with **no FE**, so it
//! cannot reuse that controller. This module is the Rust mirror of that spine,
//! composed from the same trusted-side primitives the FE ultimately calls.
//!
//! **Scope.** Headless (background) **story** sessions. SW-OR-1 spawned only into
//! a story's **already-established managed worktree** (resolved from the worktree
//! index, the authoritative oracle). SW-OR-1a closes the last gap:
//! [`ensure_story_worktree`] materializes a worktree from scratch trusted-side
//! when none is linked yet — the Rust mirror of the FE `ensureWorktree`
//! (source-repo resolve → branch + path resolve →
//! `fetch_and_create_worktree` → provenance-gated `run_setup` → index link) — so
//! an orchestrator can open a
//! story cold, with no prior human open. SW-WA-F5: the caller resolves a
//! [`WorkspaceMode`] (headed default · visible-unfocused · headless opt-in) and
//! passes it through [`InteractiveGate::admit_workspace_mode`]; a visible open
//! emits the FE reveal signal so the workspace surfaces as a tab (replacing
//! SW-OR-1's blanket headed refusal).
//!
//! [`WorkspaceMode`]: super::interactive_gate::WorkspaceMode
//! [`InteractiveGate::admit_workspace_mode`]: super::interactive_gate::InteractiveGate::admit_workspace_mode
//!
//! Everything here targets a worktree that passed
//! [`is_codesense_managed_target`], so the spine can never write outside a
//! codesense-managed surface even if a derivation is wrong (belt-and-suspenders).
//!
//! [`InteractiveGate`]: super::interactive_gate::InteractiveGate
//! [`is_codesense_managed_target`]: crate::install::worktree_index::is_codesense_managed_target

pub(crate) mod managed_spawn;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::agent_audit::{self, AuditEvent};
use super::dashboard_launch::prebind::{AppPreBindPort, PreBindReservation};
use super::dashboard_launch::{
    DashboardLaunchState, InteractiveCaptureContext, LaunchMeta, LaunchRecord, LaunchTeam,
    RunProvenance, StoryPathResolution, KIND_DASHBOARD_LAUNCHED,
};
use super::deps::{DependencyManager, LaunchBinaryLookup, PendingShadowed, ResolvedAgentBinary};
use super::launch_telemetry::{
    LaunchMode, LaunchOutcome as TelemetryOutcome, LaunchTelemetry, LaunchTelemetryBuilder,
    LaunchTelemetryTracker,
};
use super::pty::{fan_out_sessions, kill_session, session_has_live_agent, submit_pty_line};
use super::pty_layout::{app_viewer, open_layout_tab, team_key, workspace_key, TabSpawn};
use super::route_to_context::{
    derive_active_context, derive_context_for, ActiveContext, ContextResolution,
};
use crate::agents::adapter;
use crate::agents::launch_check::{LaunchWarning, LaunchWarningCode};
use crate::commands::worktree::seat::SeatLaunch;
use crate::domain::Principal;
use crate::domain::SourceRepoSlug;
use crate::install::worktree_index::{
    base_story_records, is_codesense_managed_target, iter_story_records, read_record, write_record,
    SeatRecord, WorktreeStoryRecord,
};
use codesense_pty_core::agent_cli::AgentCli;
use codesense_pty_core::domain::{PtySessionId, SubmitOutcome, WorkspaceKey};
use codesense_pty_core::layout::{OpenTab, Placement, Tags, WorkspaceDescriptor};

/// The launcher provenance stamped on an MCP-spawned session (SW-GW-8 `launcher`
/// axis) — distinguishes it in the panel + audit from a dashboard/nav open.
const MCP_LAUNCHER: &str = "mcp:open_workspace";

/// PTY geometry for an agent session before any pane sizes it — the
/// frontend's fallback spawn size (120×32).
pub(crate) const AGENT_COLS: u16 = 120;
pub(crate) const AGENT_ROWS: u16 = 32;

/// `submit_pty_line` timing, mirrored from the FE defaults (`commands.ts`
/// SUBMIT_*): settle 200ms → confirm 400ms → 4s ceiling → 3 nudges. One source
/// so the trusted-side submit behaves identically to the bridge's — shared by
/// this spine AND the `send_to_session` MCP tool (the DRY submit contract).
pub const SUBMIT_QUIET_MS: u64 = 200;
pub const SUBMIT_CONFIRM_MS: u64 = 400;
pub const SUBMIT_TIMEOUT_MS: u64 = 4000;
pub const SUBMIT_MAX_NUDGES: u32 = 3;

/// Batch-submit text to several already-resolved live sessions, reusing the shipped
/// `submit_pty_line` settle→write→confirm contract with the SAME `SUBMIT_*` timing as the launch
/// spine (DRY). The MCP `send_to_session` tool and the agent inbox delegate here. The targets are
/// session ids the trusted side already resolved — a dead tab yields a per-target `Err` and never
/// aborts the batch (via [`fan_out_sessions`]). Concurrent so per-target settle timeouts don't
/// serialize. The text is resolved per target via `text_for`.
pub async fn send_to_sessions(
    app: &AppHandle,
    session_ids: Vec<String>,
    text_for: impl Fn(&str) -> String,
) -> Vec<(String, Result<SubmitOutcome, String>)> {
    fan_out_sessions(session_ids, |sid| {
        let app = app.clone();
        let text = text_for(&sid);
        async move {
            submit_pty_line(
                app,
                sid,
                text,
                SUBMIT_QUIET_MS,
                SUBMIT_CONFIRM_MS,
                SUBMIT_TIMEOUT_MS,
                SUBMIT_MAX_NUDGES,
            )
            .await
        }
    })
    .await
}

/// Wait-live budget: poll for the agent child up to 30×200ms = 6s (the FE
/// `waitForAgentLive` budget). BEST-EFFORT — exhaustion does NOT reap the
/// already-bound session (SW-WA-F10): a slow-to-launch agent must not be
/// killed as a false failure. The panel's status/liveness net surfaces a
/// no-show. For an SW-WA-F10 argv-direct launch the agent is PID-1 of the
/// PTY from spawn time, so the budget is almost always consumed in the
/// first poll.
const WAIT_LIVE_ATTEMPTS: u32 = 30;
const WAIT_LIVE_INTERVAL_MS: u64 = 200;

/// SW-OR-1a: materialize a story's managed worktree trusted-side when none exists
/// yet, and return the inputs [`run_managed_story_setup`] needs. The Rust mirror of
/// the FE `ensureWorktree` (`viewer-store.ts`) composed from the same shipped
/// primitives: resolve the story's source-repo clone → resolve the intended branch
/// and render the `worktree_dir` template → `fetch_and_create_worktree`
/// (local refs only, mints at the start point, idempotent) → register the story↔worktree
/// link. The caller then establishes durable ownership and runs setup. Failed
/// setup retains an incomplete registration so retry adopts the same worktree.
/// This runs before launch-slot reservation, so create failure cannot leak a slot.
/// **Materialize-safety (AC-2)** is confinement-by-construction, not a pre-write
/// predicate: the path is [`render_worktree_dir`]-rendered from an
/// already-attached clone (from [`resolve_local_clone_for_slug`]) using
/// the repo's own token-validated template; `write_record` then registers it, so
/// the caller's post-resolve [`is_codesense_managed_target`] guard passes.
///
/// [`render_worktree_dir`]: crate::commands::worktree::render_worktree_dir
/// [`resolve_local_clone_for_slug`]: crate::commands::content_engine::resolve_local_clone_for_slug
/// [`DashboardLaunchState::begin`]: super::dashboard_launch::DashboardLaunchState::begin
async fn ensure_story_worktree(
    app: &AppHandle,
    ctx: &ActiveContext,
    story_id: &str,
) -> Result<PreparedStoryWorktree, String> {
    use crate::commands::worktree;

    let StoryCheckout {
        slug,
        story_source_path,
        clone_path,
        org_root,
        authority,
        config,
        branch,
    } = resolve_story_checkout(app, ctx, story_id)?;
    let worktree_path = worktree::render_worktree_dir(&config.worktree_dir, &clone_path, &branch)
        .map_err(|e| format!("denied: {e}"))?;
    // 4. Create the worktree from local refs (mirrors the FE `fetchAndCreateWorktree`;
    //    nothing is fetched): adopt an existing local or cached `origin/` branch, or mint
    //    a new one at the configured `default_start_point` (its cached `origin/` ref when
    //    one exists), else at the repo's default branch (resolved only for a new branch;
    //    refused when none resolves) — never at the clone's arbitrary HEAD. The FE also bases a STACKED story on its
    //    `depends_on` dependency's branch; a cold orchestrator open doesn't, which is
    //    correct for the common (non-stacked) case. Idempotent (adopts our managed
    //    worktree). Use the RETURNED path as authoritative.
    let created = worktree::open_story_worktree(
        clone_path.to_string_lossy().to_string(),
        branch.clone(),
        worktree_path.to_string_lossy().to_string(),
        config.default_start_point.clone(),
    )
    .await
    .map_err(|e| format!("denied: worktree creation failed for story '{story_id}': {e}"))?;
    // Materialize-safety (review r2): `fetch_and_create_worktree` in story mode
    // ADOPTS any worktree already holding the branch WITHOUT a derived-path guard
    // (unlike review mode). So if the branch is checked out in the user's PRIMARY
    // clone (e.g. `branch_name: main`), it would return THAT path — and we'd then
    // run setup + `write_record` + spawn into the primary checkout, defeating the
    // SLW-FX-13 invariant (registration would even make the post-resolve
    // `is_codesense_managed_target` guard pass). Refuse anything that isn't the
    // path we confined-by-construction (mirrors review mode's `paths_equal` guard).
    if !worktree::paths_equal(&created.worktree_path, &worktree_path.to_string_lossy()) {
        return Err(format!(
            "denied: branch '{branch}' for story '{story_id}' is already checked out at '{}' (not the derived worktree) — refusing to materialize into a non-derived checkout",
            created.worktree_path
        ));
    }
    let created_path = PathBuf::from(created.worktree_path);

    // 5. Preserve durable ownership and receipts while marking setup pending.
    mark_story_setup_pending(ctx, &created_path, slug, story_id, story_source_path)?;

    Ok(PreparedStoryWorktree {
        dir: created_path,
        clone_path,
        org_root,
        authority,
        config,
    })
}

/// Where a story's worktrees come from: its source clone, the repo's worktree config and
/// the story's branch. Shared by the story's base worktree and its seat worktrees.
struct StoryCheckout {
    slug: SourceRepoSlug,
    story_source_path: PathBuf,
    clone_path: PathBuf,
    org_root: PathBuf,
    authority: crate::commands::worktree::WorktreeConfigAuthority,
    config: crate::commands::worktree::WorktreeConfig,
    /// The story branch: its `branch` frontmatter, else the `{branch_prefix}{id}` fallback.
    branch: String,
}

/// Resolve [`StoryCheckout`] for `story_id` (steps 1–3 of [`ensure_story_worktree`]):
/// its frontmatter, the team's attached clone of its source repo, that repo's worktree
/// config and the story branch.
fn resolve_story_checkout(
    app: &AppHandle,
    ctx: &ActiveContext,
    story_id: &str,
) -> Result<StoryCheckout, String> {
    use crate::commands::worktree;

    // 1. Resolve the story's frontmatter (source_repo, canonical branch, source
    //    path) from the SAME org frontmatter cache `resolve_story_path` uses — the
    //    managed-doc oracle. Extract owned copies so the snapshot borrow ends here.
    //    NOTE: SW-OR-1b — the unified `branch` (precedence `branch` → `branch_name`
    //    → `dev_branch`, via `story_branch()`) drives creation; a never-opened story
    //    may carry none, in which case the resolver falls back to the story-id branch.
    let (source_repo, story_branch, story_source_path) = {
        let shared = app
            .try_state::<crate::install::frontmatter_cache::SharedFrontmatterCache>()
            .ok_or_else(|| "unavailable: frontmatter cache not ready".to_string())?;
        let cache = crate::install::frontmatter_cache::FrontmatterCache::snapshot(&shared);
        // Shared arity gate (`single_by_story_id`) — the SAME "which story is
        // this?" authority the FE `resolve_story_path` uses; only the error
        // vocabulary differs (`denied:` on the trusted path).
        use crate::install::frontmatter_cache::StoryIdLookup;
        let entry = cache.single_by_story_id(story_id).map_err(|e| match e {
            StoryIdLookup::NotFound => format!("denied: no managed story with id '{story_id}'"),
            StoryIdLookup::Ambiguous(n) => {
                format!("denied: ambiguous story id '{story_id}' ({n} indexed)")
            }
        })?;
        (
            entry.source_repo().to_string(),
            entry.story_branch().map(str::to_string),
            entry.path.clone(),
        )
    };

    // 2. Resolve the local clone for the slug via `resolve_local_clone_for_slug`
    //    (attachments first, falling back to the install store), mirroring
    //    `resolve_epic_repo_clones` (content_engine.rs). Reading attachments
    //    first means an in-place user checkout outside the codesense home
    //    resolves even though the managed-surface gate never gave it an
    //    install-store row. Absence is a typed refusal, never a guess.
    let org_root = crate::context_repo::path_to_org_root(
        &ctx.codesense_home,
        &ctx.principal(),
        &ctx.org_slug,
    )?;
    let resolver_ctx = crate::commands::content_engine::derive_resolver_context(
        ctx.codesense_home.clone(),
        ctx.user_id,
        ctx.org_slug.clone(),
        ctx.team_name.clone(),
    )
    .map_err(|e| format!("denied: cannot resolve context for story '{story_id}': {e}"))?;
    // SW-LN-B29: resolve the story's `owner/repo` against the team's configured source repos,
    // so a local (no-remote) or non-GitHub repo is looked up under the slug its clone was
    // attached with, not the GitHub-shaped parse.
    let configured = crate::commands::content_engine::configured_team_source_repos(&resolver_ctx);
    let slug = SourceRepoSlug::resolve_against(&source_repo, &configured).ok_or_else(|| {
        format!("denied: story '{story_id}' has a malformed source_repo '{source_repo}'")
    })?;
    let clone_path =
        crate::commands::content_engine::resolve_local_clone_for_slug(&resolver_ctx, &slug)
            .map_err(|e| format!("denied: cannot enumerate clones for '{source_repo}': {e}"))?
            .ok_or_else(|| {
                format!("denied: no local clone for '{source_repo}' — attach it in CodeSense first")
            })?;

    // 3. Read the repo's worktree config, then resolve the branch + worktree path
    //    the SAME way the FE `resolveWorktreeParams`/`resolveWorktreePath` do: the
    //    canonical `story_branch` (or the `{branch_prefix}{story_id}` fallback), and
    //    the template rendered off that branch (`{slug}` = branch, `/`→`-`).
    let authority = worktree::WorktreeConfigAuthority {
        codesense_home: ctx.codesense_home.clone(),
        principal: ctx.principal(),
        team: ctx
            .team_name
            .clone()
            .ok_or_else(|| "denied: no active team selected".to_owned())?,
    };
    let config = worktree::read_worktree_config_with_authority(&clone_path, &org_root, &authority)
        .map_err(|e| format!("denied: worktree config invalid for '{source_repo}': {e}"))?
        .unwrap_or_default();
    // The FE builds the fallback branch from the story FILE-NAME stem
    // (`storyIdFromPath` = basename minus the pipeline extension), NOT the
    // frontmatter `story_id` — e.g. `SW-OR-4-multi-session.md` → `feat/SW-OR-4-
    // multi-session`. Mirror that so an MCP cold-open lands on the SAME branch/path
    // an interactive FE open would (`file_stem` strips the single `.md`/`.html`).
    let fallback_id = story_source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| story_id.to_string());
    let branch = worktree::resolve_story_branch(
        story_branch.as_deref(),
        &config.branch_prefix,
        &fallback_id,
    );
    Ok(StoryCheckout {
        slug,
        story_source_path,
        clone_path,
        org_root,
        authority,
        config,
        branch,
    })
}

fn mark_story_setup_pending(
    ctx: &ActiveContext,
    created_path: &Path,
    slug: SourceRepoSlug,
    story_id: &str,
    story_source_path: PathBuf,
) -> Result<(), String> {
    let mut record = read_record(&ctx.codesense_home, &ctx.principal(), created_path)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| {
            WorktreeStoryRecord::new(
                created_path.to_path_buf(),
                ctx.org_slug.clone(),
                slug,
                story_id.to_string(),
                story_source_path,
            )
        });
    // Retain incomplete registration after interruption; retry adopts this root
    // and runs setup again before native named-agent admission can succeed.
    record.setup_complete = false;
    write_record(&ctx.codesense_home, &ctx.principal(), &record)
        .map_err(|e| format!("denied: failed to link worktree for story '{story_id}': {e}"))?;
    Ok(())
}

/// Inputs retained between story registration and repository setup.
struct PreparedStoryWorktree {
    dir: PathBuf,
    clone_path: PathBuf,
    org_root: PathBuf,
    authority: crate::commands::worktree::WorktreeConfigAuthority,
    config: crate::commands::worktree::WorktreeConfig,
}

/// Run headless repository setup after registration, using the shared provenance
/// gate without pre-approval. Failure retains the incomplete record and root for retry.
async fn run_managed_story_setup(
    app: &AppHandle,
    _ctx: &ActiveContext,
    prepared: &PreparedStoryWorktree,
    story_id: &str,
) -> Result<(), String> {
    use crate::commands::worktree;

    let registry = app
        .try_state::<worktree::WorktreeRunRegistry>()
        .ok_or_else(|| "unavailable: worktree run registry not ready".to_string())?;
    let run_id = format!("mcp-setup-{}", mint_session_id());
    // SW-XS-9: each setup command is reported as `RunningSetup{command}`, and a
    // failed setup as a failure event (X5), on the workspace setup channel.
    let out = worktree::TauriEventSink(app.clone());
    let sink = SetupProgressSink {
        out: &out,
        story_id,
        worktree: &prepared.dir,
    };
    let outcome = worktree::run_setup_for_worktree(
        &sink,
        registry.inner(),
        &prepared.dir,
        &prepared.clone_path,
        &prepared.org_root,
        &prepared.authority,
        prepared.config.clone(),
        None,
        &run_id,
    )
    .await;

    if let Err(e) = outcome.and_then(|result| {
        if result.exit_code == 0 {
            Ok(())
        } else {
            Err(format!("setup exited with code {}", result.exit_code))
        }
    }) {
        // Preserve durable ownership and the incomplete setup marker for retry.
        return Err(if e.starts_with("NEEDS_APPROVAL") {
            let message = format!(
                "denied: setup-approval — story '{story_id}' worktree.yaml is team-synced and not approved for unattended setup; approve it once in CodeSense"
            );
            sink.needs_approval(&message);
            message
        } else {
            sink.failed(&e);
            format!("denied: worktree setup failed for story '{story_id}': {e}")
        });
    }
    sink.done();
    Ok(())
}

/// SW-XS-9: a local story worktree's Step 1 progress (its `worktree.yaml`
/// setup), keyed by story.
pub const WORKSPACE_SETUP_PROGRESS_EVENT: &str = "workspace-setup-progress";

/// Turns the setup runner's per-command events into `RunningSetup{command}`
/// on [`WORKSPACE_SETUP_PROGRESS_EVENT`]; the line stream stays headless.
pub(crate) struct SetupProgressSink<'a> {
    pub(crate) out: &'a dyn crate::commands::worktree::EventSink,
    pub(crate) story_id: &'a str,
    pub(crate) worktree: &'a std::path::Path,
}

impl SetupProgressSink<'_> {
    fn send(&self, mut payload: serde_json::Value) {
        payload["storyId"] = self.story_id.into();
        payload["worktreePath"] = self.worktree.to_string_lossy().into();
        self.out.emit(WORKSPACE_SETUP_PROGRESS_EVENT, payload);
    }

    /// The setup finished; the worktree is ready for its first agent's Step 2.
    pub(crate) fn done(&self) {
        self.send(serde_json::json!({ "phase": "done" }));
    }

    /// The repo's `worktree.yaml` is team-synced and not approved for
    /// unattended setup: the UI offers Approve, then Retry.
    pub(crate) fn needs_approval(&self, message: &str) {
        self.send(serde_json::json!({
            "phase": "needsApproval",
            "message": message,
        }));
    }

    /// X5: the setup failed; say so where its progress was shown.
    pub(crate) fn failed(&self, message: &str) {
        self.send(serde_json::json!({
            "phase": "failed",
            "failedPhase": crate::mcp::remote_workspace::Step1Phase::RunningSetup,
            "message": message,
        }));
    }
}

impl crate::commands::worktree::EventSink for SetupProgressSink<'_> {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        if payload.get("event").and_then(|v| v.as_str()) == Some("step-started") {
            if let Some(command) = payload.get("command").and_then(|v| v.as_str()) {
                self.send(serde_json::json!({
                    "phase": "runningSetup",
                    "command": command,
                }));
                return;
            }
        }
        log::trace!("headless worktree setup event: channel={channel} payload={payload}");
    }
}

/// Stable error category retained for MCP dispatch triage.
pub const HYDRATION_FAILED_PREFIX: &str = "hydration-failed";

/// Establish durable story ownership and essential wiring without a hydration wave.
async fn establish_story_worktree(
    app: &AppHandle,
    ctx: &ActiveContext,
    worktree_dir: &Path,
) -> Result<(), String> {
    let home = ctx.codesense_home.clone();
    let user_id = ctx.user_id;
    let dir = worktree_dir.to_path_buf();

    // Durable ownership supplies source and story location. Preserve the existing
    // error prefix used by callers to park failures for retry.
    let record = read_worktree_record_blocking(&home, user_id, &dir)
        .await
        .map_err(|e| format!("{HYDRATION_FAILED_PREFIX}: record read failed: {e}"))?
        .ok_or_else(|| {
            format!(
                "{HYDRATION_FAILED_PREFIX}: no worktree record for {}",
                dir.display()
            )
        })?;

    // The same idempotent ownership registration as interactive opens. It never writes
    // the story doc, which lives in the canonical clone; the open reports its own drift.
    let app = app.clone();
    crate::commands::await_blocking("establish_story_worktree", move || {
        // RI-2-ALLOW: minted on the blocking pool inside `await_blocking`; the
        // `&BlockingCtx` gates the establishment body, as the Tauri command does.
        crate::commands::async_helpers::with_blocking(|ctx| {
            crate::commands::content_engine::establish_worktree_story_link_blocking(
                ctx,
                &app,
                &dir.to_string_lossy(),
                &record.story_source_path.to_string_lossy(),
                &record.story_id,
                &record.source_repo.to_string(),
            )
        })
    })
    .await
    .map_err(|e| format!("{HYDRATION_FAILED_PREFIX}: establish failed: {e}"))?;

    Ok(())
}

/// Read a worktree record off the command thread (the record read is the barrier's only
/// I/O — SW-GT-29 AC-7 no-jank). A genuinely-absent record is `Ok(None)`; only an I/O /
/// parse error propagates.
async fn read_worktree_record_blocking(
    home: &Path,
    user_id: u64,
    dir: &Path,
) -> Result<Option<WorktreeStoryRecord>, String> {
    let home = home.to_path_buf();
    let dir = dir.to_path_buf();
    crate::commands::await_blocking("gt29_read_worktree_record", move || {
        read_record(&home, &Principal::from(user_id), &dir).map_err(|e| e.to_string())
    })
    .await
}

/// Process-local monotonic counter appended to every minted session id so two
/// spawns in the same clock tick (or a `now()` that fell back to `0`) can never
/// collide — a collision would make the spawn silently tear down the displaced
/// session (review r1).
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

/// Mint a unique PTY session id for an MCP-spawned agent. Carries the `shell-`
/// prefix every terminal session id carries, plus an `mcp-` marker, the
/// clock, AND a process-local sequence so concurrent spawns never collide. (The
/// registry handle is the `storyId`; this is only the PTY correlation id.)
pub fn mint_session_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("shell-mcp-{nanos}-{seq}")
}

/// The basename of the agent binary (e.g. `claude`), for the wait-live probe —
/// mirrors the FE `agentBasename(claudePath)`. The fallback (when the resolved path has no
/// filename) is the preferred runtime's basename, not a literal.
fn agent_basename(claude: &Path) -> String {
    claude
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_else(|| crate::agents::builtin::preferred_binary())
        .to_string()
}

/// SW-WA-F11 — the string that identifies the agent on a telemetry record:
/// the saved Agent key (`alderco/api/backend/triage`) rendered via
/// `ScopedKey`'s Display — always non-empty by construction, so this mirrors
/// `list_sessions`' `agent` field resolution so retrospect readers can join
/// the two. `binary` is accepted for symmetry with other launch helpers but
/// not consulted today.
fn agent_telemetry_id(agent: &crate::agents::launch::AgentLaunch, _binary: &Path) -> String {
    agent.agent.key.to_string()
}

/// The branch drift carried on an open result: the story's recorded branch (`from`,
/// `None` for a story that records none) and the branch its worktree is on (`to`).
/// Nothing is written; the story doc keeps `from` until something else writes it.
/// Serializes to `null` on the wire when there is no drift (already in sync, or the
/// branch was unreadable) via the `Option<BranchReconcile>` it lives in.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct BranchReconcile {
    pub from: Option<String>,
    pub to: String,
}

/// How a launched agent session shows in its workspace: out of sight (a
/// headless agent, in the agents list), or as a tab — focused or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionView {
    Background,
    Tab { focus: bool },
}

/// Where a launched agent session lives in its host's terminal layout: the
/// workspace it belongs to — keyed with the team, as the frontend keys it — and
/// how it shows there. Every agent session is started into the layout.
#[derive(Debug, Clone)]
pub(crate) struct LaunchHome {
    pub workspace: WorkspaceKey,
    pub descriptor: WorkspaceDescriptor,
    pub view: SessionView,
    /// The tab's own working folder when it differs from the workspace's (a story seat
    /// worktree); `None` runs it in the descriptor's `worktree_path`.
    pub tab_cwd: Option<PathBuf>,
}

impl LaunchHome {
    /// The home of a session keyed by `form` (a story's `story_id`, or an
    /// agent's launch handle) in `team_name` of `org_slug`, running in `dir`.
    pub(crate) fn new(
        org_slug: &str,
        team_name: Option<&str>,
        form: &str,
        kind: &str,
        dir: &Path,
        view: SessionView,
    ) -> Self {
        Self {
            workspace: workspace_key(&team_key(org_slug, team_name), form),
            descriptor: WorkspaceDescriptor {
                display_name: form.to_string(),
                kind: kind.to_string(),
                org: Some(org_slug.to_string()),
                team: team_name.map(str::to_string),
                story_id: (kind == "story").then(|| form.to_string()),
                worktree_path: Some(dir.to_path_buf()),
                ..WorkspaceDescriptor::default()
            },
            view,
            tab_cwd: None,
        }
    }
}

/// The outcome of a story launch: the opaque handle (the `story_id`) plus any branch
/// drift seen on open, so `open_workspace` can report where the worktree is against
/// what the story records.
#[derive(Debug, Clone)]
pub(crate) struct LaunchOutcome {
    pub handle: String,
    pub reconciled: Option<BranchReconcile>,
    pub fresh: bool,
    pub warnings: Vec<LaunchWarning>,
}

/// Why a launch through the spine started no session: the shipped spawn cap is saturated
/// (`Busy`), or anything else, carried as its typed message (`denied: …`,
/// `unavailable: …`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LaunchError {
    Busy,
    /// The launch can't use its input (a seat worktree's unknown commit, a dirty re-pin);
    /// nothing was created or changed. A targeted open answers it `invalid`.
    Invalid(String),
    Other(String),
}

impl From<String> for LaunchError {
    fn from(message: String) -> Self {
        LaunchError::Other(message)
    }
}

impl From<super::spawn_cap::SpawnCapError> for LaunchError {
    fn from(err: super::spawn_cap::SpawnCapError) -> Self {
        match err {
            super::spawn_cap::SpawnCapError::Busy => LaunchError::Busy,
        }
    }
}

/// The wire string every string-typed caller already matches on (`busy` for the cap).
impl From<LaunchError> for String {
    fn from(err: LaunchError) -> Self {
        match err {
            LaunchError::Busy => super::spawn_cap::SpawnCapError::Busy.to_string(),
            LaunchError::Invalid(message) => format!("invalid: {message}"),
            LaunchError::Other(message) => message,
        }
    }
}

/// Snapshot the repository identity that a story worker was launched into. This is called
/// after the managed worktree is ready but before the worker starts, so even a fast process exit
/// retains the exact launch-time identity. The returned identifiers contain no token material.
async fn snapshot_story_work_product(
    app: &AppHandle,
    source_repo: SourceRepoSlug,
    canonical_branch: String,
    worktree_dir: &Path,
) -> Option<super::sprint_run::run_store::RunWorkProductProvenance> {
    let (_, user_id) = super::route_to_context::resolve_ambient(app).await.ok()?;
    let principal = Principal::from(user_id);
    let worktree_dir = worktree_dir.to_path_buf();
    let slug = source_repo.clone();
    let (branch, credential_ref) =
        crate::commands::await_blocking("snapshot_run_work_product", move || {
            crate::commands::worktree::verify_worktree_branch(&worktree_dir, &canonical_branch)?;
            let credential_ref = super::attachments::credential_ref_for_source_repo_for_principal(
                &principal, &slug,
            )?;
            Ok((canonical_branch, credential_ref))
        })
        .await
        .ok()?;
    Some(run_work_product_provenance(
        source_repo,
        branch,
        credential_ref,
    ))
}

fn run_work_product_provenance(
    source_repo: SourceRepoSlug,
    branch: String,
    credential_ref: Option<crate::domain::CredentialRef>,
) -> super::sprint_run::run_store::RunWorkProductProvenance {
    super::sprint_run::run_store::RunWorkProductProvenance {
        source_repo,
        branch,
        credential_ref,
    }
}

/// Fill a launch's `RunProvenance.work_product` from the resolved launch identity. This is
/// the ONE work-product fill site on the shared launch spine: every provenance-carrying launch
/// — the interactive `open_workspace` and the automation `dispatch_one` — routes through it, so
/// an automation run's footprint can never be silently gated to the interactive caller. A launch
/// with no provenance (a loop pass, a bare shell) is a no-op here by design. Pure orchestration
/// over the injected `snapshot`; all I/O stays inside `snapshot`. A no-op when the launch carries
/// no provenance or no reconciled branch (no written/recorded frontmatter branch). When a branch
/// resolves, `work_product` is set to the snapshot's result — including `None` when the snapshot
/// degrades (worktree off the branch / detached HEAD, credential/auth miss) — never a stale value.
async fn fill_launch_work_product<F, Fut>(
    provenance: &mut Option<RunProvenance>,
    canonical_branch: Option<String>,
    snapshot: F,
) where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<
        Output = Option<super::sprint_run::run_store::RunWorkProductProvenance>,
    >,
{
    if let (Some(provenance), Some(branch)) = (provenance.as_mut(), canonical_branch) {
        provenance.work_product = snapshot(branch).await;
    }
}

/// Compare the story's recorded `branch` with the branch the worktree is on. It only
/// reads: the story doc lives in the canonical context clone, which an open must leave
/// unchanged, so a drift is reported and never written back. The recorded branch comes
/// from the same managed-doc oracle `ensure_story_worktree` uses; a cache miss is a
/// silent skip that never fails the launch.
fn reconcile_branch_on_open(
    app: &AppHandle,
    story_id: &str,
    worktree_dir: &Path,
) -> (Option<BranchReconcile>, Option<String>) {
    let Some(shared) = app.try_state::<crate::install::frontmatter_cache::SharedFrontmatterCache>()
    else {
        return (None, None);
    };
    let cache = crate::install::frontmatter_cache::FrontmatterCache::snapshot(&shared);
    let Ok(entry) = cache.single_by_story_id(story_id) else {
        return (None, None);
    };
    let from = entry.story_branch().map(str::to_string);
    reconcile_on_open_core(&entry.path, from, worktree_dir)
}

/// Pure core of [`reconcile_branch_on_open`]: reads the worktree's HEAD and returns the
/// drift to report and the branch the launch works on (HEAD, else the recorded `from`).
/// `story_path` is only logged; nothing is written.
fn reconcile_on_open_core(
    story_path: &Path,
    from: Option<String>,
    worktree_dir: &Path,
) -> (Option<BranchReconcile>, Option<String>) {
    let head = crate::commands::worktree::current_branch_of_worktree(worktree_dir);
    let canonical_branch = head.clone().or_else(|| from.clone());
    let reconciled = reconcile_report(from, head);
    if let Some(drift) = &reconciled {
        log::debug!(
            "{} records branch {:?}, its worktree is on {}; not written",
            story_path.display(),
            drift.from,
            drift.to
        );
    }
    (reconciled, canonical_branch)
}

/// Pure decision (unit-testable, no I/O): given the story's recorded branch (`from`)
/// and the worktree's HEAD branch (`head`, `None` on a detached or unreadable HEAD),
/// produce the drift to report. `Some` only when the two differ; a story already on
/// its worktree's branch reports `None`, with no noisy "X → X" line.
pub(crate) fn reconcile_report(
    from: Option<String>,
    head: Option<String>,
) -> Option<BranchReconcile> {
    let to = head?;
    if from.as_deref() == Some(to.as_str()) {
        return None;
    }
    Some(BranchReconcile { from, to })
}

/// Launch a headless story agent session into its existing managed worktree and
/// return its outcome (the handle — the `storyId`, an abstract address, never a
/// raw sessionId — plus any SW-OR-1b branch reconcile). See the module doc for scope.
///
/// The gate ([`InteractiveGate::admit`] + SW-WA-F5's [`admit_workspace_mode`]) runs
/// in the caller BEFORE this; the cap ([`DashboardLaunchState::begin`]) is acquired
/// here so a saturated cap fails fast with `busy` and a mid-launch failure aborts the
/// reservation (never leaks a slot).
///
/// Returns `Err(String)` carrying a typed message (`busy` / `denied: …` /
/// `unavailable: …`); the caller maps it onto the MCP error.
///
/// [`InteractiveGate::admit`]: super::interactive_gate::InteractiveGate::admit
/// [`admit_workspace_mode`]: super::interactive_gate::InteractiveGate::admit_workspace_mode
pub async fn launch_story_session(
    app: &AppHandle,
    story_id: &str,
    org: Option<&str>,
    initial_prompt: Option<&str>,
    agent: crate::agents::launch::AgentLaunch,
    provenance: Option<RunProvenance>,
    view: SessionView,
) -> Result<LaunchOutcome, String> {
    launch_story_session_by(
        app,
        story_id,
        org,
        initial_prompt,
        agent,
        provenance,
        view,
        None,
    )
    .await
}

/// [`launch_story_session`] for a launch an agent session asked for: `launched_by` is that
/// session, from its verified connection, and becomes the launch's launcher. `org` is the
/// caller's hint for the story's org (see [`resolve_story_owner`]).
#[allow(clippy::too_many_arguments)]
pub async fn launch_story_session_by(
    app: &AppHandle,
    story_id: &str,
    org: Option<&str>,
    initial_prompt: Option<&str>,
    agent: crate::agents::launch::AgentLaunch,
    provenance: Option<RunProvenance>,
    view: SessionView,
    launched_by: Option<String>,
) -> Result<LaunchOutcome, String> {
    launch_story_session_typed(
        app,
        story_id,
        initial_prompt,
        StoryLaunchOptions {
            handle: None,
            seat: None,
            org: org.map(str::to_string),
            provenance,
            view,
            record: story_launch_record(story_id, launched_by),
            agent,
        },
    )
    .await
    .map_err(String::from)
}

/// The trusted story entry's record, also used by the legacy open.
pub(crate) fn story_launch_record(story_id: &str, launched_by: Option<String>) -> LaunchRecord {
    LaunchRecord {
        meta: LaunchMeta {
            launched_by,
            story: Some(story_id.into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

/// What a story launch does around its spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StoryLaunchPlan {
    /// Converge the story's `branch` frontmatter to the cwd's branch.
    pub reconcile: bool,
    /// Snapshot the story branch's work product into the launch provenance.
    pub snapshot: bool,
}

/// The one decision between a shared-worktree launch and a seat launch. Without a seat
/// a launch runs exactly as it always has, with the branch reconcile and the
/// work-product snapshot. A seat launch does neither, so it never re-points the story's
/// branch.
pub(crate) fn story_launch_plan(seat: Option<&SeatLaunch>) -> StoryLaunchPlan {
    let shared = seat.is_none();
    StoryLaunchPlan {
        reconcile: shared,
        snapshot: shared,
    }
}

/// Where a story session lives and runs. The workspace is always the story's, and its
/// descriptor names the story's base worktree `story_dir`, so every tab of the story
/// shares one workspace. A seat session's own folder `seat_dir` is its tab's cwd only:
/// the host runs and counts the tab there and never moves the workspace to it. Returns
/// the home and the spawn's cwd.
pub(crate) fn story_launch_home(
    org_slug: &str,
    team_name: Option<&str>,
    story_id: &str,
    story_dir: &Path,
    seat_dir: Option<PathBuf>,
    view: SessionView,
) -> (LaunchHome, PathBuf) {
    let mut home = LaunchHome::new(org_slug, team_name, story_id, "story", story_dir, view);
    let cwd = seat_dir.clone().unwrap_or_else(|| story_dir.to_path_buf());
    home.tab_cwd = seat_dir;
    (home, cwd)
}

/// Create or reuse the seat worktree `seat` of `story_id` and register it as a seat
/// record of the story before its session spawns, so the managed-launch gate and every
/// per-root feature (launch-time prepare, `hydrate_story`, `reverse_sync_worktree`,
/// usage attribution) accept its folder. The caller holds the story's prepare lock and
/// has already resolved the story's base worktree. A branch seat runs the repo's
/// worktree.yaml setup when it is new or its setup never completed; a commit seat never
/// does. Input the seat can't use (an unknown commit, a dirty re-pin, a seat of the other
/// kind) is [`LaunchError::Invalid`], with nothing created or changed.
async fn ensure_seat_worktree(
    app: &AppHandle,
    ctx: &ActiveContext,
    story_id: &str,
    seat: &SeatLaunch,
) -> Result<PathBuf, LaunchError> {
    use crate::commands::worktree::seat::{
        seat_needs_setup, seat_worktree_inner, seat_worktree_path, SeatError,
    };

    let checkout = resolve_story_checkout(app, ctx, story_id)?;
    // A folder registered to anything but this seat of this story is refused before git
    // creates a worktree or a branch there.
    let path = seat_worktree_path(
        &checkout.clone_path,
        &checkout.branch,
        &seat.name,
        &checkout.config.worktree_dir,
    )
    .map_err(|e| format!("denied: {e}"))?;
    let existing =
        read_record(&ctx.codesense_home, &ctx.principal(), &path).map_err(|e| e.to_string())?;
    seat_record_fits(ctx, story_id, &path, existing.as_ref()).map_err(LaunchError::Invalid)?;
    let outcome = {
        let repo = checkout.clone_path.clone();
        let branch = checkout.branch.clone();
        // The folder whose record was just checked: rendered once, created there.
        let path = path.clone();
        let seat = seat.clone();
        crate::commands::await_blocking("ensure_seat_worktree", move || {
            Ok(seat_worktree_inner(
                &repo,
                &branch,
                &seat.name,
                &seat.worktree,
                &path,
            ))
        })
        .await?
    }
    .map_err(|error| match error {
        SeatError::Invalid(reason) => LaunchError::Invalid(reason),
        SeatError::Failed(reason) => LaunchError::Other(format!(
            "denied: seat worktree for story '{story_id}' failed: {reason}"
        )),
    })?;
    let setup = seat_needs_setup(
        outcome.seat.kind,
        outcome.created,
        existing.as_ref().map(|record| record.setup_complete),
    );
    register_seat_record(
        ctx,
        &outcome.path,
        existing,
        outcome.seat,
        checkout.slug,
        story_id,
        checkout.story_source_path,
        !setup,
    )?;
    establish_story_worktree(app, ctx, &outcome.path).await?;
    if setup {
        let prepared = PreparedStoryWorktree {
            dir: outcome.path.clone(),
            clone_path: checkout.clone_path,
            org_root: checkout.org_root,
            authority: checkout.authority,
            config: checkout.config,
        };
        run_managed_story_setup(app, ctx, &prepared, story_id).await?;
    }
    Ok(outcome.path)
}

/// Whether the record already at a seat folder, if any, is a seat of `story_id` (a
/// relaunch). A base worktree or another story's folder is never taken over.
fn seat_record_fits(
    ctx: &ActiveContext,
    story_id: &str,
    path: &Path,
    existing: Option<&WorktreeStoryRecord>,
) -> Result<(), String> {
    match existing {
        Some(record)
            if record.story_id != story_id
                || record.org_slug != ctx.org_slug
                || !record.is_seat() =>
        {
            Err(format!(
                "{} is already registered as another worktree; remove it, or launch the seat under another name",
                path.display()
            ))
        }
        _ => Ok(()),
    }
}

/// Write the seat record of `story_id` for the seat worktree at `path`. `existing` is the
/// record already there, which [`seat_record_fits`] has accepted.
#[allow(clippy::too_many_arguments)]
fn register_seat_record(
    ctx: &ActiveContext,
    path: &Path,
    existing: Option<WorktreeStoryRecord>,
    seat: SeatRecord,
    source_repo: SourceRepoSlug,
    story_id: &str,
    story_source_path: PathBuf,
    setup_complete: bool,
) -> Result<(), String> {
    let mut record = match existing {
        Some(record) => record,
        None => WorktreeStoryRecord::new(
            path.to_path_buf(),
            ctx.org_slug.clone(),
            source_repo,
            story_id.to_string(),
            story_source_path,
        ),
    };
    record.seat = Some(seat);
    record.setup_complete = setup_complete;
    write_record(&ctx.codesense_home, &ctx.principal(), &record)
        .map_err(|e| format!("denied: failed to link seat worktree for story '{story_id}': {e}"))
}

/// [`launch_story_session`] with the spawn cap's `busy` kept typed.
pub(crate) async fn launch_story_session_typed(
    app: &AppHandle,
    story_id: &str,
    initial_prompt: Option<&str>,
    mut options: StoryLaunchOptions,
) -> Result<LaunchOutcome, LaunchError> {
    // Sessions of one story (its own and its named ones) share its worktree unless a named
    // one asks for its own seat worktree: preparing them and converging the story's branch
    // run one launch at a time per story, while the spawns run under their own handles.
    // Counted before the prepare lock is waited for, until the session has spawned: a
    // seat cleanup holding the lock now leaves this seat alone.
    let _seat_launch = SeatLaunchClaim::new(story_id, options.seat.as_ref());
    let plan = story_launch_plan(options.seat.as_ref());
    let prepare = with_story_prepare_lock(story_id, async {
        let (ctx, story_dir, source_repo, owning_team) =
            resolve_hydrated_story_worktree_unlocked(app, story_id, options.org.as_deref()).await?;
        let seat_dir = match options.seat.as_ref() {
            Some(seat) => Some(ensure_seat_worktree(app, &ctx, story_id, seat).await?),
            None => None,
        };
        // Compare the story's recorded `branch` with the worktree's HEAD before binding
        // the session, and report a drift without writing the story doc. Runs on every
        // launch path (open_workspace + sprint-run). A seat launch skips it: its worktree
        // is on the seat's branch, or detached.
        let (reconciled, canonical_branch) = if plan.reconcile {
            reconcile_branch_on_open(app, story_id, &story_dir)
        } else {
            (None, None)
        };
        if plan.snapshot {
            fill_launch_work_product(&mut options.provenance, canonical_branch, |branch| {
                snapshot_story_work_product(app, source_repo, branch, &story_dir)
            })
            .await;
        }
        Ok::<_, LaunchError>((ctx, story_dir, seat_dir, reconciled, owning_team))
    });
    let (ctx, story_dir, seat_dir, reconciled, owning_team) = prepare.await?;
    // The session lives in the story's workspace — keyed by team + `story_id`,
    // the key the frontend's story workspace has — and runs in its seat folder, if any.
    let (home, worktree_dir) = story_launch_home(
        &ctx.org_slug,
        ctx.team_name.as_deref(),
        story_id,
        &story_dir,
        seat_dir,
        options.view,
    );
    // The story's own team, where the session's inbox lives; a caller that already
    // named one keeps it.
    options.record.meta.team.get_or_insert(owning_team);
    options.record.meta.story = Some(story_id.to_string());

    // SW-SR-11: the story_id (or a named `<storyId>#<name>`) is the launch handle, the
    // worktree dir is the cwd — everything from the managed-surface guard down is
    // target-agnostic and shared with the whole-epic dir dispatch
    // (`launch_managed_dir_session`). Fresh-vs-focus is irrelevant here (both are an
    // idempotent success for a story launch). The workspace stays keyed by `story_id`, so a
    // named session opens as another tab in the story's workspace.
    let handle = options
        .handle
        .take()
        .unwrap_or_else(|| story_id.to_string());
    launch_managed_dir_session_typed(
        app,
        &handle,
        &worktree_dir,
        &ctx.codesense_home,
        initial_prompt,
        ManagedLaunchOptions {
            provenance: options.provenance,
            record: options.record,
            extra_args: Vec::new(),
            home,
            agent: options.agent,
        },
    )
    .await
    .map(|mut outcome| {
        outcome.reconciled = reconciled;
        outcome
    })
}

/// SW-GT-35 (refactor): resolve a story's managed, GT-29-**hydrated** worktree — the shared
/// prologue of [`launch_story_session`] and the SW-GT-35 agent-probe launch, so the hydration
/// barrier is spelled ONCE. Validates the story is a managed doc (trusted-side), derives the
/// active context, resolves (or materializes) the story's worktree, and WAITS for it to reach a
/// terminal `Synced` state before returning `(ctx, worktree_dir, source_repo, owning_team)`. The caller then hands the
/// `worktree_dir` to [`launch_managed_dir_session`] under whatever launch handle it chooses (the
/// `story_id` for a story session; a probe `run_id` for an agent probe — distinct handles, one
/// hydration path). `org` is the caller's hint for the story's org (see [`resolve_story_owner`]).
pub(crate) async fn resolve_hydrated_story_worktree(
    app: &AppHandle,
    story_id: &str,
    org: Option<&str>,
) -> Result<(ActiveContext, PathBuf, SourceRepoSlug, LaunchTeam), String> {
    with_story_prepare_lock(
        story_id,
        resolve_hydrated_story_worktree_unlocked(app, story_id, org),
    )
    .await
}

/// Run `work` (preparing `story_id`'s worktree) while no other launch prepares the same
/// story, so concurrent launches into one cold story create and set up its worktree once.
pub(crate) async fn with_story_prepare_lock<T>(
    story_id: &str,
    work: impl std::future::Future<Output = T>,
) -> T {
    let _claim = story_prepare_claim(story_id).await;
    work.await
}

/// Hold `story_id`'s prepare lock (see [`with_story_prepare_lock`]) while the claim lives.
async fn story_prepare_claim(story_id: &str) -> super::workspace_open::OpenClaim {
    static PREPARING: std::sync::OnceLock<super::workspace_open::OpenClaims> =
        std::sync::OnceLock::new();
    PREPARING
        .get_or_init(Default::default)
        .claim(story_id)
        .await
}

type SeatLaunchCounts = std::sync::Mutex<std::collections::BTreeMap<(String, String), usize>>;

/// Seat launches under way, counted by story id and seat name, from the start of
/// [`launch_story_session_typed`] until its session has spawned or the launch failed.
fn seat_launches() -> &'static SeatLaunchCounts {
    static LAUNCHES: std::sync::OnceLock<SeatLaunchCounts> = std::sync::OnceLock::new();
    LAUNCHES.get_or_init(Default::default)
}

/// A seat launch's count in [`seat_launches`], given back when it is dropped. A launch
/// without a seat counts nothing.
pub(crate) struct SeatLaunchClaim(Option<(String, String)>);

impl SeatLaunchClaim {
    pub(crate) fn new(story_id: &str, seat: Option<&SeatLaunch>) -> Self {
        let key = seat.map(|seat| (story_id.to_string(), seat.name.clone()));
        if let Some(key) = &key {
            let mut launches = seat_launches().lock().unwrap_or_else(|e| e.into_inner());
            *launches.entry(key.clone()).or_default() += 1;
        }
        Self(key)
    }
}

impl Drop for SeatLaunchClaim {
    fn drop(&mut self) {
        let Some(key) = self.0.take() else {
            return;
        };
        let mut launches = seat_launches().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = launches.get_mut(&key) {
            *count -= 1;
            if *count == 0 {
                launches.remove(&key);
            }
        }
    }
}

/// Whether a launch of the seat `name` of `story_id` is under way.
pub(crate) fn seat_launch_in_flight(story_id: &str, name: &str) -> bool {
    seat_launches()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&(story_id.to_string(), name.to_string()))
}

/// The records of `story_id` a seat cleanup looks at: its seat worktrees (only the seat
/// `only`, when given), without one whose launch `in_flight` says is under way. A base
/// worktree is never one of them.
pub(crate) fn seats_to_reap(
    records: Vec<WorktreeStoryRecord>,
    story_id: &str,
    only: Option<&str>,
    in_flight: impl Fn(&str) -> bool,
) -> Vec<WorktreeStoryRecord> {
    records
        .into_iter()
        .filter(|record| record.story_id == story_id)
        .filter(|record| {
            record.seat.as_ref().is_some_and(|seat: &SeatRecord| {
                only.is_none_or(|name| name == seat.name) && !in_flight(&seat.name)
            })
        })
        .collect()
}

/// How long a seat cleanup waits: for the sessions a close ended to exit before it keeps
/// their seat worktree as `live`, and for the story's prepare lock (`None`: as long as it
/// takes). A seat whose lock isn't free in time is left to the next sweep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SeatWaits {
    pub exit: Duration,
    pub lock: Option<Duration>,
}

/// A close's waits: a launch can hold the story's lock through its setup, and a close
/// doesn't wait for that.
pub(crate) const SEAT_CLOSE_WAITS: SeatWaits = SeatWaits {
    exit: Duration::from_secs(5),
    lock: Some(Duration::from_secs(2)),
};

/// Clean up the seat worktrees of `story_id` (only the seat `only`, when given) with
/// [`reap_seat_worktree`](crate::commands::worktree::reap_seat_worktree). Every cleanup
/// trigger comes here: a seat tab's close, a workspace close and the sweep after a story
/// launch. Returns the seat worktrees removed.
pub(crate) async fn reap_story_seats(
    app: &AppHandle,
    story_id: &str,
    only: Option<&str>,
    waits: SeatWaits,
) -> Vec<PathBuf> {
    let ctx: Option<crate::content_engine::ResolverContext> = app
        .try_state::<std::sync::Arc<crate::content_engine::sync::WaveCoordinator>>()
        .and_then(|coord| coord.active_ctx());
    let Some(ctx) = ctx else {
        return Vec::new();
    };
    let probe = crate::commands::worktree::AppSeatProbe(app);
    reap_seats_of(
        &probe,
        &ctx.codesense_home,
        &ctx.principal(),
        story_id,
        only,
        waits,
    )
    .await
}

/// [`reap_story_seats`] over the records at `home`. A story with no seat to clean up (no
/// seat record by that name) returns at once, without the prepare lock. Otherwise the
/// seats run under the story's prepare lock, so no launch prepares the story meanwhile,
/// read again once it is held; a seat whose launch is under way is skipped.
pub(crate) async fn reap_seats_of(
    probe: &impl crate::commands::worktree::SeatProbe,
    home: &Path,
    principal: &Principal,
    story_id: &str,
    only: Option<&str>,
    waits: SeatWaits,
) -> Vec<PathBuf> {
    use crate::commands::worktree::{reap_seat_worktree, SeatReap};
    let seats = || {
        let records = crate::install::worktree_index::find_by_story_id(home, principal, story_id)
            .unwrap_or_default();
        seats_to_reap(records, story_id, only, |name| {
            seat_launch_in_flight(story_id, name)
        })
    };
    if matches!(seats()[..], []) {
        return Vec::new();
    }
    let claim = story_prepare_claim(story_id);
    let _claim = match waits.lock {
        None => claim.await,
        Some(wait) => match tokio::time::timeout(wait, claim).await {
            Ok(claim) => claim,
            Err(_) => return Vec::new(),
        },
    };
    let mut removed = Vec::new();
    for record in seats() {
        let reap = reap_seat_worktree(probe, home, principal, &record, waits.exit).await;
        if reap == Some(SeatReap::Reaped) {
            removed.push(record.code_repo_path);
        }
    }
    removed
}

/// Start the sweep of `story_id`'s seat worktrees ([`reap_story_seats`]) in the
/// background, after a story launch: it covers seats whose sessions crashed or exited
/// without a close. Never awaited by the launch.
pub(crate) fn spawn_seat_sweep(app: &AppHandle, story_id: &str) {
    let (app, story_id) = (app.clone(), story_id.to_string());
    tauri::async_runtime::spawn(async move {
        let waits = SeatWaits {
            exit: Duration::ZERO,
            lock: None,
        };
        let removed = reap_story_seats(&app, &story_id, None, waits).await;
        log::debug!("seat sweep for {story_id} removed {removed:?}");
    });
}

/// [`resolve_hydrated_story_worktree`] without the per-story lock; the caller holds it.
async fn resolve_hydrated_story_worktree_unlocked(
    app: &AppHandle,
    story_id: &str,
    org: Option<&str>,
) -> Result<(ActiveContext, PathBuf, SourceRepoSlug, LaunchTeam), String> {
    // The story's OWNING org, never assumed to be the active one (see
    // `resolve_story_owner`), so an open or fire into a synced NON-active org resolves
    // there. Ambient (home/principal) + the active org come from the active context;
    // both are user-global, so they anchor the cross-org lookups for any org.
    let StoryOwner {
        active,
        records,
        org: target_org,
        team: owning_team,
    } = resolve_story_owner(app, story_id, org).await?;

    // The context to hydrate + spawn under: the active one when the story is in the
    // active org AND team (no rebuild), else the owning team context (SW-AU-24, resolved
    // WITHOUT touching `ActiveTeamState` so the viewport is undisturbed).
    let ctx = if target_org == active.org_slug
        && active.team_name.as_deref() == Some(owning_team.as_str())
    {
        active
    } else {
        match derive_context_for(app, &target_org, &owning_team).await? {
            ContextResolution::Ok(c) => c,
            other => {
                return Err(format!(
                    "unavailable: cannot resolve context for {target_org}:{owning_team} ({other:?})"
                ))
            }
        }
    };

    // A durable setup-complete registration is ready regardless of historical
    // sync status. Incomplete setup is retried without hydrating context.
    let existing = story_base_record(&records, story_id, &ctx.org_slug);
    let worktree_dir = match existing {
        Some(rec) if rec.setup_complete => {
            let dir = rec.code_repo_path.clone();
            establish_story_worktree(app, &ctx, &dir).await?;
            dir
        }
        _ => {
            let prepared = ensure_story_worktree(app, &ctx, story_id).await?;
            establish_story_worktree(app, &ctx, &prepared.dir).await?;
            run_managed_story_setup(app, &ctx, &prepared, story_id).await?;
            prepared.dir
        }
    };
    let source_repo = if let Some(source_repo) =
        story_worktree_source_repo(&records, story_id, &ctx.org_slug, &worktree_dir)
    {
        source_repo
    } else {
        let home = ctx.codesense_home.clone();
        let principal = ctx.principal();
        let dir = worktree_dir.clone();
        let story_id = story_id.to_string();
        let org_slug = ctx.org_slug.clone();
        crate::commands::await_blocking("read_launch_worktree_identity", move || {
            read_record(&home, &principal, &dir)
                .map_err(|error| error.to_string())?
                .filter(|record| record.story_id == story_id && record.org_slug == org_slug)
                .map(|record| record.source_repo)
                .ok_or_else(|| "unavailable: worktree repository identity is missing".to_string())
        })
        .await?
    };
    let owning_team = LaunchTeam {
        org: target_org,
        team: owning_team,
    };
    Ok((ctx, worktree_dir, source_repo, owning_team))
}

/// The org and team a story belongs to, as the story launch resolves them, plus the
/// active context and worktree records the lookup read.
pub(crate) struct StoryOwner {
    pub active: ActiveContext,
    pub records: Vec<WorktreeStoryRecord>,
    pub org: String,
    pub team: String,
}

/// Resolve the org and team `story_id` belongs to, whichever team the app has selected
/// (see [`pick_story_org`]), then the story doc in that org names its team. `org` is the
/// caller's hint: the `org` an open names, or a team agent's own org. Rejects an unknown
/// or ambiguous id. The one lookup [`resolve_hydrated_story_worktree`] launches under, so
/// anything resolved against the story's team (a launch profile) matches its worktree.
pub(crate) async fn resolve_story_owner(
    app: &AppHandle,
    story_id: &str,
    org: Option<&str>,
) -> Result<StoryOwner, String> {
    let active = derive_active_context(app).await?;
    let records = iter_story_records(&active.codesense_home, &active.principal())
        .map_err(|e| e.to_string())?;
    // Off the runtime: this runs inside detached dispatch tasks, and a lookup in a
    // non-active org may cold-build (or rescan) that org's index.
    let (target_org, resolution) = {
        let app = app.clone();
        let active = active.clone();
        let records = records.clone();
        let story_id = story_id.to_string();
        let hint = org.map(str::to_string);
        crate::commands::await_blocking("resolve_story_owner", move || {
            let synced = || -> Result<Vec<String>, String> {
                let mut orgs = vec![active.org_slug.clone()];
                orgs.extend(
                    crate::mcp::setup_tools::synced_org_slugs(
                        &active.codesense_home,
                        active.user_id,
                    )?
                    .into_iter()
                    .filter(|org| *org != active.org_slug),
                );
                Ok(orgs)
            };
            pick_story_org_in(&app, &active, &records, &story_id, hint.as_deref(), synced)
        })
        .await?
    };
    Ok(StoryOwner {
        active,
        records,
        org: target_org,
        team: resolution.team,
    })
}

/// [`pick_story_org`] against the app's story indexes, as a person sees them. An org whose
/// index the lookup itself built is not rescanned: that build was already a fresh scan.
/// Blocking.
pub(crate) fn pick_story_org_in<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    active: &ActiveContext,
    records: &[WorktreeStoryRecord],
    story_id: &str,
    hint: Option<&str>,
    synced_orgs: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<(String, StoryPathResolution), String> {
    use crate::commands::dashboard_launch as launch;
    let human = crate::context_repo::caller_scope::CallerScope::Human;
    let built = std::cell::RefCell::new(Vec::<String>::new());
    pick_story_org(
        records,
        story_id,
        hint,
        synced_orgs,
        |org| {
            if !launch::org_index_held(app, org) {
                built.borrow_mut().push(org.to_string());
            }
            launch::resolve_story_path_in_org_for(app, active, org, story_id, &human)
        },
        |org| {
            if built.borrow().iter().any(|built| built == org) {
                return None;
            }
            launch::rescan_story_path_in_org(app, active, org, story_id, &human)
        },
    )
}

/// The org `story_id` lives in, with its resolution there:
/// 1. its worktree record's org (only a record in `hint` when there is one); with no
///    hint, records in two orgs are refused as ambiguous;
/// 2. else `hint`, the only org looked in;
/// 3. else every org `synced_orgs` lists (active first): exactly one holding the id wins,
///    more than one is refused as ambiguous, none is `no managed story`.
///
/// A team agent always passes its own org as `hint`, so it never searches other orgs.
/// `lookup` resolves the id in one org's index; `rescan` resolves it in a fresh scan of
/// a held org (`None` when there is nothing to rescan). A miss rescans each org at most
/// once: a looked-up org on its miss, a search only when no org holds the id. A miss is a
/// not-found (its first line, so the active org's multi-line text counts) or a scoped
/// `MISSING`. Ok, a duplicate id within one org, a doc with no team or a "story file
/// candidate" (a file there names the id but does not carry it) counts as that org holding
/// the id, so a search never opens another org's story past it; any other error (an index
/// not ready yet) is returned as is. A hinted lookup still rescans on a candidate: a fixed
/// file resolves on the rescan.
pub(crate) fn pick_story_org(
    records: &[WorktreeStoryRecord],
    story_id: &str,
    hint: Option<&str>,
    synced_orgs: impl FnOnce() -> Result<Vec<String>, String>,
    mut lookup: impl FnMut(&str) -> Result<StoryPathResolution, String>,
    mut rescan: impl FnMut(&str) -> Option<Result<StoryPathResolution, String>>,
) -> Result<(String, StoryPathResolution), String> {
    use crate::commands::dashboard_launch::is_story_not_found;
    let not_found = format!("unavailable: no managed story with id '{story_id}'");
    let missed = |found: &Result<StoryPathResolution, String>| {
        !holds_story(found, story_id)
            && matches!(found, Err(error)
                if is_story_not_found(error) || error == crate::context_repo::caller_scope::MISSING)
    };
    let ambiguous = |orgs: &[&str]| {
        format!(
            "unavailable: ambiguous story id '{story_id}': it is in orgs {}; pass org",
            orgs.join(", ")
        )
    };
    let mut recorded = records
        .iter()
        .filter(|r| r.story_id == story_id && hint.is_none_or(|org| r.org_slug == org))
        .map(|r| r.org_slug.as_str());
    let first = recorded.next();
    if let Some(org) = first {
        if let Some(other) = recorded.find(|other| *other != org) {
            return Err(ambiguous(&[org, other]));
        }
    }
    if let Some(org) = first.or(hint) {
        let found = lookup(org);
        // Only a not-found rescans: a scoped MISSING is a story the caller cannot see.
        let found = match found {
            Err(error) if is_story_not_found(&error) => rescan(org).unwrap_or(Err(error)),
            found => found,
        };
        return found.map(|resolution| (org.to_string(), resolution));
    }
    let orgs = synced_orgs()?;
    let mut holders: Vec<(&str, Result<StoryPathResolution, String>)> = Vec::new();
    for org in orgs.iter().map(String::as_str) {
        let found = lookup(org);
        if !missed(&found) {
            holders.push((org, found));
        }
    }
    if holders.is_empty() {
        for org in orgs.iter().map(String::as_str) {
            match rescan(org) {
                Some(found) if !missed(&found) => holders.push((org, found)),
                _ => {}
            }
        }
    }
    if let Some((_, Err(error))) = holders
        .iter()
        .find(|(_, found)| !holds_story(found, story_id))
    {
        return Err(error.clone());
    }
    match holders.len() {
        0 => Err(not_found),
        1 => {
            let (org, found) = holders.remove(0);
            found.map(|resolution| (org.to_string(), resolution))
        }
        _ => {
            let orgs: Vec<&str> = holders.iter().map(|(org, _)| *org).collect();
            Err(ambiguous(&orgs))
        }
    }
}

/// Whether a lookup's result says its org has `story_id`: resolved, or refused for a
/// duplicate id, a doc with no team or a candidate file that does not carry the id there
/// (see `resolve_story_path_in` and `resolve_story_path_with_fallback`).
fn holds_story(found: &Result<StoryPathResolution, String>, story_id: &str) -> bool {
    match found {
        Ok(_) => true,
        Err(error) => {
            let first = error.lines().next().unwrap_or_default();
            error.starts_with(&format!("unavailable: ambiguous story id '{story_id}' ("))
                || *error
                    == format!(
                        "unavailable: story '{story_id}' has no team (malformed frontmatter?)"
                    )
                || (first.starts_with("unavailable: story file candidate at ")
                    && first.ends_with(&format!(" does not carry story_id '{story_id}'")))
        }
    }
}

/// The record of `story_id`'s base worktree in `org_slug`: never one of its seat
/// worktrees, so the story's own session and its shared named ones always land in the
/// base worktree.
fn story_base_record<'a>(
    records: &'a [WorktreeStoryRecord],
    story_id: &str,
    org_slug: &str,
) -> Option<&'a WorktreeStoryRecord> {
    base_story_records(records).find(|r| r.story_id == story_id && r.org_slug == org_slug)
}

fn story_worktree_source_repo(
    records: &[WorktreeStoryRecord],
    story_id: &str,
    org_slug: &str,
    worktree_dir: &Path,
) -> Option<SourceRepoSlug> {
    records
        .iter()
        .find(|record| {
            record.story_id == story_id
                && record.org_slug == org_slug
                && record.code_repo_path == worktree_dir
        })
        .map(|record| record.source_repo.clone())
}

/// SW-SR-11: the target-agnostic launch spine — the reserved→bound half shared by
/// [`launch_story_session`] (a story's managed worktree) and the whole-epic dir dispatch
/// (a hydrated managed epic dir). Given a resolved managed `cwd` + an abstract `handle`
/// (a `story_id`, or the epic's `_epic/{id}` slug), it runs: managed-surface guard →
/// `resolve_launch_binary` → reserve the cap slot (idempotent per handle) → `spawn_and_bind`
/// → `abort` on failure. The caller resolves the `cwd`; from the safety guard down the two
/// paths are identical, so neither forks the cap/spawn/bind logic.
///
/// Returns `Ok(true)` when a **fresh** worker was spawned+bound, `Ok(false)` when the handle
/// already had a live session and `begin` returned it via idempotent focus (no fresh spawn).
/// The story path treats both as success (it re-derives the handle from `story_id`); the
/// whole-epic path uses the distinction to avoid re-stamping a foreign session's provenance /
/// holding a claim for a worker it did not launch.
pub(crate) struct StoryLaunchOptions {
    /// The session's handle: `None` is the story id; a named session beside it in the
    /// same workspace passes `<storyId>#<name>`.
    pub handle: Option<String>,
    /// The seat worktree a named session runs in; `None` is the story's shared worktree.
    pub seat: Option<SeatLaunch>,
    /// The caller's hint for the story's org; see [`resolve_story_owner`].
    pub org: Option<String>,
    pub provenance: Option<RunProvenance>,
    pub record: LaunchRecord,
    pub view: SessionView,
    /// The agent this launch runs; see [`ManagedLaunchOptions::agent`].
    pub agent: crate::agents::launch::AgentLaunch,
}

pub(crate) struct ManagedLaunchOptions {
    pub provenance: Option<RunProvenance>,
    /// Name, launcher and "Started with" line recorded on a fresh reserve.
    pub record: LaunchRecord,
    /// Argv appended after the agent's own args (already shell-quoted: the launch line
    /// joins argv verbatim).
    pub extra_args: Vec<String>,
    /// Where the session lives in its host's terminal layout.
    pub home: LaunchHome,
    /// The agent this launch runs: its launch profile, account and generated permission
    /// entries, and the `agent@revision` recorded on the session and its provenance.
    pub agent: crate::agents::launch::AgentLaunch,
}

/// Whether `cwd` is a managed surface a session may be spawned into, compared
/// symlink-safely: a routine resolves its dir canonically (`/private/tmp/…` on
/// macOS) while the CodeSense home may be spelled through a symlink (`/tmp/…`),
/// which the plain prefix test would refuse (SW-AGR-7, found by the real-app
/// routines suite).
pub(crate) fn managed_launch_dir(cwd: &Path, codesense_home: &Path) -> bool {
    is_codesense_managed_target(cwd, codesense_home)
        || cwd.canonicalize().is_ok_and(|canon| {
            crate::install::worktree_index::is_codesense_managed_target_canon(
                &canon,
                codesense_home,
            )
        })
}

pub(crate) async fn launch_managed_dir_session(
    app: &AppHandle,
    handle: &str,
    cwd: &Path,
    codesense_home: &Path,
    initial_prompt: Option<&str>,
    options: ManagedLaunchOptions,
) -> Result<bool, String> {
    launch_managed_dir_session_typed(app, handle, cwd, codesense_home, initial_prompt, options)
        .await
        .map(|outcome| outcome.fresh)
        .map_err(String::from)
}

/// The MCP and `open_workspace` launch's scope step: the agent's MCP scope and generated
/// entries (with git-ai capture, for a managed worktree) for `session_id` in `cwd`, as the
/// argv, environment, scope creation and settings file the spawn holds.
#[allow(clippy::type_complexity)]
pub(crate) fn project_managed_scope(
    agent: &crate::agents::launch::AgentLaunch,
    session_id: &str,
    cwd: &str,
    cli: &super::mcp_scope::LaunchCli<'_>,
    launch_args: &[String],
) -> Result<
    (
        Vec<String>,
        Vec<(String, String)>,
        Option<super::mcp_scope::ScopeCreation>,
        Option<crate::agents::launch::LaunchSettingsFile>,
    ),
    String,
> {
    let (outcome, creation, applied) = crate::agents::launch::project_and_apply_for_cli(
        agent,
        session_id,
        Path::new(cwd),
        None,
        Some(cli),
        str::to_string,
    )?;
    let mut args = super::mcp_scope::compose_args(launch_args.to_vec(), outcome.extra_args);
    applied.drop_agent_settings(&mut args);
    args.extend(applied.argv(str::to_string));
    Ok((args, outcome.extra_env, creation, applied.settings))
}

/// [`launch_managed_dir_session`] with the spawn cap's `busy` kept typed.
pub(crate) async fn launch_managed_dir_session_typed(
    app: &AppHandle,
    handle: &str,
    cwd: &Path,
    codesense_home: &Path,
    initial_prompt: Option<&str>,
    options: ManagedLaunchOptions,
) -> Result<LaunchOutcome, LaunchError> {
    let ManagedLaunchOptions {
        provenance,
        mut record,
        extra_args,
        home,
        agent,
    } = options;
    record.meta.queue_role = agent.queue_role.clone();
    // The launch runs exactly what `prepare` resolved: the agent's profile, and a provenance
    // that always says which agent revision ran.
    let profile = agent.launch.clone();
    let provenance = Some(agent.provenance(provenance, handle));
    // SW-GW-9's "whitespace ≡ absent" rule: a blank/whitespace `initial_prompt`
    // is treated as absent so it never fires a stray Enter into the fresh agent
    // (review r1 — symmetric with `send_to_session`'s non-empty guard).
    let initial_prompt = initial_prompt.map(str::trim).filter(|p| !p.is_empty());
    // The name it was launched under is its tab's name.
    let tab_name = record.meta.display_name.clone();

    // Belt-and-suspenders materialize-safety: only ever spawn into a managed
    // surface, even if the caller yielded an unexpected path (SLW-FX-13).
    if !managed_launch_dir(cwd, codesense_home) {
        return Err(LaunchError::Other(format!(
            "denied: resolved dir '{}' is not a codesense-managed target",
            cwd.display()
        )));
    }
    // A dir removed on disk (index/handle not yet reaped) — fail with a clear message
    // rather than spawning into a vanished cwd (review r1).
    if !cwd.is_dir() {
        return Err(LaunchError::Other(format!(
            "denied: the launch dir '{}' is gone on disk — re-open it in CodeSense",
            cwd.display()
        )));
    }
    let cwd = cwd.to_string_lossy().to_string();

    // Resolve the agent binary up front (before reserving a cap slot) so a missing CLI
    // fails without leaking a reservation: a typed refusal, never another agent's CLI.
    let launch_binary = resolve_launch_binary(app, &profile.binary).await?;
    let mut launch_args = profile.args.clone();
    launch_args.extend(extra_args);

    let state = app
        .try_state::<DashboardLaunchState>()
        .ok_or_else(|| "unavailable: launch registry not ready".to_string())?;

    // Reserve the cap slot. `busy` on saturation; `false` = this handle already
    // has a session (idempotent focus — return it, don't fork a spawn).
    let fresh = state.begin_with_provenance(handle, provenance, record)?;
    // Until `spawn_and_bind` commits the session, a launch future dropped at any await
    // below aborts this reservation and kills the tab it opened, if any.
    let prebind = PreBindReservation::new(AppPreBindPort(app.clone()), handle, fresh);

    // SW-AU-96B: stamp the launch's managed worktree dir on the entry (fill-gap, focus-safe, like the
    // control keys below) so the completion path diffs the work-product branch for the
    // per-file footprint from an in-memory value — resolved once here while the worktree is live,
    // never re-derived at teardown.
    state.set_worktree_dir_if_absent(handle, std::path::PathBuf::from(&cwd));

    // Install run provenance while the entry is still only reserved. Completion can race the
    // worker immediately after spawn, so stamping after launch would lose the durable join for a
    // fast exit. Interactive launches pass `None` and retain their existing behavior.
    state.set_profile_id_if_absent(handle, profile.id.clone());
    // Only a fresh launch says where the session belongs; a focus leaves it as launched.
    if let (true, Some(org)) = (fresh, home.descriptor.org.clone()) {
        crate::commands::dashboard_launch::stamp_launch_owner(
            app,
            &state,
            handle,
            org,
            home.descriptor.team.clone(),
        )
        .await;
    }

    // SW-OR-15: stash the interactive structured-transcript descriptor (session-log glob + format id)
    // on the entry — same fill-gap / focus-safe posture as the control keys above — so
    // the session-END teardown choke (`record_signal_outcome`) can read the agent's own session log
    // into `{run_id}.turns.json` without re-reading the adapter. `None` = the runtime declares no
    // interactive capability, so the run stays on the neutral outcome+summary spine.
    if let Some(descriptor) = profile.structured_interactive.clone() {
        let capture = match prepare_interactive_capture(descriptor, fresh, &mut launch_args, || {
            Uuid::new_v4().to_string()
        }) {
            Ok(capture) => capture,
            Err(error) => {
                crate::commands::dashboard_launch::abort_and_notify(app, &state, handle);
                return Err(LaunchError::Other(error));
            }
        };
        // Personal launches still count toward their saved agent's usage.
        if let (true, Some(agent_session)) = (fresh, capture.agent_session_id.clone()) {
            crate::session_usage::attribute_launch(
                agent_session,
                home.descriptor.org.clone().unwrap_or_default(),
                home.descriptor.team.clone(),
                profile.id.clone(),
                handle.to_string(),
                Some(cwd.to_string()),
            )
            .await;
        }
        state.set_interactive_capture_if_absent(handle, capture);
    }
    if !fresh {
        return Ok(LaunchOutcome {
            handle: handle.into(),
            reconciled: None,
            fresh: false,
            warnings: vec![],
        });
    }

    // Only a fresh launch runs the agent: an account the preview already knows cannot run it
    // is refused before anything spawns, and a focus never relabels the session it found.
    if let Err(error) = agent.refuse_unusable_account() {
        crate::commands::dashboard_launch::abort_and_notify(app, &state, handle);
        return Err(LaunchError::Other(error));
    }
    state.set_agent_revision_if_absent(handle, agent.revision_label());

    stamp_raw_capture_for_fresh_launch(&state, handle, fresh, profile.capture_raw_terminal);

    // From here we OWN the reservation. `spawn_and_bind` reaps a spawned PTY on
    // its own error paths; this `abort` is the fallback that frees the cap slot
    // when the failure was BEFORE any session existed (no-op once the session was
    // bound + killed, which already freed the slot).
    let result = spawn_and_bind(
        app,
        &state,
        handle,
        home,
        &cwd,
        &launch_binary,
        &launch_args,
        initial_prompt,
        tab_name,
        &agent,
        prebind,
    )
    .await;
    if result.is_err() {
        crate::commands::dashboard_launch::abort_and_notify(app, &state, handle);
    } else {
        // SW-AM-8: an agent-driven launch binds via the registry method (not the
        // `dashboard_launch_bind` command), so it must announce the new session
        // itself to make it appear live in the Agents roster.
        crate::commands::dashboard_launch::emit_session_state_changed(app);
    }
    result
        .map(|spawned| LaunchOutcome {
            handle: handle.into(),
            reconciled: None,
            fresh: true,
            warnings: launch_warnings(spawned, agent.runtime, &launch_binary),
        })
        .map_err(LaunchError::Other)
}

/// A fresh managed launch's warnings: what the spawn raised, then the one for the release of
/// the CLI it spawned, which is the version the dependency check cached when it resolved it.
fn launch_warnings(
    mut spawned: Vec<LaunchWarning>,
    runtime: AgentCli,
    binary: &ResolvedAgentBinary,
) -> Vec<LaunchWarning> {
    spawned.extend(crate::agents::launch_check::cli_version_warning(
        runtime,
        binary.version.as_deref(),
    ));
    spawned
}

fn stamp_raw_capture_for_fresh_launch(
    state: &DashboardLaunchState,
    handle: &str,
    fresh: bool,
    enabled: bool,
) {
    if fresh && enabled {
        state.enable_raw_terminal_capture_for_fresh_launch(handle);
    }
}

pub(crate) fn prepare_interactive_capture(
    descriptor: codesense_pty_core::agent_cli::InteractiveStructured,
    fresh: bool,
    launch_args: &mut Vec<String>,
    mint_session_id: impl FnOnce() -> String,
) -> Result<InteractiveCaptureContext, String> {
    let agent_session_id = match (fresh, descriptor.session_id_argv.as_ref()) {
        (true, Some(template)) => {
            let id = mint_session_id();
            launch_args.extend(adapter::expand_session_id_argv(template, &id)?);
            Some(id)
        }
        _ => None,
    };
    Ok(InteractiveCaptureContext {
        descriptor,
        agent_session_id,
    })
}

/// The agent CLI `binary` a session spawns, resolved BEFORE the cap reservation so a missing
/// CLI never leaks a slot. See [`resolve_agent_for_launch`].
async fn resolve_launch_binary(
    app: &AppHandle,
    binary: &str,
) -> Result<ResolvedAgentBinary, String> {
    resolve_agent_for_launch(app, binary).await
}

/// The one launch-time authority for an agent CLI `basename`: the cached binary when it is
/// still the file that was resolved (a stat, no spawn); when it is gone or changed in place,
/// ONE re-resolution on the blocking pool (single-flight across concurrent launches) that
/// emits `dep-status-changed`; otherwise the typed `unavailable:` refusal of
/// [`launch_refusal`] — never a spawn of a missing file.
pub(crate) async fn resolve_agent_for_launch(
    app: &AppHandle,
    basename: &str,
) -> Result<ResolvedAgentBinary, String> {
    resolve_agent_for_launch_with(app, basename, |deps, name| deps.re_resolve_stale(name)).await
}

/// [`resolve_agent_for_launch`] with the stale-entry re-resolution injected, so tests run
/// the whole authority on a mock app without probing the login shell.
pub(crate) async fn resolve_agent_for_launch_with<R, F>(
    app: &AppHandle<R>,
    basename: &str,
    re_resolve: F,
) -> Result<ResolvedAgentBinary, String>
where
    R: tauri::Runtime,
    F: FnOnce(&DependencyManager, &str) -> (LaunchBinaryLookup, Option<PendingShadowed>)
        + Send
        + 'static,
{
    let Some(deps) = app.try_state::<DependencyManager>() else {
        return launch_lookup_result(basename, LaunchBinaryLookup::Unresolved);
    };
    match deps.launch_binary(basename) {
        LaunchBinaryLookup::Stale => {}
        lookup => return launch_lookup_result(basename, lookup),
    }
    let handle = app.clone();
    let name = basename.to_string();
    let (lookup, re_resolved) =
        super::async_helpers::await_blocking("resolve_agent_for_launch", move || {
            Ok(re_resolve(
                handle.state::<DependencyManager>().inner(),
                &name,
            ))
        })
        .await
        .map_err(|e| format!("unavailable: {basename} re-resolve failed: {e}"))?;
    if let Some(pending) = re_resolved {
        use tauri::Emitter;
        let _ = app.emit("dep-status-changed", ());
        if !pending.candidates.is_empty() {
            let handle = app.clone();
            let name = basename.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                handle
                    .state::<DependencyManager>()
                    .fill_shadowed_after_launch(&name, &pending);
                let _ = handle.emit("dep-status-changed", ());
            });
        }
    }
    launch_lookup_result(basename, lookup)
}

/// A launch-time lookup as the launch's result: a ready binary, else the typed refusal. A
/// lookup still stale after its re-resolution is refused rather than spawned.
fn launch_lookup_result(
    basename: &str,
    lookup: LaunchBinaryLookup,
) -> Result<ResolvedAgentBinary, String> {
    match lookup {
        LaunchBinaryLookup::Ready(binary) => Ok(binary),
        LaunchBinaryLookup::Stale | LaunchBinaryLookup::Unresolved => Err(launch_refusal(basename)),
    }
}

/// The typed `unavailable:` refusal for a launch of `want_binary` with no usable CLI — never a
/// silent fallback to another agent's CLI. A missing preferred-runtime CLI keeps the
/// long-standing "no agent CLI configured" wording. Pure, so the refusal decision is
/// unit-testable without Tauri state.
fn launch_refusal(want_binary: &str) -> String {
    if want_binary == crate::agents::builtin::preferred_binary() {
        "unavailable: no agent CLI configured".to_string()
    } else {
        format!("unavailable: agent '{want_binary}' is not installed or not yet resolved")
    }
}

/// Bind a managed launch's fresh session to its reserved entry, recording the account the
/// spawn staged against this exact runtime claim, as the frontend bind does, so the session
/// can say which account (and so which runtime) it ran as.
fn bind_managed_session(
    state: &DashboardLaunchState,
    accounts: Option<&super::agent_accounts::AgentAccountRuntimeState>,
    handle: &str,
    session_id: &str,
    claim: &super::pty_host::LocalEffectClaim,
) -> Result<(), String> {
    let account_provenance = accounts
        .and_then(|accounts| accounts.owned_provenance(claim))
        .map(Into::into);
    state.bind_owned(
        handle,
        session_id,
        Some(MCP_LAUNCHER),
        account_provenance,
        Some(claim.clone()),
    )
}

/// The reserved→bound half of the spine, mirroring the FE `launchAgentSession`
/// phases exactly:
///  1. **Connect** (spawn PTY → start the agent). A failure here is a *rollback*:
///     the raw PTY is reaped via [`kill_session`] so no shell is orphaned (the FE
///     `connect()` removes its tab on the same failure). Nothing is committed yet.
///  2. **Commit** (`bind` + audit). The session is now panel-observable/killable.
///  3. **Best-effort** (wait-live + seed). A failure here NEVER reaps the bound
///     session — a slow-to-launch agent must not be killed as a false failure
///     (FE `dashboard-launch.ts` r1 MAJOR: "never reap a live, bound, registered
///     agent"). The panel's status/liveness net surfaces a no-show instead.
// The reserved→bound launch spine: a stable, single-call-site signature whose params are
// each a distinct launch input.
#[allow(clippy::too_many_arguments)]
async fn spawn_and_bind(
    app: &AppHandle,
    state: &DashboardLaunchState,
    story_id: &str,
    home: LaunchHome,
    cwd: &str,
    resolved_binary: &ResolvedAgentBinary,
    launch_args: &[String],
    initial_prompt: Option<&str>,
    tab_name: Option<String>,
    agent: &crate::agents::launch::AgentLaunch,
    mut prebind: PreBindReservation<AppPreBindPort>,
) -> Result<Vec<LaunchWarning>, String> {
    let binary = resolved_binary.path.as_path();
    // SW-WA-F11: open a legibility record FIRST — before product prepare, scope
    // projection, tab-open, or anything else that can `?`-return — so the exact
    // pre-tab failures F11 was built to retrospect are recorded with telemetry
    // (`SpawnFailed`), not lost. `start_with_cleanup` installs a `Drop` closure
    // that calls `tracker.forget_in_flight` if `finish` is never reached (a
    // panic / dropped future / early `?` that misses the explicit finalize
    // paths below). The hashmap write is cheap; one entry per launch attempt
    // bounded by [`LATEST_MAP_CAP`].
    let session_id = mint_session_id();
    let session_for_cleanup = session_id.clone();
    let app_for_cleanup = app.clone();
    let mut telemetry = LaunchTelemetryBuilder::start_with_cleanup(
        session_id.clone(),
        agent_telemetry_id(agent, binary),
        // SW-WA-F10 × F11: argv-direct spawn (no shell wrapper, no settle
        // gate). `LaunchMode::Argv` tells the telemetry writer not to expect
        // shell-only fields (`settle_ms` / `injected_at_ms`).
        LaunchMode::Argv,
        move || {
            if let Some(tracker) = app_for_cleanup.try_state::<LaunchTelemetryTracker>() {
                tracker.forget_in_flight(&session_for_cleanup);
            }
        },
    );
    telemetry.set_binary(binary, resolved_binary.version.as_deref());
    if let Some(tracker) = app.try_state::<LaunchTelemetryTracker>() {
        tracker.register_in_flight(&session_id, telemetry.started_at());
    }

    // Helper: write a terminal telemetry record keyed to a pre-bind failure.
    // `AuditEvent::Abort` because the launch never reached a bound session —
    // the audit trail must not claim a Spawn that never happened.
    //
    // Keeping it as a closure keeps the one call site DRY across every pre-tab
    // `?` edge without plumbing a type-erased classification helper.
    macro_rules! fail_pre_bind {
        ($telemetry:expr, $outcome:expr, $msg:expr) => {{
            let msg: String = $msg;
            let record = finalize_launch_telemetry(app, $telemetry, $outcome, Some(msg.clone()));
            spawn_telemetry_audit(
                AuditEvent::Abort,
                story_id.to_string(),
                KIND_DASHBOARD_LAUNCHED,
                record,
            );
            return Err(msg);
        }};
    }

    let product = match crate::agents::product_bootstrap::prepare(app, agent, Path::new(cwd)).await
    {
        Ok(p) => p,
        Err(e) => fail_pre_bind!(telemetry, TelemetryOutcome::SpawnFailed, e),
    };
    let canonical_cwd = product
        .canonical_root()
        .map(|root| root.to_string_lossy().into_owned());
    let cwd = canonical_cwd.as_deref().unwrap_or(cwd);
    if let Err(e) = product.validate() {
        fail_pre_bind!(telemetry, TelemetryOutcome::SpawnFailed, e);
    }
    if let Some(report) = crate::agents::product_bootstrap::BootstrapOutcome::report(&product) {
        // SW-XS-7: the structured Step 2 result for the tool result that
        // reports this launch (`open_workspace` → `prepared`), as a remote
        // launch's outcome carries it.
        crate::agents::prepare::progress::stash_summary(
            story_id,
            crate::agents::prepare::progress::PrepareSummary::of(report),
        );
    }

    // Everything CodeSense adds for this session goes in per-session files outside the
    // workspace, before the spawn so a failure returns without leaking a PTY: the agent's
    // SW-WA-F10: MCP scope + generated entries (settings file held as long as
    // the session's entry). Paths pass through `str::to_string` (identity) —
    // the launch argv is spawned directly as PID-1 of the PTY, so quoting is
    // the agent CLI's problem (argv is pre-tokenized by contract), not a
    // shell's. An `env_dir` scope's env rides the spawn's `environment_binding`.
    // SW-WA-F11: a scope-projection failure is a pre-bind abort — the result
    // flows through `fail_pre_bind!` so the telemetry record is written.
    let scope_result = {
        let scope_session = session_id.clone();
        let scope_cwd = cwd.to_string();
        let scope_binary = binary.to_path_buf();
        let scope_args = launch_args.to_vec();
        let scope_agent = agent.clone();
        let scope_version = resolved_binary.version.clone();
        let scope_app = app.clone();
        super::async_helpers::await_blocking("managed_launch.project_scope", move || {
            let trust = super::pty_backend::attribution_hook_trust_for_spawn(
                &scope_app,
                scope_agent.runtime,
                &scope_session,
            )?;
            managed_spawn::ProjectedManagedSpawn::project_managed_scope(
                &scope_agent,
                &scope_session,
                &scope_cwd,
                &super::mcp_scope::LaunchCli::new(scope_binary.as_path(), &scope_args)
                    .with_version(scope_version.as_deref())
                    .with_attribution_hook_trust(trust),
                &scope_args,
            )
        })
        .await
    };
    let mut projected = match scope_result {
        Ok(scope) => scope,
        Err(e) => fail_pre_bind!(telemetry, TelemetryOutcome::SpawnFailed, e),
    };
    if let Some(settings) = projected.take_settings() {
        state.hold_launch_settings(story_id, settings);
    }

    // SW-WA-F13: pre-trust the managed launch dir in the agent's folder-trust
    // state, so a headless launch into a brand-new worktree doesn't stall on a
    // `Do you trust this folder?` prompt nobody is watching. The writer refuses
    // any dir that doesn't pass `managed_launch_dir`, and a failure is
    // deliberately non-fatal — a foreground user can still answer the dialog,
    // and an unwritable `.claude.json` must never block the launch.
    // The adapter may return per-launch trust overrides for the managed paths.
    let trust_flags =
        crate::agents::workspace_trust::pretrust_flags(agent, Path::new(cwd), &session_id).await;

    // The CLI's own usage export, pointed at the local receiver. A launch with no bound API has
    // nowhere to send it, so it runs without the export.
    let mut launch_args = projected.take_arguments();
    crate::agents::workspace_trust::splice_trust_flags(&mut launch_args, trust_flags);
    let recorded_scope_env = projected.environment().to_vec();
    let telemetry_export = agent.descriptor().telemetry.clone();
    // The launch's own session id is its telemetry token, so the usage its exporter sends is
    // attributed to this launch.
    managed_usage_owner(&home.descriptor, &agent.launch.id, story_id, cwd)
        .prepare_export(
            crate::session_usage::store_path(),
            &session_id,
            telemetry_export.as_ref(),
            app.try_state::<crate::http::HttpApiPort>()
                .map(|port| port.0),
            projected.environment_mut(),
            &mut launch_args,
        )
        .await;

    let role_meta = state
        .snapshot()
        .into_iter()
        .find(|e| e.handle == story_id)
        .map(|e| e.meta);
    if let Some(team) = role_meta.as_ref().and_then(|m| m.team.as_ref()) {
        projected
            .environment_mut()
            .extend(super::role_startup::environment(
                team,
                role_meta.as_ref().and_then(|m| m.queue_role.as_deref()),
            ));
    }

    let bound_spawn = managed_spawn::ProjectedManagedSpawn::bind(projected, app, agent)?;

    // SW-WA-F10: compose the agent's argv up front and open the tab with
    // argv-direct spawn. The sidecar / in-process host runs the agent CLI
    // as PID-1 of the PTY — no login shell wrapper, no `.zshrc`/`.zprofile`,
    // no wait-for-prompt. SW-AN-45 env rides `environment_binding` and is
    // consumed into the child env at exec. The agent's native-launch
    // provider rides on `native_launch` so the host reserves an activity
    // invocation and binds SOCKET_ENV / TOKEN_ENV onto the child before
    // exec. Ctrl+C in the resulting tab routes to the agent in-process
    // (the agent cancels its current turn — standard REPL semantics); on
    // agent exit the tab goes to `exited` instead of dropping to zsh.
    //
    // The tags let a client that did not launch it tell what the session
    // is for. On spawn failure there is no PTY to reap; the caller's
    // `abort` frees the reservation.
    let workspace_ident = spawn_workspace_ident(story_id, &home);
    let open = agent_open_tab(story_id, &session_id, home, tab_name);
    if let Err(e) = product.validate() {
        fail_pre_bind!(telemetry, TelemetryOutcome::SpawnFailed, e);
    }
    // The tab opens inside the startup below; a drop from its open on kills it.
    let (opening, opened_session) = (&mut prebind, &session_id[..]);
    let startup = super::role_startup::start_argv(
        &super::agent_inbox::AppInboxHost { app: app.clone() },
        role_meta.as_ref().and_then(|m| m.team.as_ref()),
        role_meta.as_ref().and_then(|m| m.queue_role.as_deref()),
        &session_id,
        agent.runtime,
        launch_args,
        initial_prompt,
        |prompt_plan| async move {
            opening.opening_tab(opened_session);
            let spawn = TabSpawn::Cold(Box::new(bound_spawn.into_args(
                binary,
                cwd,
                &workspace_ident,
                &prompt_plan.launch_args,
            )));
            open_layout_tab(
                app.clone(),
                crate::commands::machines::LOCAL_MACHINE_ID.into(),
                open,
                spawn,
            )
            .await?;
            Ok(prompt_plan)
        },
    )
    .await;
    let prompt_plan = match startup {
        Ok(plan) => plan,
        Err(e) => fail_pre_bind!(telemetry, TelemetryOutcome::SpawnFailed, e),
    };

    // CONNECT: the PTY has the agent as PID-1. Commit the binding so the
    // session is panel-observable / killable. A failure here reaps the
    // raw PTY so a half-bound session is never left running — the
    // pre-commit rollback window.
    let connected: Result<(), String> = (|| {
        let claim = super::pty_backend::capture_local_effect_claim(app, &session_id)?;
        let accounts = app.try_state::<super::agent_accounts::AgentAccountRuntimeState>();
        super::pty_backend::commit_local_effect_claim(app, &claim, || {
            bind_managed_session(state, accounts.as_deref(), story_id, &session_id, &claim)
        })?;
        if let Some(accounts) = accounts {
            accounts.take_owned_provenance(&claim);
        }
        Ok(())
    })();
    if let Err(e) = connected {
        kill_session(app, &session_id);
        // SW-WA-F10 × F11: argv-direct spawn retires the shell-settle gate,
        // so a connect failure here can only be a bind-side rejection — no
        // `SettleTimeout` variant to classify. The record reads `SpawnFailed`.
        fail_pre_bind!(telemetry, TelemetryOutcome::SpawnFailed, e);
    }
    // Bound: the registry owns the session now.
    prebind.claim_committed();

    super::dashboard_launch::emit_session_joined_system_message(app, state, story_id, &session_id);

    // The durable record of what this session was launched as, written once it is bound.
    super::dashboard_launch::write_launch_record_for_app(
        app,
        state,
        &session_id,
        story_id,
        crate::session_usage::record::LaunchFacts::new(
            agent.runtime,
            resolved_binary.version.as_deref(),
            &prompt_plan.launch_args,
            agent.launch.mcp_allow.clone(),
            agent.launch.recorded_bridge_tools(),
            agent.revision_label(),
            agent.manifest_hash.clone(),
            cwd,
        )
        .with_launch_env(agent.runtime, &agent.launch.env, &recorded_scope_env)
        .with_provided_skills(agent.provided_skills())
        .with_task(crate::session_usage::task_capture::TaskInputs::from_launch(
            agent,
            initial_prompt,
        )),
    );

    // COMMIT: the SW-WA-F11 telemetry audit at the end of this function is the
    // ONE Spawn audit line this MCP launch writes (parity with the FE
    // `dashboard_launch_bind` path, which audits exactly once). Writing a plain
    // sibling `agent_audit::append(Spawn, ...)` here would double-count every
    // success-path launch for the F11 retrospect `jq` query, so the audit is
    // deferred to the single telemetry-bearing write below.
    //
    // The tab carries the launch, so an app restart that keeps the session server
    // restores it. Best-effort.
    super::dashboard_launch::tag_bound_launch(app, &session_id).await;

    // BEST-EFFORT (never reaps the bound session): give the agent time to come up
    // so the return is more likely to reflect a live agent, then seed the first
    // prompt. A slow/failed wait-live or seed leaves the session bound + visible;
    // the panel status net (SW-BA-1) surfaces a no-show rather than killing it.
    let wait_outcome = wait_for_live_agent(app, &session_id, binary, &mut telemetry).await;
    // SW-WA-F11: three-way → telemetry outcome. `Canceled` only when the PTY
    // was reaped mid-wait (user kill, sidecar teardown) — not a timeout.
    let outcome = match wait_outcome {
        WaitLiveOutcome::Live => TelemetryOutcome::Succeeded,
        WaitLiveOutcome::Elapsed => TelemetryOutcome::WaitLiveElapsed,
        WaitLiveOutcome::Canceled => TelemetryOutcome::Canceled,
    };
    let record = finalize_launch_telemetry(app, telemetry, outcome, None);
    spawn_telemetry_audit(
        AuditEvent::Spawn,
        story_id.to_string(),
        KIND_DASHBOARD_LAUNCHED,
        record,
    );
    let (seeded, warnings) = if prompt_plan.in_argv {
        (true, vec![])
    } else {
        match prompt_plan.pty_prompt {
            Some(prompt) => startup_submission(
                submit_pty_line(
                    app.clone(),
                    session_id.clone(),
                    prompt,
                    SUBMIT_QUIET_MS,
                    SUBMIT_CONFIRM_MS,
                    SUBMIT_TIMEOUT_MS,
                    SUBMIT_MAX_NUDGES,
                )
                .await,
            ),
            None => (false, vec![]),
        }
    };
    // An agent with no prompt to run sits at its prompt: it reads idle, not unknown. One
    // given a prompt runs a turn, and its hooks say what it is doing.
    if !seeded {
        super::agent_inbox::on_session_ready(app, story_id);
    }

    let mut warnings = warnings;
    warnings.extend(crate::agents::launch_check::root_document_warnings(
        agent.runtime,
        Path::new(cwd),
    ));
    Ok(warnings)
}

pub(crate) fn startup_submission(
    outcome: Result<SubmitOutcome, String>,
) -> (bool, Vec<LaunchWarning>) {
    if outcome.is_ok_and(|outcome| outcome.submitted) {
        (true, vec![])
    } else {
        (false, vec![LaunchWarning {
            code: LaunchWarningCode::StartupDeliveryUnconfirmed,
            message: "The session opened, but its initial task was not confirmed delivered. Check its terminal before sending the task again.".into(),
        }])
    }
}

/// How a managed launch delivers its starting prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InitialPromptPlan {
    /// The launch argv, carrying the prompt in its native argv form when `in_argv`.
    pub launch_args: Vec<String>,
    /// The prompt still to be typed into the agent's TUI once it is live: only for a
    /// launch whose argv could not carry it.
    pub pty_prompt: Option<String>,
    /// The prompt rides argv: the CLI submits it itself on startup.
    pub in_argv: bool,
}

/// `launch_args` as the CLI's adapter normalizes the entry of an interactive launch
/// (Hermes: `chat --tui`); a no-op for a CLI whose adapter asks nothing of it.
pub(crate) fn interactive_arguments(
    runtime: codesense_pty_core::agent_cli::AgentCli,
    launch_args: Vec<String>,
) -> Vec<String> {
    let mut native =
        codesense_pty_core::agent_cli::Prepare::new(launch_args, serde_json::json!({}), "");
    native.interactive = true;
    codesense_pty_core::agent_cli::AgentCliAdapter::prepare(
        codesense_pty_core::agent_cli::adapter(runtime),
        &mut native,
    )
    .expect("valid empty interactive preparation settings");
    native.arguments
}

/// Plan the starting prompt of a managed launch. The CLI descriptor chooses its native
/// argv form: Claude and Codex take a positional prompt after `--`; OpenCode takes
/// `--prompt <text>`. Each submits that prompt itself once its TUI is up, including slash
/// commands. Typing it into the PTY instead raced TUI startup: a prompt written before
/// the input was ready could be dropped or left unsubmitted. Only argv that already ends
/// its options (its own `--`) keeps the typed fallback.
///
/// SW-WA-F10: `launch_args` are argv entries (not shell-quoted words — the
/// managed launch spawns argv directly as PID-1 of the PTY). The prompt is
/// appended verbatim: argv isn't shell-parsed, so no quoting or escape is
/// needed. A NUL in the prompt still becomes a space (bash/zsh end a word
/// there — fallback-typing a NUL into a shell would cut the prompt short),
/// matching the TUI-fallback contract.
pub(crate) fn plan_initial_prompt(
    runtime: codesense_pty_core::agent_cli::AgentCli,
    mut launch_args: Vec<String>,
    prompt: Option<&str>,
) -> InitialPromptPlan {
    let descriptor = codesense_pty_core::agent_cli::descriptor(runtime);
    if let Some(flag) = descriptor.joined_prompt_flag() {
        let mut launch_args = interactive_arguments(runtime, launch_args);
        if let Some(prompt) = prompt
            .filter(|prompt| !std::primitive::str::is_empty(std::primitive::str::trim(prompt)))
        {
            launch_args.push(format!("{flag}{prompt}"));
        }
        return InitialPromptPlan {
            launch_args,
            pty_prompt: None,
            in_argv: true,
        };
    }
    // A NUL can't ride a shell word (bash and zsh end the word there, cutting the prompt
    // short while it reads as seeded) and can't be typed either: it becomes a space, so
    // the words it separated stay apart.
    let prompt = prompt.map(|p| p.replace('\0', " "));
    let Some(prompt) = prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) else {
        return InitialPromptPlan {
            launch_args,
            pty_prompt: None,
            in_argv: false,
        };
    };
    let descriptor = codesense_pty_core::agent_cli::descriptor(runtime);
    // An argv word past the per-argument cap could fail the exec (E2BIG); a
    // launch argv that already ends its options keeps the typed fallback.
    if prompt.len() > MAX_ARGV_PROMPT_BYTES || launch_args.iter().any(|arg| arg == "--") {
        return InitialPromptPlan {
            launch_args,
            pty_prompt: Some(prompt.to_string()),
            in_argv: false,
        };
    }
    if let Some(flag) = &descriptor.prompt_flag {
        launch_args.push(flag.clone());
        launch_args.push(prompt.to_string());
        return InitialPromptPlan {
            launch_args,
            pty_prompt: None,
            in_argv: true,
        };
    }
    if !descriptor.prompt_operand {
        return InitialPromptPlan {
            launch_args,
            pty_prompt: Some(prompt.to_string()),
            in_argv: false,
        };
    }
    launch_args.push("--".to_string());
    launch_args.push(prompt.to_string());
    InitialPromptPlan {
        launch_args,
        pty_prompt: None,
        in_argv: true,
    }
}

/// The longest starting prompt carried on argv; a longer one is typed instead. Well under
/// Linux's per-argument `MAX_ARG_STRLEN` (128 KiB), so a remote-class host never refuses it.
const MAX_ARGV_PROMPT_BYTES: usize = codesense_pty_core::agent_cli::MAX_INITIAL_PROMPT_BYTES;

/// The terminal tab a managed launch opens for its agent: in its workspace, named what the
/// agent was launched as (`name`; the host numbers an unnamed one), tagged with its handle.
fn agent_open_tab(
    handle: &str,
    session_id: &str,
    home: LaunchHome,
    name: Option<String>,
) -> OpenTab {
    let (placement, activate) = match home.view {
        SessionView::Background => (Placement::Background, false),
        SessionView::Tab { focus } => (Placement::Tab, focus),
    };
    OpenTab {
        viewer: app_viewer(),
        workspace: home.workspace,
        session: PtySessionId::new(session_id.to_string()),
        descriptor: Some(home.descriptor),
        cwd: home.tab_cwd,
        name,
        role: None,
        tags: Tags::from([
            ("launcher".to_string(), MCP_LAUNCHER.to_string()),
            ("handle".to_string(), handle.to_string()),
        ]),
        placement,
        index: None,
        activate,
    }
}

/// The story/workspace id a spawned PTY is tagged with: the story id of a session in a
/// story's workspace (bare, also for a named `<storyId>#<name>` handle), else the handle.
fn spawn_workspace_ident(handle: &str, home: &LaunchHome) -> String {
    home.descriptor
        .story_id
        .clone()
        .unwrap_or_else(|| handle.to_string())
}

/// SW-WA-F10: the argv a managed-launch spawns as PID-1 of the PTY: the
/// resolved agent binary followed by the pack-supplied launch args (`.args`
/// at `src-tauri/src/agents/model.rs`, pre-tokenized by construction — see
/// AC-6 for the shell-metacharacter audit). The sidecar / in-process host
/// runs this argv directly: no shell wrapper, no history-prefix, no quoting —
/// argv crosses the wire as a `Vec<String>`.
fn compose_agent_argv(binary: &Path, launch_args: &[String]) -> Vec<String> {
    let mut argv = Vec::with_capacity(launch_args.len() + 1);
    argv.push(binary.to_string_lossy().into_owned());
    argv.extend(launch_args.iter().cloned());
    argv
}

/// SW-WA-F11 — three-way outcome of [`wait_for_live_agent`]:
///  * `Live` → the agent was observed in the budget (`Succeeded`).
///  * `Elapsed` → the full poll budget ran out with no sighting
///    (`WaitLiveElapsed`; the session is still bound, so the panel's status
///    net picks it up).
///  * `Canceled` → the session's PTY was reaped mid-wait (user kill or a
///    sidecar teardown). The launch did not time out — it was explicitly
///    taken away — so the record reads `Canceled`, not `WaitLiveElapsed`.
enum WaitLiveOutcome {
    Live,
    Elapsed,
    Canceled,
}

/// BEST-EFFORT wait-live: poll for the `claude` child up to the budget. Returns
/// unconditionally — it NEVER reaps the (already-bound) session, so a slow-to-
/// launch agent is not killed as a false failure (FE parity). A poisoned lock or
/// a genuine no-show simply exhausts the budget; the panel status net covers it.
///
/// The caller maps the three-way return onto its telemetry record's
/// [`LaunchOutcome`] (Succeeded / WaitLiveElapsed / Canceled).
async fn wait_for_live_agent(
    app: &AppHandle,
    session_id: &str,
    claude: &Path,
    telemetry: &mut LaunchTelemetryBuilder,
) -> WaitLiveOutcome {
    let agent = agent_basename(claude);
    for _ in 0..WAIT_LIVE_ATTEMPTS {
        if let Ok(true) =
            session_has_live_agent(app.clone(), session_id.to_string(), agent.clone()).await
        {
            telemetry.observe_agent_live(std::time::Instant::now());
            return WaitLiveOutcome::Live;
        }
        // SW-WA-F11: a user-kill mid-wait reaps the PTY. Distinguish from the
        // "slow agent" case (budget exhausts) so the retrospect record reads
        // `Canceled` rather than `WaitLiveElapsed`.
        if super::pty_backend::alive_session_ids(app, &[session_id]).known_gone(session_id) {
            return WaitLiveOutcome::Canceled;
        }
        tokio::time::sleep(Duration::from_millis(WAIT_LIVE_INTERVAL_MS)).await;
    }
    WaitLiveOutcome::Elapsed
}

/// SW-WA-F11 — fold the output pipeline's first-byte observation into the
/// in-flight launch builder and complete the record. Non-blocking: the audit
/// write is `tokio::spawn`ed so launch latency sees nothing but a handful of
/// hashmap writes on the hot path (AC-5).
fn finalize_launch_telemetry(
    app: &AppHandle,
    mut telemetry: LaunchTelemetryBuilder,
    outcome: TelemetryOutcome,
    error_text: Option<String>,
) -> LaunchTelemetry {
    let session_id = telemetry.session_id().to_string();
    if let Some(tracker) = app.try_state::<LaunchTelemetryTracker>() {
        if let Some(at) = tracker.take_first_byte(&session_id) {
            telemetry.observe_first_byte(at);
        }
    }
    let record = telemetry.finish(outcome, error_text);
    if let Some(tracker) = app.try_state::<LaunchTelemetryTracker>() {
        tracker.complete(record.clone());
    }
    record
}

/// Append the SW-WA-F11 audit line off the launch's hot path. Spawned on the
/// Tokio runtime so the launch flow never waits on the JSONL write (AC-5).
fn spawn_telemetry_audit(
    event: AuditEvent,
    handle: String,
    kind: &'static str,
    record: LaunchTelemetry,
) {
    tokio::spawn(async move {
        let session_id = record.session_id.clone();
        agent_audit::append_with_telemetry(event, &handle, Some(&session_id), kind, &record);
    });
}

fn managed_usage_owner(
    descriptor: &WorkspaceDescriptor,
    agent: &str,
    handle: &str,
    cwd: &str,
) -> crate::session_usage::LaunchOwner {
    crate::session_usage::LaunchOwner::new(
        descriptor.org.clone(),
        descriptor.team.clone(),
        agent.to_string(),
        handle.to_string(),
        Some(cwd.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::git_fixture::{committed_repo, fn_source, porcelain};

    /// A story open passes the configured start point through and otherwise leaves the
    /// base to the repo's default branch, resolved only when the branch is new.
    #[test]
    fn story_open_never_assumes_a_main_branch() {
        let source = include_str!("mcp_workspace.rs");
        let start = source.find("async fn ensure_story_worktree(").unwrap();
        let end = start + source[start..].find("\n}\n").unwrap();
        let body = &source[start..end];
        assert!(
            !body.contains("\"main\""),
            "the story open assumes a `main` branch"
        );
        assert!(body.contains("config.default_start_point.clone(),"));
    }

    /// A seat cleanup looks at the story's seat worktrees only (the named seat only, when
    /// one is given) and never at a seat whose launch is under way: a sweep racing a
    /// launch of the same seat leaves the new seat alone, and finds it once the launch
    /// is done.
    #[test]
    fn a_seat_cleanup_skips_the_base_worktree_and_a_seat_being_launched() {
        use crate::commands::worktree::seat::SeatWorktreeParam;
        use crate::install::worktree_index::SeatKind;
        let story = "SEAT-REAP-1";
        let record = |path: &str, story_id: &str, seat: Option<&str>| {
            let mut record = WorktreeStoryRecord::new(
                path,
                "acme",
                SourceRepoSlug::new("acme", "app").unwrap(),
                story_id,
                "/ctx/team/content/stories/story.md",
            );
            record.seat = seat.map(|name| SeatRecord {
                name: name.into(),
                kind: SeatKind::Branch,
                pinned_commit: None,
                kept: None,
            });
            record
        };
        let records = || {
            vec![
                record("/wt/app", story, None),
                record("/wt/app-seat-dev", story, Some("dev")),
                record("/wt/app-seat-qa", story, Some("qa")),
                record("/wt/other-seat-dev", "SEAT-REAP-2", Some("dev")),
            ]
        };
        let reaped = |only: Option<&str>| -> Vec<PathBuf> {
            seats_to_reap(records(), story, only, |name| {
                seat_launch_in_flight(story, name)
            })
            .into_iter()
            .map(|record| record.code_repo_path)
            .collect()
        };
        let (dev, qa) = (
            PathBuf::from("/wt/app-seat-dev"),
            PathBuf::from("/wt/app-seat-qa"),
        );
        assert_eq!(reaped(None), [dev.clone(), qa.clone()]);
        assert_eq!(reaped(Some("qa")), [qa.clone()]);
        let seat = SeatLaunch {
            name: "dev".into(),
            worktree: SeatWorktreeParam::Branch,
        };
        let launch = SeatLaunchClaim::new(story, Some(&seat));
        let again = SeatLaunchClaim::new(story, Some(&seat));
        assert_eq!(reaped(None), [qa.clone()]);
        assert!(reaped(Some("dev")).is_empty());
        assert!(!seat_launch_in_flight("SEAT-REAP-2", "dev"));
        drop(launch);
        assert!(
            seat_launch_in_flight(story, "dev"),
            "the second launch still runs"
        );
        drop(again);
        assert_eq!(reaped(None), [dev, qa]);
        // A launch without a seat counts nothing.
        let _shared = SeatLaunchClaim::new(story, None);
        assert!(!seat_launch_in_flight(story, ""));
    }

    /// A close of a tab with no seat worktree never waits for the story's prepare lock
    /// (a launch can hold it through a long setup); a real seat waits for it only so
    /// long, then is left to the next sweep; with the lock free, the seat is cleaned up.
    #[tokio::test]
    async fn a_seat_cleanup_waits_for_the_prepare_lock_only_for_a_seat_and_only_so_long() {
        use crate::commands::worktree::fake_probe::FakeProbe;
        use crate::install::worktree_index::SeatKind;
        let home = tempfile::tempdir().unwrap();
        let principal = Principal::from(42);
        let story = "SEAT-LOCK-1";
        let path = home.path().join("app-seat-dev");
        let mut record = WorktreeStoryRecord::new(
            &path,
            "acme",
            SourceRepoSlug::new("acme", "app").unwrap(),
            story,
            home.path().join("team/content/stories/story.md"),
        );
        record.seat = Some(SeatRecord {
            name: "dev".into(),
            kind: SeatKind::Branch,
            pinned_commit: None,
            kept: None,
        });
        write_record(home.path(), &principal, &record).unwrap();
        let waits = |lock: Option<Duration>| SeatWaits {
            exit: Duration::ZERO,
            lock,
        };
        let launch = story_prepare_claim(story).await;
        // No seat by that name: back at once, though the lock is held and never given up.
        let probe = FakeProbe::passing();
        let shared = tokio::time::timeout(
            Duration::from_secs(5),
            reap_seats_of(
                &probe,
                home.path(),
                &principal,
                story,
                Some("reviewer"),
                waits(None),
            ),
        )
        .await
        .expect("a close of a tab without a seat worktree never waits for the lock");
        assert!(shared.is_empty());
        // The seat: its lock isn't free in time, so it's left alone.
        let later = reap_seats_of(
            &probe,
            home.path(),
            &principal,
            story,
            Some("dev"),
            waits(Some(Duration::from_millis(50))),
        )
        .await;
        assert!(later.is_empty());
        assert!(probe.asked().is_empty(), "{:?}", probe.asked());
        // Once the launch is done, it is cleaned up.
        drop(launch);
        let removed = reap_seats_of(
            &probe,
            home.path(),
            &principal,
            story,
            Some("dev"),
            waits(Some(Duration::from_millis(50))),
        )
        .await;
        assert_eq!(removed, [path]);
    }

    /// A seat launch is counted before it waits for the story's prepare lock, which a
    /// cleanup holds while it looks at the story's seats, and stays counted until the
    /// spawn returns.
    #[test]
    fn a_seat_launch_is_counted_before_it_waits_for_the_prepare_lock() {
        let source = include_str!("mcp_workspace.rs");
        let start = source
            .find("pub(crate) async fn launch_story_session_typed(")
            .unwrap();
        let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
        let claim = body
            .find("let _seat_launch = SeatLaunchClaim::new(")
            .unwrap();
        assert!(claim < body.find("with_story_prepare_lock(").unwrap());
        assert!(claim < body.find("launch_managed_dir_session_typed(").unwrap());
    }

    #[test]
    fn a_seat_record_never_takes_over_another_worktree() {
        let home = tempfile::tempdir().unwrap();
        let ctx = ActiveContext::for_team(home.path().into(), 42, "acme".into(), "team".into());
        let root = home.path().join("seat-worktree");
        std::fs::create_dir_all(&root).unwrap();
        let slug = SourceRepoSlug::new("acme", "code").unwrap();
        let story_path = home.path().join("team/content/X-1.md");
        let seat = |pinned: &str| SeatRecord {
            name: "review".into(),
            kind: crate::install::worktree_index::SeatKind::Commit,
            pinned_commit: Some(pinned.into()),
            kept: None,
        };
        let read = || read_record(home.path(), &ctx.principal(), &root).unwrap();

        // A new seat is registered complete (a commit seat runs no setup).
        register_seat_record(
            &ctx,
            &root,
            None,
            seat("a1"),
            slug.clone(),
            "X-1",
            story_path.clone(),
            true,
        )
        .unwrap();
        let first = read().unwrap();
        assert_eq!(first.seat, Some(seat("a1")));
        assert!(first.setup_complete);
        // A relaunch of the same seat updates it in place.
        register_seat_record(
            &ctx,
            &root,
            Some(first),
            seat("b2"),
            slug.clone(),
            "X-1",
            story_path.clone(),
            true,
        )
        .unwrap();
        assert_eq!(read().unwrap().seat, Some(seat("b2")));

        // A relaunch of the same seat fits; another story's record, or a base worktree, at
        // that folder doesn't (checked before git creates anything there).
        let seat_rec = read().unwrap();
        assert!(seat_record_fits(&ctx, "X-1", &root, Some(&seat_rec)).is_ok());
        assert!(seat_record_fits(&ctx, "X-1", &root, None).is_ok());
        let other = WorktreeStoryRecord::new(&root, "acme", slug.clone(), "X-2", &story_path);
        let base = WorktreeStoryRecord::new(&root, "acme", slug.clone(), "X-1", &story_path);
        let mut elsewhere = seat_rec.clone();
        elsewhere.org_slug = "other".into();
        for existing in [other, base, elsewhere] {
            assert!(seat_record_fits(&ctx, "X-1", &root, Some(&existing)).is_err());
        }
    }

    #[test]
    fn a_seat_session_runs_in_its_folder_inside_the_story_workspace() {
        let (base, seat) = (PathBuf::from("/wt/app"), PathBuf::from("/wt/app-seat-dev"));
        let view = SessionView::Tab { focus: false };
        let (shared, shared_cwd) =
            story_launch_home("acme", Some("team"), "X-1", &base, None, view);
        let (seated, seated_cwd) =
            story_launch_home("acme", Some("team"), "X-1", &base, Some(seat.clone()), view);
        // One workspace, its descriptor on the base worktree, for both sessions.
        assert_eq!(seated.workspace, shared.workspace);
        assert_eq!(seated.descriptor, shared.descriptor);
        assert_eq!(
            seated.descriptor.worktree_path.as_deref(),
            Some(base.as_path())
        );
        // Only the seat tab carries its own folder, and spawns there.
        assert_eq!((shared.tab_cwd.as_ref(), shared_cwd), (None, base.clone()));
        assert_eq!(
            (seated.tab_cwd.as_ref(), seated_cwd.clone()),
            (Some(&seat), seat.clone())
        );
        let tab = agent_open_tab("X-1#dev", "sess-1", seated, None);
        assert_eq!(tab.cwd, Some(seat));
        assert_eq!(
            tab.descriptor.and_then(|d| d.worktree_path),
            Some(base.clone())
        );
        assert_eq!(agent_open_tab("X-1", "sess-2", shared, None).cwd, None);
    }

    #[test]
    fn reopen_preserves_unsupported_worktree_record() {
        let home = tempfile::tempdir().unwrap();
        let ctx = ActiveContext::for_team(home.path().into(), 42, "acme".into(), "team".into());
        let root = home.path().join("story-worktree");
        std::fs::create_dir_all(&root).unwrap();
        let slug = SourceRepoSlug::new("acme", "code").unwrap();
        let story_path = home.path().join("team/content/X-1.md");
        let mut record = WorktreeStoryRecord::new(&root, "acme", slug.clone(), "X-1", &story_path);
        record.status = crate::install::worktree_index::SyncStatus::Synced;
        record.lazy = true;
        record
            .hydrated_epics
            .push(home.path().join("team/content/epic"));
        write_record(home.path(), &ctx.principal(), &record).unwrap();
        let path = home.path().join("users/42/worktrees").join(format!(
            "{}.json",
            crate::content_engine::lockfile::code_repo_path_hash(&root).unwrap()
        ));
        let mut newer = serde_json::to_value(&record).unwrap();
        newer["schema_version"] = serde_json::json!(2);
        newer["newer_metadata"] = serde_json::json!({"keep": true});
        let bytes = serde_json::to_vec_pretty(&newer).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let result = mark_story_setup_pending(&ctx, &root, slug, "X-1", story_path);
        assert!(
            result.is_err(),
            "reopen must refuse an unreadable existing record"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[tokio::test]
    async fn a_managed_launch_without_an_org_attributes_its_export() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.sqlite");
        let token = "managed-session";
        let descriptor = WorkspaceDescriptor::default();
        let cli = codesense_pty_core::agent_cli::AgentCli::Claude;
        let mut env = Vec::new();
        let mut args = Vec::new();
        managed_usage_owner(&descriptor, "personal/worker", "routine:daily@run", "/work")
            .prepare_export(
                Ok(path.clone()),
                token,
                codesense_pty_core::agent_cli::descriptor(cli)
                    .telemetry
                    .as_ref(),
                Some(4567),
                &mut env,
                &mut args,
            )
            .await;
        assert!(env.iter().any(|(_, value)| value.contains(token)));
        crate::session_usage::tests::assert_launch_attribution(
            &path,
            token,
            cli,
            "personal/worker",
            "routine:daily@run",
            "",
            None,
        );
    }

    /// SW-WA-F10 (AC-3): `compose_agent_argv` produces an argv-shaped
    /// launch — the resolved agent binary at argv[0], the pack-supplied
    /// `.args` after it, verbatim and in order. No shell wrapping, no
    /// quoting, no leading-space history-hide prefix: the argv crosses
    /// the wire as `Vec<String>` and the sidecar / in-process host runs
    /// argv[0] as PID-1 of the PTY.
    #[test]
    fn compose_agent_argv_lays_binary_then_agent_args_in_order() {
        let bin = std::path::Path::new("/opt/homebrew/bin/claude");
        let args: Vec<String> = [
            "--add-dir",
            "/a",
            "--session-id",
            "s1",
            "--mcp-config",
            "/m.json",
            "--strict-mcp-config",
            "--settings",
            "/s.json",
            "--dangerously-skip-permissions",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let argv = compose_agent_argv(bin, &args);
        assert_eq!(argv[0], "/opt/homebrew/bin/claude");
        assert_eq!(&argv[1..], args.as_slice());
        // No pre-tokenization quirks: argv is unquoted (contrast with the
        // pre-A1 shell line path that passed through `shell_quote`).
        assert!(!argv.iter().any(|a| a.starts_with('\'')));
        assert!(!argv.iter().any(|a| a.contains('`')));
    }

    /// SW-WA-F10 (AC-3): an empty pack `.args` leaves the agent binary
    /// alone as the sole argv entry — no stray tokens, no padding.
    #[test]
    fn compose_agent_argv_with_no_agent_args_is_just_the_binary() {
        let bin = std::path::Path::new("/opt/homebrew/bin/claude");
        assert_eq!(
            compose_agent_argv(bin, &[]),
            vec!["/opt/homebrew/bin/claude".to_string()]
        );
    }

    #[derive(Default)]
    struct Recording(std::sync::Mutex<Vec<(String, serde_json::Value)>>);
    impl crate::commands::worktree::EventSink for Recording {
        fn emit(&self, channel: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((channel.into(), payload));
        }
    }

    /// SW-XS-9: local `worktree.yaml` setup reports `RunningSetup{command}` per
    /// command, and its failure as a failure event, instead of dropping both.
    #[test]
    fn xs9_local_setup_reports_running_setup_and_its_failure() {
        let out = Recording::default();
        let worktree = std::path::Path::new("/tmp/wt/SW-1");
        let sink = SetupProgressSink {
            out: &out,
            story_id: "SW-1",
            worktree,
        };
        use crate::commands::worktree::EventSink;
        sink.emit(
            "worktree-run-x",
            serde_json::json!({"event":"step-started","phase":"setup","step_index":0,"command":"pnpm install","ts_ms":1}),
        );
        sink.emit(
            "worktree-run-x",
            serde_json::json!({"stream":"stdout","line":"done","phase":"setup","step_index":0,"ts_ms":2}),
        );
        sink.failed("setup exited with code 1");
        sink.needs_approval("approve it once in CodeSense");
        sink.done();
        let events = out.0.lock().unwrap().clone();
        assert_eq!(
            events,
            vec![
                (
                    WORKSPACE_SETUP_PROGRESS_EVENT.to_string(),
                    serde_json::json!({"phase":"runningSetup","command":"pnpm install","storyId":"SW-1","worktreePath":"/tmp/wt/SW-1"})
                ),
                (
                    WORKSPACE_SETUP_PROGRESS_EVENT.to_string(),
                    serde_json::json!({"phase":"failed","failedPhase":"runningSetup","message":"setup exited with code 1","storyId":"SW-1","worktreePath":"/tmp/wt/SW-1"})
                ),
                (
                    WORKSPACE_SETUP_PROGRESS_EVENT.to_string(),
                    serde_json::json!({"phase":"needsApproval","message":"approve it once in CodeSense","storyId":"SW-1","worktreePath":"/tmp/wt/SW-1"})
                ),
                (
                    WORKSPACE_SETUP_PROGRESS_EVENT.to_string(),
                    serde_json::json!({"phase":"done","storyId":"SW-1","worktreePath":"/tmp/wt/SW-1"})
                ),
            ]
        );
        // The managed story setup reports through it, never the null sink.
        let source = include_str!("mcp_workspace.rs");
        let setup = source
            .split("async fn run_managed_story_setup(")
            .nth(1)
            .unwrap()
            .split("/// SW-XS-9: a local story worktree")
            .next()
            .unwrap();
        assert!(setup.contains("&sink,"));
        assert!(setup.contains("sink.failed(&e)"));
        assert!(setup.contains("sink.needs_approval(&message)"));
        assert!(setup.contains("sink.done()"));
        assert!(!setup.contains(&["Null", "EventSink"].concat()));
    }

    fn binary_at(version: Option<&str>) -> ResolvedAgentBinary {
        ResolvedAgentBinary {
            path: PathBuf::from("/bin/opencode"),
            version: version.map(str::to_owned),
        }
    }

    #[test]
    fn a_launch_outcome_adds_the_unqualified_cli_warning_after_the_spawn_warnings() {
        let unconfirmed = startup_submission(Err("no".into())).1;

        let warned = launch_warnings(
            unconfirmed.clone(),
            AgentCli::OpenCode,
            &binary_at(Some("2.0.1")),
        );
        let codes: Vec<_> = warned.iter().map(|w| w.code).collect();
        assert_eq!(
            codes,
            [
                LaunchWarningCode::StartupDeliveryUnconfirmed,
                LaunchWarningCode::CliVersionUnqualified
            ]
        );
        assert!(warned[1].message.contains("2.0.1"), "{}", warned[1].message);

        // In range, or a version nobody read: the spawn's warnings are all there is.
        for version in [Some("2.1.4"), None] {
            assert_eq!(
                launch_warnings(unconfirmed.clone(), AgentCli::OpenCode, &binary_at(version)),
                unconfirmed
            );
        }
    }

    #[test]
    fn the_interactive_and_headless_launches_call_the_same_version_note() {
        // Neither can run without a window and a CLI, so this only keeps their call sites
        // from being deleted; the behaviour is `AgentLaunch::note_cli_version`'s own test.
        // The needle is spelled so this file does not contain it.
        let needle = [".note_cli_", "version("].concat();
        for (path, source) in [
            ("agents_launch", include_str!("agents_launch.rs")),
            ("dashboard_launch", include_str!("dashboard_launch.rs")),
        ] {
            assert!(
                source.contains(&needle),
                "{path} must note the CLI version it spawns"
            );
        }
    }

    #[test]
    fn agent_launch_uses_argv_direct_spawn_and_initial_prompt_keeps_tui_submit() {
        // SW-WA-F10 wiring guard: the managed launch spawns the agent CLI as
        // PID-1 of the PTY via argv-direct (no shell wrapper, no settle gate,
        // no `submit_shell_pty_line`). The one TUI submit left is the fallback
        // prompt that cannot ride argv (the TUI-only path).
        let source = include_str!("mcp_workspace.rs");
        let spawn = source
            .split("async fn spawn_and_bind(")
            .nth(1)
            .unwrap()
            .split("fn plan_initial_prompt(")
            .next()
            .unwrap();
        // Launch argv is composed and spawned directly; no shell dispatch.
        assert!(spawn.contains("bound_spawn.into_args("));
        let boundary = include_str!("mcp_workspace/managed_spawn.rs");
        assert!(boundary.contains("command_argv: Some(super::compose_agent_argv("));
        assert!(boundary.contains("native_launch: Some(self.native_launch)"));
        assert!(boundary.contains("NativeLaunch::Cli(agent.runtime)"));
        assert!(
            !spawn.contains("submit_shell_pty_line("),
            "argv-direct spawn: no shell-settle submit"
        );
        assert!(!spawn.contains("start_agent("), "start_agent is retired");
        // One TUI submit remains: the fallback prompt the plan could not
        // carry on argv. No inbox line, no nudges, no send_message.
        assert_eq!(spawn.matches("submit_pty_line(").count(), 1);
        assert!(spawn.contains("Some(prompt) => startup_submission("));
        assert!(!spawn.contains("nudge"));
        assert!(!spawn.contains("send_message"));
        // With no prompt to run, the session is recorded at idle, not unknown.
        assert!(spawn.contains(
            "if !seeded {\n        super::agent_inbox::on_session_ready(app, story_id);"
        ));
        assert!(spawn.contains("agent_open_tab(story_id, &session_id, home, tab_name)"));
        // The name it was launched as names its tab.
        let managed = source
            .split("pub(crate) async fn launch_managed_dir_session_typed(")
            .nth(1)
            .unwrap()
            .split("fn stamp_raw_capture_for_fresh_launch(")
            .next()
            .unwrap();
        assert!(managed.contains("let tab_name = record.meta.display_name.clone();"));
    }

    fn claude_launch_args() -> Vec<String> {
        // SW-WA-F10: argv-shape, unquoted. The managed launch spawns argv
        // directly as PID-1 of the PTY — the agent CLI reads each argv[i] as
        // one argument, no shell interpretation.
        [
            "--add-dir",
            "/a",
            "--session-id",
            "s1",
            "--mcp-config",
            "/m.json",
            "--strict-mcp-config",
            "--settings",
            "/s.json",
        ]
        .map(String::from)
        .to_vec()
    }

    /// SW-WA-F10: a NUL byte in an argv word would terminate the C-string
    /// the agent CLI reads for that argument — the parser would see only the
    /// bytes up to the NUL, cutting the prompt. The caller normalizes NUL to
    /// a space before planning so the prompt stays whole on argv.
    #[test]
    fn a_nul_in_the_prompt_becomes_a_space_not_an_escape() {
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            claude_launch_args(),
            Some("first\0second\nthird"),
        );
        assert!(plan.in_argv);
        let word = plan.launch_args.last().unwrap();
        // Argv is unquoted: the prompt lands as its own argv entry verbatim,
        // with NUL replaced by a space so no C-string truncation occurs.
        assert_eq!(word, "first second\nthird");
        assert!(!word.contains('\0'));
    }

    /// A Claude launch's starting prompt rides its argv as the positional prompt after
    /// `--` (so no variadic `--add-dir`/`--mcp-config` can swallow it), and nothing is
    /// typed into its TUI: Claude submits an argv prompt itself once it is up.
    /// SW-WA-F10: the prompt is a plain argv entry — no shell quoting.
    #[test]
    fn a_claude_launch_carries_its_initial_prompt_in_argv_and_types_nothing() {
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            claude_launch_args(),
            Some("Review the inbox and report back"),
        );
        let mut expected = claude_launch_args();
        expected.extend(["--".into(), "Review the inbox and report back".into()]);
        assert_eq!(plan.launch_args, expected);
        assert_eq!(plan.pty_prompt, None);
        assert!(plan.in_argv);
    }

    /// A slash command is a valid argv prompt for Claude: it runs on startup.
    #[test]
    fn a_slash_command_prompt_rides_claude_argv() {
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            claude_launch_args(),
            Some("/bmad-help"),
        );
        assert_eq!(
            plan.launch_args[plan.launch_args.len() - 2..],
            ["--", "/bmad-help"]
        );
        assert_eq!(plan.pty_prompt, None);
    }

    /// Codex takes the same positional prompt (`codex [OPTIONS] -- <PROMPT>`).
    /// SW-WA-F10: argv-shape, the apostrophe rides argv verbatim with no
    /// shell quoting (no `'it'\''s go time'` dance).
    #[test]
    fn a_codex_launch_carries_its_initial_prompt_in_argv_and_types_nothing() {
        let args = vec!["-c".to_string(), "a=1".to_string()];
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Codex,
            args,
            Some("it's go time"),
        );
        assert_eq!(plan.launch_args, ["-c", "a=1", "--", "it's go time"]);
        assert_eq!(plan.pty_prompt, None);
        assert!(plan.in_argv);
    }

    #[test]
    fn an_opencode_launch_carries_its_initial_prompt_with_the_native_flag() {
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::OpenCode,
            vec!["--port".into(), "0".into()],
            Some("handle the queued role work"),
        );
        assert_eq!(
            plan.launch_args,
            ["--port", "0", "--prompt", "handle the queued role work"]
        );
        assert!(plan.in_argv);
        assert_eq!(plan.pty_prompt, None);
    }

    /// No prompt: argv is untouched and nothing is typed.
    #[test]
    fn no_initial_prompt_leaves_argv_alone() {
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            claude_launch_args(),
            None,
        );
        assert_eq!(plan.launch_args, claude_launch_args());
        assert_eq!(plan.pty_prompt, None);
        assert!(!plan.in_argv);
    }

    /// Argv that already ends its options (an agent's own `--`) cannot take another
    /// positional safely: the prompt falls back to being typed once the agent is live.
    #[test]
    fn argv_with_its_own_separator_falls_back_to_the_pty_prompt() {
        let args = vec!["--".to_string(), "own prompt".to_string()];
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            args.clone(),
            Some("hello"),
        );
        assert_eq!(plan.launch_args, args);
        assert_eq!(plan.pty_prompt.as_deref(), Some("hello"));
        assert!(!plan.in_argv);
    }

    /// SW-WA-F10: a multi-line prompt rides argv as a single argument —
    /// argv has no notion of a "line", so newlines are just bytes in the
    /// argv word. The agent CLI reads the whole word regardless of
    /// embedded controls.
    #[test]
    fn a_multi_line_prompt_rides_argv_verbatim() {
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            Vec::new(),
            Some("line one\nit's \\two\tx"),
        );
        let word = plan.launch_args.last().unwrap();
        assert_eq!(word, "line one\nit's \\two\tx");
    }

    /// A prompt past the argv cap is typed rather than risking E2BIG at exec.
    #[test]
    fn an_oversized_prompt_falls_back_to_typing() {
        let big = "x".repeat(MAX_ARGV_PROMPT_BYTES + 1);
        let plan = plan_initial_prompt(
            codesense_pty_core::agent_cli::AgentCli::Claude,
            Vec::new(),
            Some(&big),
        );
        assert!(plan.launch_args.is_empty());
        assert_eq!(plan.pty_prompt.as_deref(), Some(big.as_str()));
    }

    /// The managed spawn plans its prompt AFTER every other argv addition
    /// (scope flags, `--settings`), composes the final argv for the
    /// SW-WA-F10 argv-direct spawn from those launch args, and only types a
    /// prompt the plan left for the PTY (the TUI-fallback path).
    #[test]
    fn spawn_and_bind_plans_the_prompt_last_and_types_only_the_fallback() {
        let source = include_str!("mcp_workspace.rs");
        let spawn = source
            .split("async fn spawn_and_bind(")
            .nth(1)
            .unwrap()
            .split("fn plan_initial_prompt(")
            .next()
            .unwrap();
        // The scope step lives in `project_managed_scope`: the launch calls it before the
        // prompt is planned, and it drops the agent's own settings flag before the launch's
        // settings file is appended.
        let scope = source
            .split("fn project_managed_scope(")
            .nth(1)
            .unwrap()
            .split("pub(crate) async fn launch_managed_dir_session_typed")
            .next()
            .unwrap();
        let drop_at = scope
            .find("applied.drop_agent_settings(&mut args)")
            .unwrap();
        let settings_at = scope.find("args.extend(applied.argv(").unwrap();
        assert!(drop_at < settings_at);
        let scope_at = spawn.find("project_managed_scope(").unwrap();
        let plan_at = spawn.find("role_startup::start_argv(").unwrap();
        let argv_at = spawn.find("bound_spawn.into_args(").unwrap();
        assert!(scope_at < plan_at && plan_at < argv_at);
        assert!(spawn.contains("let (seeded, warnings) = if prompt_plan.in_argv"));
        assert!(spawn.contains("match prompt_plan.pty_prompt"));
    }

    /// A fresh launch holds its pre-bind guard from the reservation until the commit: armed
    /// right after `begin_with_provenance`, marked opened before the tab opens, and let go
    /// only once the claim is committed.
    #[test]
    fn the_pre_bind_guard_spans_reservation_to_commit() {
        let source = include_str!("mcp_workspace.rs");
        let managed = source
            .split("pub(crate) async fn launch_managed_dir_session_typed(")
            .nth(1)
            .unwrap()
            .split("fn launch_warnings(")
            .next()
            .unwrap();
        let reserve_at = managed.find("state.begin_with_provenance(").unwrap();
        let arm_at = managed
            .find("PreBindReservation::new(AppPreBindPort(app.clone()), handle, fresh)")
            .unwrap();
        let first_await_at = managed[reserve_at..].find(".await").unwrap() + reserve_at;
        assert!(reserve_at < arm_at && arm_at < first_await_at);
        assert!(managed.contains("        prebind,\n    )\n    .await;"));
        let spawn = source
            .split("async fn spawn_and_bind(")
            .nth(1)
            .unwrap()
            .split("pub(crate) struct InitialPromptPlan")
            .next()
            .unwrap();
        let opened_at = spawn.find("opening.opening_tab(opened_session);").unwrap();
        let open_at = spawn.find("open_layout_tab(").unwrap();
        let claim_at = spawn.find("commit_local_effect_claim(").unwrap();
        let commit_at = spawn.find("prebind.claim_committed();").unwrap();
        assert!(opened_at < open_at && open_at < claim_at && claim_at < commit_at);
        assert_eq!(spawn.matches("prebind.claim_committed()").count(), 1);
    }

    /// SW-WA-F11 — the launch telemetry pipeline is actually wired through
    /// `spawn_and_bind` and in the correct order. R1 reviewer caught that the
    /// earlier `agent_start_uses_shell_submit…` guard only asserted the
    /// shell-submit shape and would still pass if every F11 line were deleted.
    /// This guard anchors on the F11 symbols by name and their ordering so
    /// dropping any one of them fails this test.
    #[test]
    fn f11_builder_register_and_telemetry_audit_are_wired_through_spawn_and_bind() {
        let source = include_str!("mcp_workspace.rs");
        // SW-WA-F10 retired `start_agent`; bound `spawn_and_bind` on the next
        // item declared after it (`InitialPromptPlan`) instead.
        let spawn = source
            .split("async fn spawn_and_bind(")
            .nth(1)
            .unwrap()
            .split("pub(crate) struct InitialPromptPlan")
            .next()
            .unwrap();

        // Builder is created with the Drop-safe cleanup variant so panic / `?`
        // early-return never leaks a tracker row.
        let builder_at = spawn
            .find("LaunchTelemetryBuilder::start_with_cleanup(")
            .expect("F11 builder must be created via start_with_cleanup");
        // Register runs before anything else that could emit output.
        let register_at = spawn
            .find("tracker.register_in_flight(")
            .expect("F11 must register_in_flight so the first-byte hook can stamp");
        // mint_session_id runs before the builder is constructed so the
        // builder can key on the real PTY session id.
        let mint_at = spawn
            .find("mint_session_id()")
            .expect("session id minted first");
        assert!(mint_at < builder_at && builder_at < register_at);
        // The record names the agent CLI binary the launch resolved, set on the
        // builder once it exists.
        let set_binary_at = spawn
            .find("telemetry.set_binary(")
            .expect("the launch must record its binary on the telemetry builder");
        assert!(builder_at < set_binary_at);

        // Both the pre-bind failure path (Abort) and the committed-launch
        // path (Spawn) finalize + audit via the F11 helpers. Dropping either
        // path's finalize fails the retrospect `jq` query.
        assert!(
            spawn.contains("finalize_launch_telemetry("),
            "F11 must finalize telemetry on exit edges"
        );
        let normalized: String = spawn.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.contains("spawn_telemetry_audit( AuditEvent::Abort,"),
            "F11 must emit Abort audit on pre-bind failures"
        );
        assert!(
            normalized.contains("spawn_telemetry_audit( AuditEvent::Spawn,"),
            "F11 must emit single Spawn audit on committed launch"
        );
        // The duplicate plain-append must NEVER come back — R1 blocker fix.
        assert!(
            !normalized.contains("agent_audit::append( AuditEvent::Spawn,"),
            "SW-WA-F11 R1 blocker: no plain Spawn audit next to the telemetry audit (double-count)"
        );

        // Canceled outcome is emitted when the PTY was reaped mid-wait.
        assert!(
            spawn.contains("WaitLiveOutcome::Canceled => TelemetryOutcome::Canceled"),
            "F11 must map a mid-wait kill to Canceled, not WaitLiveElapsed"
        );
    }

    /// SW-WA-F11 — AC-5's non-blocking contract. The audit append must be
    /// `tokio::spawn`'d so the launch flow's return is not gated on JSONL I/O.
    /// A refactor that inlines the audit re-blocks every launch and this
    /// guard catches it.
    #[test]
    fn f11_telemetry_audit_is_wrapped_in_tokio_spawn() {
        let source = include_str!("mcp_workspace.rs");
        // The helper that writes the audit — its body must contain
        // `tokio::spawn` so the hot path never waits on the file write.
        let helper = source
            .split("fn spawn_telemetry_audit(")
            .nth(1)
            .expect("spawn_telemetry_audit must exist")
            .split("\nfn ")
            .next()
            .unwrap();
        assert!(
            helper.contains("tokio::spawn("),
            "AC-5: audit must be tokio::spawn'd, not inlined"
        );
        assert!(
            helper.contains("agent_audit::append_with_telemetry"),
            "AC-5 helper must call the telemetry-bearing append"
        );
    }

    fn runtime_claim(session: &str, epoch: &str) -> super::super::pty_host::LocalEffectClaim {
        use crate::commands::machines::{
            RuntimeCounter, RuntimeMemberAddress, RuntimeMemberSlot, RuntimeMemberTarget,
            RuntimeNamespace,
        };
        super::super::pty_host::LocalEffectOwners::default()
            .reserve(
                RuntimeMemberTarget {
                    member: RuntimeMemberAddress::local(RuntimeMemberSlot::InProcess),
                    admission_revision: RuntimeCounter::new(1),
                    namespace: RuntimeNamespace {
                        server_id: session.into(),
                        epoch: epoch.into(),
                        generation: RuntimeCounter::new(1),
                    },
                },
                session,
            )
            .unwrap()
    }

    /// A managed launch (an `open_workspace` or trigger launch) records the account its spawn
    /// staged for this runtime claim, so the session reports the account and runtime it ran
    /// as; one staged for another claim is never taken.
    #[test]
    fn a_managed_launch_records_the_account_its_spawn_resolved() {
        use crate::commands::agent_accounts::{AgentAccountRuntimeState, LaunchAccountProvenance};
        use crate::install::agent_account_store::{
            AccountResolutionReason, AccountResolutionSource, AgentProvider,
        };
        let state = DashboardLaunchState::new(4);
        let accounts = AgentAccountRuntimeState::default();
        let claim = runtime_claim("sess-codex", "managed");
        accounts
            .stage_owned_provenance(
                "sess-codex",
                Some(LaunchAccountProvenance {
                    runtime: codesense_pty_core::agent_cli::AgentCli::Codex,
                    provider: Some(AgentProvider::Codex),
                    source: AccountResolutionSource::Explicit,
                    reason: AccountResolutionReason::ExplicitOverride,
                    account_id: Some("codex-work".into()),
                    label: None,
                    generation: Some(3),
                    home: None,
                }),
                Some(claim.clone()),
            )
            .unwrap();
        assert!(state.begin("trigger-launch:k").unwrap());

        bind_managed_session(
            &state,
            Some(&accounts),
            "trigger-launch:k",
            "sess-codex",
            &claim,
        )
        .unwrap();
        assert_eq!(
            state.account_runtime_for_session("sess-codex"),
            Some(codesense_pty_core::agent_cli::AgentCli::Codex)
        );

        // A session whose spawn staged nothing for its claim records no account.
        let other = runtime_claim("sess-plain", "managed");
        assert!(state.begin("plain").unwrap());
        bind_managed_session(&state, Some(&accounts), "plain", "sess-plain", &other).unwrap();
        assert_eq!(state.account_runtime_for_session("sess-plain"), None);
    }

    #[test]
    fn idempotent_focus_cannot_upgrade_raw_capture_consent() {
        let state = DashboardLaunchState::new(1);
        assert!(state.begin("story").unwrap());
        state.bind("story", "session", None).unwrap();
        stamp_raw_capture_for_fresh_launch(&state, "story", false, true);
        assert!(!state.raw_capture_enabled_for_session("session"));
    }
    use crate::domain::SourceRepoSlug;

    // ---- Work-product fill on the shared launch spine (caller-agnostic) -----

    use crate::commands::sprint_run::run_store::RunWorkProductProvenance;

    fn sample_work_product() -> RunWorkProductProvenance {
        RunWorkProductProvenance {
            source_repo: SourceRepoSlug::new("alderco", "codesense").expect("valid slug"),
            branch: "feat/x".into(),
            credential_ref: None,
        }
    }

    #[tokio::test]
    async fn fill_launch_work_product_fills_when_provenance_and_branch_present() {
        let mut provenance = Some(RunProvenance {
            run_id: "run-1".into(),
            story_id: "SW-AU-96D".into(),
            ..Default::default()
        });
        let wp = sample_work_product();
        let expected = wp.clone();
        fill_launch_work_product(&mut provenance, Some("feat/x".into()), |branch| {
            assert_eq!(
                branch, "feat/x",
                "the resolved branch is threaded to the snapshot"
            );
            async move { Some(wp) }
        })
        .await;
        assert_eq!(provenance.unwrap().work_product, Some(expected));
    }

    #[tokio::test]
    async fn fill_launch_work_product_is_a_noop_without_provenance() {
        // A bare shell (no run provenance) never snapshots — the closure must not run.
        let mut provenance: Option<RunProvenance> = None;
        fill_launch_work_product(&mut provenance, Some("feat/x".into()), |_| async {
            panic!("snapshot must not run without provenance");
        })
        .await;
        assert!(provenance.is_none());
    }

    #[tokio::test]
    async fn fill_launch_work_product_leaves_none_without_a_resolvable_branch() {
        // No reconciled branch (no written/recorded frontmatter) → fill skipped, work_product None.
        let mut provenance = Some(RunProvenance {
            run_id: "run-1".into(),
            story_id: "SW-AU-96D".into(),
            ..Default::default()
        });
        fill_launch_work_product(&mut provenance, None, |_| async {
            panic!("snapshot must not run without a resolvable branch");
        })
        .await;
        assert_eq!(provenance.unwrap().work_product, None);
    }

    #[tokio::test]
    async fn fill_launch_work_product_records_none_when_the_snapshot_fails() {
        // Branch resolved, but the snapshot itself returns None (a failed branch verify,
        // credential lookup, or auth resolution): the fill records None rather than a stale
        // or fabricated work product.
        let mut provenance = Some(RunProvenance {
            run_id: "run-1".into(),
            story_id: "SW-AU-96D".into(),
            ..Default::default()
        });
        fill_launch_work_product(&mut provenance, Some("feat/x".into()), |_| async { None }).await;
        assert_eq!(provenance.unwrap().work_product, None);
    }

    // ---- SW-OR-1b: honest reconcile-report decision (AC-2/AC-3/AC-6) -------

    #[test]
    fn reconcile_report_flags_genuine_drift() {
        // A recorded branch that differs from what was written → honest {from,to}.
        assert_eq!(
            reconcile_report(Some("feat/old".into()), Some("feat/new".into())),
            Some(BranchReconcile {
                from: Some("feat/old".into()),
                to: "feat/new".into(),
            })
        );
    }

    #[test]
    fn reconcile_report_cold_story_reports_from_none() {
        // Cold story (no prior branch) that gets `branch` established → {from:null,to}.
        assert_eq!(
            reconcile_report(None, Some("feat/fresh".into())),
            Some(BranchReconcile {
                from: None,
                to: "feat/fresh".into(),
            })
        );
    }

    #[test]
    fn reconcile_report_suppresses_noise_and_noops() {
        // Idempotent / fail-safe: nothing written ⇒ nothing reported.
        assert_eq!(reconcile_report(Some("feat/x".into()), None), None);
        assert_eq!(reconcile_report(None, None), None);
        // Wrote a byte-identical value (materialized canonical from equal legacy) ⇒
        // no noisy "x → x" line.
        assert_eq!(
            reconcile_report(Some("feat/x".into()), Some("feat/x".into())),
            None
        );
    }

    // ---- The open reconcile reports a drift and writes nothing ---------------

    /// An open whose story records another branch than the worktree's HEAD reports the
    /// drift, on that open and on every later one, and leaves the story doc in the
    /// canonical clone byte for byte as it was.
    #[test]
    fn open_reconcile_leaves_the_canonical_clone_clean() {
        const DOC: &str = "---\nstatus: todo\nbranch: feat/old\n---\n# Story\n";
        let clone = tempfile::tempdir().unwrap();
        committed_repo(clone.path(), "main", &[("story.md", DOC)]);
        let story = clone.path().join("story.md");
        let worktree = tempfile::tempdir().unwrap();
        let oid = committed_repo(worktree.path(), "feat/new", &[]);
        let drift = (
            Some(BranchReconcile {
                from: Some("feat/old".into()),
                to: "feat/new".into(),
            }),
            Some("feat/new".to_string()),
        );
        // A repeat open reports the drift again: nothing wrote `branch:` in between.
        for _ in 0..2 {
            assert_eq!(
                reconcile_on_open_core(&story, Some("feat/old".into()), worktree.path()),
                drift
            );
        }
        assert_eq!(porcelain(clone.path()), Vec::<String>::new());
        assert_eq!(std::fs::read_to_string(&story).unwrap(), DOC);

        // A story never stamped reports where the worktree is.
        assert_eq!(
            reconcile_on_open_core(&story, None, worktree.path()),
            (
                Some(BranchReconcile {
                    from: None,
                    to: "feat/new".into(),
                }),
                Some("feat/new".to_string()),
            )
        );
        // In sync: nothing to report, and the launch's branch is the recorded one.
        assert_eq!(
            reconcile_on_open_core(&story, Some("feat/new".into()), worktree.path()),
            (None, Some("feat/new".to_string()))
        );
        // A detached HEAD or an unreadable one reports nothing and falls back to `from`.
        git2::Repository::open(worktree.path())
            .unwrap()
            .set_head_detached(oid)
            .unwrap();
        assert_eq!(
            reconcile_on_open_core(&story, Some("feat/old".into()), worktree.path()),
            (None, Some("feat/old".to_string()))
        );
        let not_a_repo = tempfile::tempdir().unwrap();
        assert_eq!(
            reconcile_on_open_core(&story, Some("feat/old".into()), not_a_repo.path()),
            (None, Some("feat/old".to_string()))
        );
        assert_eq!(porcelain(clone.path()), Vec::<String>::new());
        assert_eq!(std::fs::read_to_string(&story).unwrap(), DOC);
    }

    /// The open reconcile only reads: its body never reaches the story-doc writer.
    #[test]
    fn reconcile_branch_on_open_never_writes() {
        let body = fn_source(
            include_str!("mcp_workspace.rs"),
            "fn reconcile_branch_on_open(",
        );
        assert!(!body.contains("write_story_branch"));
        assert!(body.contains("reconcile_on_open_core("));
    }

    /// Every MCP-side registration (open, hydrate, seat) goes through
    /// `establish_story_worktree`, which registers through the same blocking body as the
    /// Tauri command the frontend calls. No variant stamps the story's `branch`: the one
    /// body has no flag and no writer, and the command only reports the branch.
    #[test]
    fn mcp_open_establishes_without_the_branch_stamp() {
        let squash = crate::test_support::source_guard::squashed;
        let workspace = include_str!("mcp_workspace.rs");
        let establish = fn_source(workspace, "async fn establish_story_worktree(");
        assert!(establish.contains("establish_worktree_story_link_blocking("));
        assert!(!establish.contains("establish_worktree_story_link("));
        let hydrate = fn_source(
            workspace,
            "pub(crate) async fn resolve_hydrated_story_worktree(",
        );
        assert!(hydrate.contains("resolve_hydrated_story_worktree_unlocked("));
        let unlocked = fn_source(
            workspace,
            "async fn resolve_hydrated_story_worktree_unlocked(",
        );
        assert!(unlocked.contains("establish_story_worktree("));
        assert!(!unlocked.contains("establish_worktree_story_link"));
        let seat = fn_source(workspace, "async fn ensure_seat_worktree(");
        assert!(!seat.contains("establish_worktree_story_link"));

        // `no_caller_stamps_the_canonical_clone` (content_engine.rs) checks the writer and
        // the stamping variants are gone.
        let engine = include_str!("content_engine.rs");
        let command = squash(fn_source(
            engine,
            "pub async fn establish_worktree_story_link(",
        ));
        assert!(command.contains("establish_worktree_story_link_blocking("));
        assert!(command.contains("link_branch_report("));
        let blocking = squash(fn_source(
            engine,
            "pub(crate) fn establish_worktree_story_link_blocking(",
        ));
        assert!(blocking.contains("register_story_workspace("));
        assert!(!blocking.contains("stamp"));
    }

    /// A story index across orgs: `(org, story_id, team)` rows, looked up the way the app
    /// answers a miss: the active org's fallback scan with its multi-line not-found text,
    /// another org with `resolve_story_path_in`'s one line. `late` rows were
    /// written after the index was built, so only a rescan finds them; the active org is
    /// never rescanned. `errors` makes an org's lookups fail. Records the orgs it was asked
    /// about and the orgs it rescanned.
    struct Orgs {
        stories: Vec<(&'static str, &'static str, &'static str)>,
        late: Vec<(&'static str, &'static str, &'static str)>,
        errors: Vec<(&'static str, String)>,
        asked: Vec<String>,
        rescanned: Vec<String>,
    }

    impl Orgs {
        fn new(stories: &[(&'static str, &'static str, &'static str)]) -> Self {
            Orgs {
                stories: stories.to_vec(),
                late: Vec::new(),
                errors: Vec::new(),
                asked: Vec::new(),
                rescanned: Vec::new(),
            }
        }

        fn pick(
            &mut self,
            records: &[WorktreeStoryRecord],
            story_id: &str,
            hint: Option<&str>,
        ) -> Result<(String, String), String> {
            let synced = || -> Result<Vec<String>, String> {
                Ok(vec!["acme/active".into(), "acme/b".into(), "acme/c".into()])
            };
            let find = |rows: &[(&str, &str, &str)], org: &str| {
                rows.iter()
                    .find(|(o, id, _)| *o == org && *id == story_id)
                    .map(|(_, id, team)| StoryPathResolution {
                        story_file_path: format!("/{org}/{team}/{id}.md"),
                        team: team.to_string(),
                        source_repo: None,
                    })
                    .ok_or_else(|| {
                        if org == "acme/active" {
                            active_not_found(story_id)
                        } else {
                            format!("unavailable: no managed story with id '{story_id}'")
                        }
                    })
            };
            let error = |org: &str| {
                self.errors
                    .iter()
                    .find(|(o, _)| *o == org)
                    .map(|(_, error)| Err::<StoryPathResolution, _>(error.clone()))
            };
            let all: Vec<_> = self.stories.iter().chain(&self.late).copied().collect();
            let (asked, rescanned) = (&mut self.asked, &mut self.rescanned);
            pick_story_org(
                records,
                story_id,
                hint,
                synced,
                |org| {
                    asked.push(org.to_string());
                    error(org).unwrap_or_else(|| find(&self.stories, org))
                },
                |org| {
                    if org == "acme/active" {
                        return None;
                    }
                    rescanned.push(org.to_string());
                    Some(error(org).unwrap_or_else(|| find(&all, org)))
                },
            )
            .map(|(org, resolution)| (org, resolution.team))
        }
    }

    /// The active org's not-found after its fallback scan, as
    /// `resolve_story_path_with_fallback` words it.
    fn active_not_found(story_id: &str) -> String {
        format!(
            "unavailable: no managed story with id '{story_id}'\n\
             Frontmatter cache + fallback scan both missed; verify the file is in a \
             content layer with type: story and story_id: {story_id}. Call \
             refresh_frontmatter_cache(path) if the file was just written outside CodeSense."
        )
    }

    #[test]
    fn a_worktree_record_names_the_storys_org() {
        let mut orgs = Orgs::new(&[("acme/b", "S-1", "web"), ("acme/c", "S-1", "api")]);
        let records = [record("S-1", "acme/c", "/wt")];
        assert_eq!(
            orgs.pick(&records, "S-1", None).unwrap(),
            ("acme/c".into(), "api".into())
        );
        assert_eq!(orgs.asked, ["acme/c"], "a record needs no search");
    }

    #[test]
    fn a_record_in_another_org_is_ignored_when_an_org_is_given() {
        let mut orgs = Orgs::new(&[("acme/b", "S-1", "web"), ("acme/c", "S-1", "api")]);
        let records = [record("S-1", "acme/c", "/wt")];
        assert_eq!(
            orgs.pick(&records, "S-1", Some("acme/b")).unwrap(),
            ("acme/b".into(), "web".into())
        );
        assert_eq!(orgs.asked, ["acme/b"]);
    }

    #[test]
    fn an_org_hint_is_the_only_org_looked_in() {
        let mut orgs = Orgs::new(&[("acme/b", "S-1", "web")]);
        assert_eq!(
            orgs.pick(&[], "S-1", Some("acme/c")).unwrap_err(),
            "unavailable: no managed story with id 'S-1'"
        );
        assert_eq!(orgs.asked, ["acme/c"], "a hinted lookup never searches");
    }

    #[test]
    fn a_team_agents_own_org_wins_over_the_active_org() {
        // The hint a team caller passes is its own org, whatever org is active.
        let mut orgs = Orgs::new(&[
            ("acme/active", "S-1", "home"),
            ("acme/b", "S-1", "riverside"),
        ]);
        assert_eq!(
            orgs.pick(&[], "S-1", Some("acme/b")).unwrap(),
            ("acme/b".into(), "riverside".into())
        );
        assert_eq!(orgs.asked, ["acme/b"]);
    }

    #[test]
    fn with_no_hint_an_id_unique_to_a_non_active_org_opens_there() {
        let mut orgs = Orgs::new(&[("acme/b", "S-1", "riverside")]);
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap(),
            ("acme/b".into(), "riverside".into())
        );
        assert_eq!(orgs.asked, ["acme/active", "acme/b", "acme/c"]);
    }

    #[test]
    fn with_no_hint_the_active_orgs_candidate_holds_the_id() {
        // The fallback scan found a file naming the id that does not carry it: that org
        // holds the id, so a search never opens another org's story past it.
        let candidate =
            "unavailable: story file candidate at /orgs/acme/active/dev/content/S-1.md \
             does not carry story_id 'S-1'\nVerify its frontmatter has type: story.";
        let mut orgs = Orgs::new(&[("acme/b", "S-1", "riverside")]);
        orgs.errors = vec![("acme/active", candidate.into())];
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap_err(),
            "unavailable: ambiguous story id 'S-1': it is in orgs acme/active, acme/b; pass org"
        );
        assert!(orgs.rescanned.is_empty(), "{:?}", orgs.rescanned);

        let mut orgs = Orgs::new(&[]);
        orgs.errors = vec![("acme/active", candidate.into())];
        assert_eq!(orgs.pick(&[], "S-1", None).unwrap_err(), candidate);

        let mut orgs = Orgs::new(&[]);
        orgs.late = vec![("acme/b", "S-1", "riverside")];
        orgs.errors = vec![("acme/active", candidate.into())];
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap_err(),
            candidate,
            "a candidate holds the id, so no rescan opens a late story elsewhere"
        );
        assert!(orgs.rescanned.is_empty(), "{:?}", orgs.rescanned);
    }

    #[test]
    fn with_no_hint_an_id_in_two_orgs_is_ambiguous() {
        let mut orgs = Orgs::new(&[("acme/active", "S-1", "home"), ("acme/c", "S-1", "api")]);
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap_err(),
            "unavailable: ambiguous story id 'S-1': it is in orgs acme/active, acme/c; pass org"
        );
    }

    #[test]
    fn with_no_hint_an_absent_id_is_not_found() {
        let mut orgs = Orgs::new(&[("acme/b", "S-2", "web")]);
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap_err(),
            "unavailable: no managed story with id 'S-1'"
        );
    }

    #[test]
    fn a_duplicate_within_one_org_keeps_its_own_error() {
        let mut orgs = Orgs::new(&[]);
        orgs.errors = vec![(
            "acme/b",
            "unavailable: ambiguous story id 'S-1' (2 indexed)".into(),
        )];
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap_err(),
            "unavailable: ambiguous story id 'S-1' (2 indexed)"
        );
    }

    #[test]
    fn with_no_hint_an_index_that_is_not_ready_is_not_a_holder() {
        // At boot every org's lookup fails the same way: the caller gets that reason, not
        // "ambiguous: it is in orgs ...".
        let not_ready = "unavailable: org story resolver not ready".to_string();
        let mut orgs = Orgs::new(&[]);
        orgs.errors = vec![
            ("acme/active", not_ready.clone()),
            ("acme/b", not_ready.clone()),
            ("acme/c", not_ready.clone()),
        ];
        assert_eq!(orgs.pick(&[], "S-1", None).unwrap_err(), not_ready);

        let mut orgs = Orgs::new(&[("acme/b", "S-1", "web")]);
        orgs.errors = vec![("acme/c", not_ready.clone())];
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap_err(),
            not_ready,
            "one unreadable org cannot be counted as holding or lacking the id"
        );
    }

    #[test]
    fn with_no_hint_records_in_two_orgs_are_ambiguous() {
        let mut orgs = Orgs::new(&[("acme/b", "S-1", "web"), ("acme/c", "S-1", "api")]);
        let records = [
            record("S-1", "acme/b", "/wt/b"),
            record("S-1", "acme/c", "/wt/c"),
        ];
        assert_eq!(
            orgs.pick(&records, "S-1", None).unwrap_err(),
            "unavailable: ambiguous story id 'S-1': it is in orgs acme/b, acme/c; pass org"
        );
        assert!(orgs.asked.is_empty(), "refused before any lookup");
        assert_eq!(
            orgs.pick(&records, "S-1", Some("acme/c")).unwrap(),
            ("acme/c".into(), "api".into()),
            "an org hint picks its own record"
        );
    }

    #[test]
    fn a_search_that_finds_the_id_rescans_no_org() {
        let mut orgs = Orgs::new(&[("acme/c", "S-1", "api")]);
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap(),
            ("acme/c".into(), "api".into())
        );
        assert!(orgs.rescanned.is_empty(), "{:?}", orgs.rescanned);
    }

    #[test]
    fn a_search_that_finds_nothing_rescans_each_held_org_once() {
        let mut orgs = Orgs::new(&[]);
        orgs.late = vec![("acme/c", "S-1", "api")];
        assert_eq!(
            orgs.pick(&[], "S-1", None).unwrap(),
            ("acme/c".into(), "api".into())
        );
        assert_eq!(orgs.rescanned, ["acme/b", "acme/c"], "never the active org");

        let mut orgs = Orgs::new(&[]);
        assert_eq!(
            orgs.pick(&[], "S-9", None).unwrap_err(),
            "unavailable: no managed story with id 'S-9'"
        );
        assert_eq!(orgs.rescanned, ["acme/b", "acme/c"]);
    }

    #[test]
    fn a_hinted_miss_rescans_its_org_once_and_a_scoped_missing_never() {
        let mut orgs = Orgs::new(&[]);
        orgs.late = vec![("acme/b", "S-1", "web")];
        assert_eq!(
            orgs.pick(&[], "S-1", Some("acme/b")).unwrap(),
            ("acme/b".into(), "web".into())
        );
        assert_eq!(orgs.rescanned, ["acme/b"]);

        // A story the caller cannot see stays unseen: a rescan cannot change that.
        let mut orgs = Orgs::new(&[]);
        orgs.errors = vec![(
            "acme/b",
            crate::context_repo::caller_scope::MISSING.to_string(),
        )];
        assert_eq!(
            orgs.pick(&[], "S-1", Some("acme/b")).unwrap_err(),
            crate::context_repo::caller_scope::MISSING
        );
        assert!(orgs.rescanned.is_empty());
    }

    fn record(story_id: &str, org: &str, path: &str) -> WorktreeStoryRecord {
        WorktreeStoryRecord::new(
            PathBuf::from(path),
            org.to_string(),
            SourceRepoSlug::new("owner", "repo").unwrap(),
            story_id.to_string(),
            PathBuf::from(format!("/content/{story_id}.md")),
        )
    }

    #[test]
    fn a_story_launch_resolves_its_base_worktree_never_a_seat() {
        let mut seat = record("SW-1", "org", "/wt-seat-dev");
        seat.seat = Some(SeatRecord {
            name: "dev".into(),
            kind: crate::install::worktree_index::SeatKind::Branch,
            pinned_commit: None,
            kept: None,
        });
        let base = record("SW-1", "org", "/wt");
        // The seat is listed first: a plain find-first would launch the lead into it.
        let records = vec![seat.clone(), base.clone()];
        assert_eq!(story_base_record(&records, "SW-1", "org"), Some(&base));
        // A story with only a seat record has no base worktree yet: it is created, not
        // borrowed from the seat.
        assert_eq!(story_base_record(&[seat], "SW-1", "org"), None);
        assert_eq!(story_base_record(&records, "SW-1", "other"), None);
    }

    #[test]
    fn launch_repository_identity_preserves_provider_and_host() {
        let mut gitlab = record("SW-OR-17", "org", "/wt");
        gitlab.source_repo =
            SourceRepoSlug::with_provider_and_host("owner", "repo", "gitlab", Some("gitlab.com"))
                .unwrap();

        let resolved =
            story_worktree_source_repo(&[gitlab.clone()], "SW-OR-17", "org", Path::new("/wt"))
                .unwrap();
        assert_eq!(resolved, gitlab.source_repo);
        assert_eq!(resolved.provider, "gitlab");
        assert_eq!(resolved.canonical_host(), "gitlab.com");
    }

    #[test]
    fn launch_repository_identity_uses_the_resolved_worktree_record() {
        let stale = record("SW-OR-17", "org", "/stale");
        let mut live = record("SW-OR-17", "org", "/live");
        live.source_repo = SourceRepoSlug::new("owner", "live-repo").unwrap();

        let resolved = story_worktree_source_repo(
            &[stale, live.clone()],
            "SW-OR-17",
            "org",
            Path::new("/live"),
        )
        .unwrap();
        assert_eq!(resolved, live.source_repo);
    }

    #[test]
    fn launch_snapshot_assembles_exact_immutable_work_product() {
        let source_repo = SourceRepoSlug::new("acme", "app").unwrap();
        let credential_ref = crate::domain::CredentialRef::github(42);
        let snapshot = run_work_product_provenance(
            source_repo.clone(),
            "feat/run-1".into(),
            Some(credential_ref.clone()),
        );
        assert_eq!(snapshot.source_repo, source_repo);
        assert_eq!(snapshot.branch, "feat/run-1");
        assert_eq!(snapshot.credential_ref, Some(credential_ref));
    }

    /// SW-WA-F10 (AC-2): the managed-launch dispatch path projects the scope
    /// via the one `project_scope` seam and appends the bundled Claude
    /// descriptor's `config_flag` flags IN ARGV SHAPE (unquoted — the launch
    /// spawns argv directly as PID-1 of the PTY, so quoting is the agent
    /// CLI's problem, not a shell's). `--strict-mcp-config` stays mandatory
    /// (it lives in the template) and `config_flag` yields no env. The
    /// capability gate: a descriptor-less adapter (None) yields no flags and
    /// no env — never a foreign agent's flags.
    #[test]
    fn dispatch_scope_projects_config_flags_through_the_bundled_descriptor() {
        let _home_env = crate::routines::test_support::TempHome::new();
        let scope = codesense_pty_core::agent_cli::descriptor(
            codesense_pty_core::agent_cli::AgentCli::Claude,
        )
        .mcp_scope
        .as_ref()
        .expect("built-in adapter declares mcp_scope");
        let dir = std::env::temp_dir().join(format!("an45-disp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".mcp.json"),
            br#"{"mcpServers":{"codesense":{"command":"/b"},"buildkite":{"command":"bk"}}}"#,
        )
        .unwrap();
        let sid = format!("shell-mcp-disp-{}", std::process::id());
        let outcome = crate::commands::mcp_scope::project_scope(
            &sid,
            &dir,
            &["buildkite".to_string()],
            Some(scope),
            str::to_string,
        )
        .unwrap();
        assert!(outcome.extra_env.is_empty(), "config_flag → no env");
        assert_eq!(outcome.extra_args[0], "--mcp-config");
        assert_eq!(outcome.extra_args[2], "--strict-mcp-config");
        assert!(
            !outcome.extra_args[1].starts_with('\''),
            "argv-direct path never shell-quotes the config path: {:?}",
            outcome.extra_args[1]
        );
        crate::commands::mcp_scope::remove_scope_config(&sid);
        let _ = std::fs::remove_dir_all(&dir);

        let none = crate::commands::mcp_scope::project_scope(
            "shell-mcp-disp-none",
            &dir,
            &[],
            None,
            |p| p.to_string(),
        )
        .unwrap();
        assert!(none.extra_args.is_empty() && none.extra_env.is_empty());
    }

    #[test]
    fn interactive_capture_mints_only_for_fresh_opt_in_launches() {
        use codesense_pty_core::agent_cli::InteractiveStructured;
        let descriptor = InteractiveStructured {
            session_log_glob: "~/logs/{session_id}.jsonl".into(),
            session_id_argv: Some(vec!["--session-id".into(), "{session_id}".into()]),
            format: codesense_pty_core::agent_cli::TranscriptFormat::AnthropicSessionJsonl,
        };
        let mut fresh_args = vec!["--existing".into()];
        let fresh = prepare_interactive_capture(descriptor.clone(), true, &mut fresh_args, || {
            "uuid-1".into()
        })
        .unwrap();
        assert_eq!(fresh.agent_session_id.as_deref(), Some("uuid-1"));
        assert_eq!(fresh_args, ["--existing", "--session-id", "uuid-1"]);

        let mut focus_args = vec!["--existing".into()];
        let focus = prepare_interactive_capture(descriptor, false, &mut focus_args, || {
            panic!("focus must not mint")
        })
        .unwrap();
        assert!(focus.agent_session_id.is_none());
        assert_eq!(focus_args, ["--existing"]);
    }

    #[test]
    fn legacy_interactive_capture_keeps_launch_argv_byte_identical() {
        use codesense_pty_core::agent_cli::InteractiveStructured;
        let descriptor = InteractiveStructured {
            session_log_glob: "~/logs/{session_id}.jsonl".into(),
            session_id_argv: None,
            format: codesense_pty_core::agent_cli::TranscriptFormat::AnthropicSessionJsonl,
        };
        let mut args = vec!["--existing".into()];
        let capture = prepare_interactive_capture(descriptor, true, &mut args, || {
            panic!("a template-less capture must not mint")
        })
        .unwrap();
        assert!(capture.agent_session_id.is_none());
        assert_eq!(args, ["--existing"]);
    }

    #[test]
    fn a_spawned_pty_is_tagged_with_the_bare_story_id() {
        let home = |kind: &str, form: &str| {
            LaunchHome::new(
                "acme/ctx",
                Some("default"),
                form,
                kind,
                Path::new("/wt"),
                SessionView::Background,
            )
        };
        assert_eq!(
            spawn_workspace_ident("SW-1#worker-1", &home("story", "SW-1")),
            "SW-1"
        );
        assert_eq!(
            spawn_workspace_ident("SW-1", &home("story", "SW-1")),
            "SW-1"
        );
        let worker = "_worker/acme/ctx/default/sprint-1";
        assert_eq!(
            spawn_workspace_ident(worker, &home("agent", worker)),
            worker
        );
    }

    #[test]
    fn launch_refusal_names_the_binary_and_keeps_the_preferred_wording() {
        // An unresolvable non-preferred binary is a typed `unavailable:` refusal naming
        // it (never a silent fallback); the preferred runtime's CLI keeps its message.
        let err = launch_refusal("codex");
        assert!(err.starts_with("unavailable:"));
        assert!(err.contains("codex"));
        assert_eq!(
            launch_refusal("claude"),
            "unavailable: no agent CLI configured".to_string()
        );
    }

    /// An executable stub `claude` in `dir` (never run).
    fn stub_cli(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("claude");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// The launch re-resolution against the PATH value `login_path`, counting its calls.
    fn counting_re_resolve(
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        login_path: String,
    ) -> impl FnOnce(&DependencyManager, &str) -> (LaunchBinaryLookup, Option<PendingShadowed>)
           + Send
           + 'static {
        move |deps, name| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            deps.re_resolve_stale_for_test(name, &login_path, "2.1.296")
        }
    }

    /// The launch authority on an app: a fresh cached binary launches without a
    /// re-resolve; a deleted one re-resolves once to the next install; with none left
    /// the launch gets the typed refusal, never a spawn of a missing file.
    #[tokio::test]
    async fn the_launch_authority_reuses_a_fresh_binary_and_re_resolves_a_gone_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        let in_a = stub_cli(&a);
        let in_b = stub_cli(&b);
        let only_b = b.display().to_string();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(DependencyManager::resolved_for_test(
            "claude",
            &a.display().to_string(),
            "2.1.296",
        ));
        let calls = Arc::new(AtomicUsize::new(0));

        // Unchanged: the cached binary, no re-resolve.
        let fresh = resolve_agent_for_launch_with(
            app.handle(),
            "claude",
            counting_re_resolve(calls.clone(), only_b.clone()),
        )
        .await;
        assert_eq!(
            fresh,
            Ok(ResolvedAgentBinary {
                path: in_a.clone(),
                version: Some("2.1.296".to_string()),
            })
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        // Deleted with another install: one re-resolve, the new path.
        std::fs::remove_file(&in_a).unwrap();
        let moved = resolve_agent_for_launch_with(
            app.handle(),
            "claude",
            counting_re_resolve(calls.clone(), only_b.clone()),
        )
        .await;
        assert_eq!(moved.map(|binary| binary.path), Ok(in_b.clone()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Deleted with nothing left: the typed refusal.
        std::fs::remove_file(&in_b).unwrap();
        let gone = resolve_agent_for_launch_with(
            app.handle(),
            "claude",
            counting_re_resolve(calls.clone(), only_b),
        )
        .await;
        let err = gone.expect_err("no install left is refused");
        assert!(err.starts_with("unavailable:"), "{err}");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_launch_lookup_is_a_ready_binary_or_the_typed_refusal() {
        let ready = ResolvedAgentBinary {
            path: PathBuf::from("/tmp/a/claude"),
            version: Some("2.1.296".to_string()),
        };
        assert_eq!(
            launch_lookup_result("claude", LaunchBinaryLookup::Ready(ready.clone())),
            Ok(ready)
        );
        // Still stale after its re-resolve, or nothing resolved: refused, never spawned.
        for lookup in [LaunchBinaryLookup::Stale, LaunchBinaryLookup::Unresolved] {
            let err = launch_lookup_result("codex", lookup).expect_err("refused");
            assert!(err.starts_with("unavailable:"), "{err}");
            assert!(err.contains("codex"));
        }
        assert_eq!(
            launch_lookup_result("claude", LaunchBinaryLookup::Unresolved),
            Err("unavailable: no agent CLI configured".to_string())
        );
    }

    /// AC-9: an MCP-launched story session lands under the key the viewer
    /// renders that story at — `{team key}|{story_id}` — described for a client
    /// that did not launch it.
    #[test]
    fn a_story_launch_home_is_the_viewers_story_key() {
        let home = LaunchHome::new(
            "acme/app",
            Some("core"),
            "SW-9",
            "story",
            Path::new("/wt/sw-9"),
            SessionView::Tab { focus: true },
        );
        assert_eq!(home.workspace.as_str(), "acme/app:core|SW-9");
        assert_eq!(home.descriptor.story_id.as_deref(), Some("SW-9"));
        assert_eq!(
            (
                home.descriptor.org.as_deref(),
                home.descriptor.team.as_deref()
            ),
            (Some("acme/app"), Some("core"))
        );
        let agent = LaunchHome::new(
            "acme/app",
            None,
            "loop-1",
            "agent",
            Path::new("/wt"),
            SessionView::Background,
        );
        assert_eq!(agent.workspace.as_str(), "acme/app:_none|loop-1");
        assert_eq!(agent.descriptor.story_id, None);
    }

    #[test]
    fn routine_and_spawned_worker_launches_hand_their_prompt_to_the_spine() {
        // A routine run's task and a spawned worker's brief are the agent's starting
        // prompt, through the same spine as every launch; neither is copied into an inbox.
        let routine = include_str!("../routines/dispatch.rs");
        let launch = routine
            .split("launch_managed_dir_session(")
            .nth(1)
            .unwrap()
            .split("ManagedLaunchOptions")
            .next()
            .unwrap();
        assert!(launch.contains("Some(&prompt),"), "{launch}");
        assert!(!routine.contains("agent_inbox::"));
        let worker = include_str!("../weft/spawn.rs");
        let launch = worker
            .split("mcp_workspace::launch_story_session_by(")
            .nth(1)
            .unwrap()
            .split("SessionView::Background")
            .next()
            .unwrap();
        assert!(
            launch.contains("req.initial_prompt.as_deref(),"),
            "{launch}"
        );
        assert!(!worker.contains("agent_inbox::"));
    }

    #[test]
    fn a_spawned_worker_resolves_its_story_in_the_stores_org_only() {
        // Both the worktree check and the launch look the story up in the org of the
        // captured Weft store, never by a search across every synced org. Matched with
        // whitespace squashed on both sides, whatever line breaks rustfmt gives a call.
        use crate::test_support::source_guard::squashed;
        let worker = squashed(include_str!("../weft/spawn.rs"));
        for call in [
            "mcp_workspace::resolve_hydrated_story_worktree(",
            "mcp_workspace::launch_story_session_by(",
        ] {
            let args = worker
                .split(&squashed(call))
                .nth(1)
                .unwrap()
                .split(".await")
                .next()
                .unwrap();
            // The store's org is the third argument, whole.
            let rest = args.strip_prefix("&self.app,&req.story_id,Some(self.store_org.as_str())");
            assert!(
                rest.is_some_and(|rest| rest.starts_with(',') || rest.starts_with(')')),
                "{call}{args}"
            );
        }
        // The MCP verb's agent precheck looks in the caller's own org.
        let handler = squashed(include_str!("../mcp/handler.rs"));
        let spawn = handler
            .split(&squashed("async fn wv_spawn_worker("))
            .nth(1)
            .unwrap()
            .split("require_launch_team")
            .next()
            .unwrap();
        assert!(
            spawn.contains(&squashed("caller_org(Some(&caller), None)")),
            "{spawn}"
        );
        assert!(
            spawn.contains(&squashed(
                ".story_team(&params.story_id, Some(org.as_str()))"
            )),
            "{spawn}"
        );
        let tail = handler
            .split(&squashed("async fn wv_spawn_worker("))
            .nth(1)
            .unwrap();
        assert!(
            tail.contains(&squashed(
                "wv_spawn_worker(&self.app_handle, path, store_team.org, req)"
            )),
            "the spawn gets the captured store's org"
        );
    }

    #[test]
    fn a_named_launch_names_its_tab() {
        let home = LaunchHome::new(
            "acme/app",
            Some("core"),
            "SW-BSI-1",
            "story",
            Path::new("/wt/sw-bsi-1"),
            SessionView::Tab { focus: false },
        );
        let tab = agent_open_tab("SW-BSI-1#demo", "shell-1", home, Some("demo".into()));
        // Named what it was launched as, never left for the host to number.
        assert_eq!(tab.name.as_deref(), Some("demo"));
        assert_eq!(
            tab.tags.get("handle").map(String::as_str),
            Some("SW-BSI-1#demo")
        );
        assert_eq!(tab.workspace.as_str(), "acme/app:core|SW-BSI-1");
        assert_eq!(tab.placement, Placement::Tab);
        assert!(!tab.activate);
    }

    #[test]
    fn mint_session_id_carries_shell_prefix_and_is_unique() {
        let a = mint_session_id();
        let b = mint_session_id();
        assert!(a.starts_with("shell-mcp-"));
        assert!(b.starts_with("shell-mcp-"));
        // The process-local counter guarantees no collision even within one tick
        // (a collision would make the spawn tear down the displaced session).
        assert_ne!(a, b, "two mints must never collide");
    }

    #[test]
    fn agent_basename_extracts_binary_name() {
        assert_eq!(
            agent_basename(Path::new("/opt/homebrew/bin/claude")),
            "claude"
        );
    }

    // SW-AN-2: a path with no filename falls back to the adapter's stable basename,
    // not a hardcoded "claude".
    #[test]
    fn agent_basename_fallback_is_the_preferred_runtimes() {
        assert_eq!(agent_basename(Path::new("/")), "claude");
    }
}

#[cfg(test)]
mod managed_launch_dir_tests {
    use super::managed_launch_dir;

    // SW-AGR-7: a home spelled through a symlink still admits its own users/
    // tree when the launch dir is canonical, and still refuses anything else.
    #[test]
    fn a_symlinked_home_admits_its_canonical_users_tree() {
        let real = tempfile::tempdir().unwrap();
        let link_parent = tempfile::tempdir().unwrap();
        let link = link_parent.path().join("home-link");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        let home = link.join(".codesense");
        let content = home.join("users").join("org").join("main").join("content");
        std::fs::create_dir_all(&content).unwrap();
        let canonical = content.canonicalize().unwrap();
        assert!(managed_launch_dir(&canonical, &home));
        assert!(managed_launch_dir(&content, &home));
        let outside = real.path().join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(!managed_launch_dir(&outside.canonicalize().unwrap(), &home));
    }
}

#[cfg(cap_git_ai)]
#[cfg(test)]
pub(crate) mod attribution_entry_tests {
    //! SV-CDE-7: the MCP / `open_workspace` launch's scope step switches git-ai capture on
    //! for a managed worktree, and never fails the launch when git-ai is not usable.
    use super::*;
    use crate::attribution::testing::{assert_unwired, assert_wired, Launch};
    use crate::attribution::{AttributionStatus, OffReason};
    use codesense_pty_core::agent_cli::AgentCli;

    pub(crate) fn scoped(
        fixture: &Launch,
    ) -> (
        Vec<String>,
        Vec<(String, String)>,
        Option<serde_json::Value>,
        String,
    ) {
        let id = format!("mcp-attr-{}", uuid::Uuid::new_v4());
        let args = fixture.launch.launch.args.clone();
        let inventory = crate::commands::mcp_scope::inventory::Fixture::new();
        let cli = inventory.launch(&args);
        let (args, env, _creation, settings) = project_managed_scope(
            &fixture.launch,
            &id,
            &fixture.cwd.to_string_lossy(),
            &cli,
            &args,
        )
        .expect("the launch itself succeeds");
        let json = settings
            .as_ref()
            .map(|s| serde_json::from_slice(&std::fs::read(s.path()).unwrap()).unwrap());
        (args, env, json, id)
    }

    #[test]
    fn claude_and_codex_launch_with_the_hooks_and_trace_env() {
        let _home_env = crate::routines::test_support::TempHome::new();
        for runtime in [AgentCli::Claude, AgentCli::Codex] {
            let fixture = Launch::new(runtime);
            let _daemon = fixture.daemon_running();
            let (args, env, settings, id) = scoped(&fixture);
            assert_wired(runtime, &args, settings.as_ref(), &env);
            assert_eq!(fixture.status(), Some(AttributionStatus::Active));
            crate::commands::mcp_scope::remove_scope_config(&id);
        }
    }

    #[test]
    fn opencode_off_repos_and_a_missing_git_ai_launch_unwired() {
        let _home_env = crate::routines::test_support::TempHome::new();
        let opencode = Launch::new(AgentCli::OpenCode);
        let (args, env, settings, id) = scoped(&opencode);
        assert_unwired(&args, settings.as_ref(), &env);
        crate::attribution::testing::assert_reflog_marker(&env, Some("opencode"));
        assert_eq!(
            opencode.status(),
            Some(AttributionStatus::Unsupported {
                reason: "opencode".into()
            })
        );
        crate::commands::mcp_scope::remove_scope_config(&id);

        let off = Launch::new(AgentCli::Codex);
        off.set_prefs(crate::attribution::prefs::AttributionPrefs {
            mode: Some(crate::attribution::prefs::AttributionMode::Off),
            ..Default::default()
        });
        let (args, env, settings, id) = scoped(&off);
        assert_unwired(&args, settings.as_ref(), &env);
        assert_eq!(
            off.status(),
            Some(AttributionStatus::Off {
                reason: OffReason::DisabledForRepo
            })
        );
        crate::commands::mcp_scope::remove_scope_config(&id);

        for runtime in [AgentCli::Claude, AgentCli::Codex] {
            let missing = Launch::new(runtime);
            missing.uninstall();
            let (args, env, settings, id) = scoped(&missing);
            assert_unwired(&args, settings.as_ref(), &env);
            assert_eq!(missing.status(), Some(AttributionStatus::NotInstalled));
            crate::commands::mcp_scope::remove_scope_config(&id);
        }
    }
}
