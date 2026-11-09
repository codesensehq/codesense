// SPDX-License-Identifier: MIT
//! The inbox pass runs only for inbox work, and only inbox changes are announced to inbox
//! readers: agent activity alone must not look like new mail.
use super::*;
use crate::commands::dashboard_launch::LaunchTeam;
use crate::mcp::session_list::SessionState;
use std::sync::atomic::{AtomicBool, AtomicUsize};

fn team() -> LaunchTeam {
    LaunchTeam {
        org: "acme".into(),
        team: "default".into(),
    }
}

fn row(handle: &str, name: &str, state: SessionState) -> SessionListRow {
    SessionListRow {
        id: handle.into(),
        team: Some(team()),
        queue_role: None,
        role_join_error: None,
        chat_workspace_id: None,
        group_unread: 0,
        group_read_id: 0,
        handle: handle.into(),
        display_name: name.into(),
        state,
        launched_by: None,
        story: None,
        workspace: None,
        role: None,
        avatar: None,
        agent: None,
        machine_id: None,
        workspace_handle: None,
        machine: None,
        unread: None,
        oldest_unread_at: None,
        mail_notice: None,
        notified_at: None,
        subagents: 0,
        inbox_waiter: Default::default(),
        progress: None,
        launch_telemetry: None,
        release_qualified: None,
        release_note: None,
        deadline_at_ms: None,
        expiring: false,
        session: Some(format!("tab-{handle}")),
        failed: false,
    }
}

/// Counts inbox passes (each asks for the active team) and `agent-inbox-changed` notices.
struct CountingHost {
    dir: tempfile::TempDir,
    passes: AtomicUsize,
    changed: AtomicUsize,
    store_failed: AtomicBool,
    discovery_failed: AtomicBool,
}
impl CountingHost {
    fn new() -> Self {
        CountingHost {
            dir: tempfile::tempdir().unwrap(),
            passes: AtomicUsize::new(0),
            changed: AtomicUsize::new(0),
            store_failed: AtomicBool::new(false),
            discovery_failed: AtomicBool::new(false),
        }
    }
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("inbox.sqlite3")
    }
    fn take_passes(&self) -> usize {
        self.passes.swap(0, Ordering::Relaxed)
    }
    fn take_changed(&self) -> usize {
        self.changed.swap(0, Ordering::Relaxed)
    }
}
#[async_trait::async_trait]
impl crate::commands::agent_inbox::InboxHost for CountingHost {
    async fn team_store(&self, _team: &LaunchTeam) -> Result<std::path::PathBuf, String> {
        if self.store_failed.load(Ordering::Relaxed) {
            return Err("temporarily unavailable".into());
        }
        Ok(self.path())
    }
    async fn active_team(&self) -> Result<LaunchTeam, String> {
        self.passes.fetch_add(1, Ordering::Relaxed);
        Ok(team())
    }
    async fn synced_teams(&self) -> Result<Vec<LaunchTeam>, String> {
        if self.discovery_failed.load(Ordering::Relaxed) {
            return Err("temporarily unavailable".into());
        }
        Ok(vec![team()])
    }
    fn launch_team(&self, _handle: &str) -> Option<LaunchTeam> {
        None
    }
    fn handle_for_session(&self, _session_id: &str) -> Option<String> {
        None
    }
    async fn sessions(&self) -> Result<crate::commands::agent_inbox::KnownSessions, String> {
        Ok(crate::commands::agent_inbox::KnownSessions::new(vec![]))
    }
    fn has_handle(&self, _handle: &str) -> bool {
        false
    }
    fn display_name(&self, _handle: &str) -> Option<String> {
        None
    }
    fn inbox_changed(&self) {
        self.changed.fetch_add(1, Ordering::Relaxed);
    }
    fn inbox_committed(&self, _changes: &[(LaunchTeam, Vec<i64>)]) {}
}

fn app() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(LiveHub::default());
    app
}

fn set_rows(app: &tauri::App<tauri::test::MockRuntime>, rows: Vec<SessionListRow>) {
    app.state::<LiveHub>().model.lock().unwrap().rows = rows;
}

#[tokio::test]
async fn machine_stats_and_files_batches_skip_the_inbox_pass() {
    let app = app();
    let host = CountingHost::new();
    let mut gate = InboxGate::default();
    set_rows(&app, vec![row("worker", "Worker", SessionState::Idle)]);
    inbox_pass(app.handle(), &host, REBUILD | INBOX, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "the first pass always runs");

    for flags in [MACHINE_STATS, FILES, MACHINE_STATS | FILES, REBUILD | HOSTS] {
        inbox_pass(app.handle(), &host, flags, &mut gate)
            .await
            .unwrap();
        assert_eq!(host.take_passes(), 0, "flags {flags} carry no inbox work");
    }

    // Agent activity moves a session between running states the inbox treats alike.
    set_rows(&app, vec![row("worker", "Worker", SessionState::Running)]);
    inbox_pass(app.handle(), &host, REBUILD | HOSTS, &mut gate)
        .await
        .unwrap();
    assert_eq!(
        host.take_passes(),
        0,
        "activity leaves the joined rows alone"
    );

    inbox_pass(app.handle(), &host, INBOX, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "mail runs a pass");
}

#[tokio::test]
async fn joined_row_and_team_set_changes_run_the_inbox_pass() {
    let app = app();
    let host = CountingHost::new();
    let mut gate = InboxGate::default();
    set_rows(&app, vec![row("worker", "Worker", SessionState::Idle)]);
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    host.take_passes();

    set_rows(&app, vec![row("worker", "Renamed", SessionState::Idle)]);
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a renamed session runs a pass");

    let mut moved = row("worker", "Renamed", SessionState::Idle);
    moved.team = None;
    set_rows(&app, vec![moved.clone()]);
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a session's team change runs a pass");

    set_rows(
        &app,
        vec![moved.clone(), row("helper", "Helper", SessionState::Idle)],
    );
    inbox_pass(app.handle(), &host, HOSTS, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a new session runs a pass");

    set_rows(
        &app,
        vec![moved.clone(), row("helper", "Helper", SessionState::Exited)],
    );
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    assert_eq!(
        host.take_passes(),
        1,
        "a session that stops running runs a pass"
    );

    let mut chatting = row("helper", "Helper", SessionState::Exited);
    chatting.chat_workspace_id = Some("workspace".into());
    set_rows(&app, vec![moved.clone(), chatting]);
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "joining a group chat runs a pass");

    app.manage(crate::mcp::state::ActiveTeamState::default());
    app.state::<crate::mcp::state::ActiveTeamState>()
        .update(crate::mcp::state::ActiveTeam {
            org_slug: "acme".into(),
            team_name: "other".into(),
        });
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    assert_eq!(
        host.take_passes(),
        1,
        "switching the active team runs a pass"
    );

    // A team synced or removed reconciles the team set with the rows unchanged.
    inbox_pass(app.handle(), &host, FOOTPRINT, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a team-set change runs a pass");
}

#[tokio::test]
async fn an_agent_list_change_without_mail_announces_nothing_to_inbox_readers() {
    use crate::weft::{inbox as ledger, WeftStore};
    let app = app();
    let host = CountingHost::new();
    let store = WeftStore::open(host.path()).unwrap();
    ledger::inbox_insert(
        &store, "worker", "human", "mail", None, None, None, None, None,
    )
    .unwrap();
    set_rows(&app, vec![row("worker", "Worker", SessionState::Idle)]);
    let hub = app.state::<LiveHub>();
    // No inbox view is open: readers are told from the projection, not from view deltas.
    hub.model.lock().unwrap().agent_views.insert("all".into());
    refresh_inbox_with_host(app.handle(), &host, false)
        .await
        .unwrap();
    assert_eq!(host.take_changed(), 1, "hydrating the inbox is announced");

    let topics = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = topics.clone();
    app.listen("codesense:delta", move |event| {
        let delta: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        seen.lock()
            .unwrap()
            .push(delta["topic"].as_str().unwrap_or_default().to_string());
    });
    {
        let mut model = hub.model.lock().unwrap();
        model.agent_ready = !model.agent_ready;
    }
    refresh_inbox_with_host(app.handle(), &host, false)
        .await
        .unwrap();
    assert!(
        topics.lock().unwrap().iter().any(|t| t == "agentList"),
        "the agent list changed"
    );
    assert_eq!(host.take_changed(), 0, "no mail changed");

    // A change to how the mail reads still is announced.
    set_rows(&app, vec![row("worker", "Renamed", SessionState::Idle)]);
    refresh_inbox_with_host(app.handle(), &host, false)
        .await
        .unwrap();
    assert_eq!(host.take_changed(), 1, "the sender's name changed");

    // A session that joins the team shows in its counts, with no mail of its own.
    set_rows(
        &app,
        vec![
            row("worker", "Renamed", SessionState::Idle),
            row("helper", "Helper", SessionState::Idle),
        ],
    );
    refresh_inbox_with_host(app.handle(), &host, false)
        .await
        .unwrap();
    assert_eq!(host.take_changed(), 1, "the team's counts changed");

    // A team that is no longer synced retires from the inbox.
    let mut elsewhere = row("visitor", "Visitor", SessionState::Idle);
    elsewhere.team = Some(LaunchTeam {
        org: "acme".into(),
        team: "elsewhere".into(),
    });
    set_rows(&app, vec![elsewhere]);
    refresh_inbox_with_host(app.handle(), &host, false)
        .await
        .unwrap();
    host.take_changed();
    set_rows(&app, vec![]);
    refresh_inbox_with_host(app.handle(), &host, true)
        .await
        .unwrap();
    assert!(!hub.model.lock().unwrap().inbox.contains_team(&LaunchTeam {
        org: "acme".into(),
        team: "elsewhere".into(),
    }));
    assert_eq!(host.take_changed(), 1, "a retired team is announced");
}

#[tokio::test(start_paused = true)]
async fn an_incomplete_pass_wakes_a_quiet_hub_and_backs_off() {
    let app = app();
    let hub = app.state::<LiveHub>();
    let host = CountingHost::new();
    let mut gate = InboxGate::default();
    set_rows(&app, vec![row("worker", "Worker", SessionState::Idle)]);
    host.store_failed.store(true, Ordering::Relaxed);
    inbox_pass(app.handle(), &host, REBUILD, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1);
    assert_eq!(
        gate.retry_delay, INBOX_RETRY,
        "a skipped team store is a retry"
    );

    inbox_pass(app.handle(), &host, MACHINE_STATS, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 0, "the retry is not due yet");

    // Nothing else happens: the retry's own timer wakes the hub.
    let started = tokio::time::Instant::now();
    let flags = hub.next_batch().await;
    assert!(started.elapsed() >= INBOX_RETRY);
    inbox_pass(app.handle(), &host, flags, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a due retry runs");
    assert_eq!(
        gate.retry_delay,
        INBOX_RETRY * 2,
        "a second failure waits longer"
    );

    host.store_failed.store(false, Ordering::Relaxed);
    let started = tokio::time::Instant::now();
    let flags = hub.next_batch().await;
    assert!(started.elapsed() >= INBOX_RETRY * 2);
    inbox_pass(app.handle(), &host, flags, &mut gate)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1);
    assert!(gate.retry_at.is_none(), "the pass completed");
    assert_eq!(gate.retry_delay, Duration::ZERO);

    inbox_pass(app.handle(), &host, MACHINE_STATS, &mut gate)
        .await
        .unwrap();
    assert_eq!(
        host.take_passes(),
        0,
        "nothing is owed after a complete pass"
    );
}

#[tokio::test]
async fn no_active_team_is_not_a_failure() {
    use crate::commands::agent_inbox::InboxHost as _;
    struct NoActiveTeam(CountingHost);
    #[async_trait::async_trait]
    impl crate::commands::agent_inbox::InboxHost for NoActiveTeam {
        async fn team_store(&self, team: &LaunchTeam) -> Result<std::path::PathBuf, String> {
            self.0.team_store(team).await
        }
        async fn active_team(&self) -> Result<LaunchTeam, String> {
            Err("no active team selected".into())
        }
        async fn synced_teams(&self) -> Result<Vec<LaunchTeam>, String> {
            self.0.synced_teams().await
        }
        fn launch_team(&self, _handle: &str) -> Option<LaunchTeam> {
            None
        }
        fn handle_for_session(&self, _session_id: &str) -> Option<String> {
            None
        }
        async fn sessions(&self) -> Result<crate::commands::agent_inbox::KnownSessions, String> {
            self.0.sessions().await
        }
        fn has_handle(&self, _handle: &str) -> bool {
            false
        }
        fn display_name(&self, _handle: &str) -> Option<String> {
            None
        }
        fn inbox_changed(&self) {}
    }
    let app = app();
    let mut gate = InboxGate::default();
    inbox_pass(
        app.handle(),
        &NoActiveTeam(CountingHost::new()),
        REBUILD,
        &mut gate,
    )
    .await
    .unwrap();
    assert!(gate.retry_at.is_none());
}

#[tokio::test(start_paused = true)]
async fn a_team_set_change_whose_pass_fails_still_reconciles_on_the_retry() {
    let app = app();
    let hub = app.state::<LiveHub>();
    let host = CountingHost::new();
    let mut gate = InboxGate::default();
    host.discovery_failed.store(true, Ordering::Relaxed);
    inbox_pass(app.handle(), &host, FOOTPRINT, &mut gate)
        .await
        .unwrap();
    assert!(
        gate.reconcile,
        "discovery failed, so no team was reconciled"
    );

    host.discovery_failed.store(false, Ordering::Relaxed);
    let flags = hub.next_batch().await;
    assert_eq!(
        flags & FOOTPRINT,
        0,
        "the retry's wake carries no team-set change"
    );
    inbox_pass(app.handle(), &host, flags, &mut gate)
        .await
        .unwrap();
    assert!(!gate.reconcile, "the retry reconciled the team set");
    assert!(gate.retry_at.is_none());
}

#[tokio::test]
async fn a_reported_context_sync_reconciles_the_inbox_teams() {
    let app = app();
    listen_sources(app.handle());
    app.emit(
        crate::commands::context_repo_git::CONTEXT_REPO_STATUS_CHANGED,
        "/repo",
    )
    .unwrap();
    assert_eq!(app.state::<LiveHub>().next_batch().await, FOOTPRINT);
}
