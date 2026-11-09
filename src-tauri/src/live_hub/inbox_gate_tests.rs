// SPDX-License-Identifier: MIT
//! The inbox pass runs only for inbox work, and only inbox changes are announced to inbox
//! readers: agent activity alone must not look like new mail.
use super::*;
use crate::commands::dashboard_launch::LaunchTeam;
use crate::mcp::session_list::SessionState;
use std::sync::atomic::AtomicUsize;

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
}
impl CountingHost {
    fn new() -> Self {
        CountingHost {
            dir: tempfile::tempdir().unwrap(),
            passes: AtomicUsize::new(0),
            changed: AtomicUsize::new(0),
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
        Ok(self.path())
    }
    async fn active_team(&self) -> Result<LaunchTeam, String> {
        self.passes.fetch_add(1, Ordering::Relaxed);
        Ok(team())
    }
    async fn synced_teams(&self) -> Result<Vec<LaunchTeam>, String> {
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
    let mut last = None;
    set_rows(&app, vec![row("worker", "Worker", SessionState::Idle)]);
    inbox_pass(app.handle(), &host, REBUILD | INBOX, &mut last)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "the first pass always runs");

    for flags in [MACHINE_STATS, FILES, MACHINE_STATS | FILES, REBUILD | HOSTS] {
        inbox_pass(app.handle(), &host, flags, &mut last)
            .await
            .unwrap();
        assert_eq!(host.take_passes(), 0, "flags {flags} carry no inbox work");
    }

    // Agent activity moves a session between running states the inbox treats alike.
    set_rows(&app, vec![row("worker", "Worker", SessionState::Running)]);
    inbox_pass(app.handle(), &host, REBUILD | HOSTS, &mut last)
        .await
        .unwrap();
    assert_eq!(
        host.take_passes(),
        0,
        "activity leaves the joined rows alone"
    );

    inbox_pass(app.handle(), &host, INBOX, &mut last)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "mail runs a pass");
}

#[tokio::test]
async fn joined_row_and_team_set_changes_run_the_inbox_pass() {
    let app = app();
    let host = CountingHost::new();
    let mut last = None;
    set_rows(&app, vec![row("worker", "Worker", SessionState::Idle)]);
    inbox_pass(app.handle(), &host, REBUILD, &mut last)
        .await
        .unwrap();
    host.take_passes();

    set_rows(&app, vec![row("worker", "Renamed", SessionState::Idle)]);
    inbox_pass(app.handle(), &host, REBUILD, &mut last)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a renamed session runs a pass");

    let mut moved = row("worker", "Renamed", SessionState::Idle);
    moved.team = None;
    set_rows(&app, vec![moved.clone()]);
    inbox_pass(app.handle(), &host, REBUILD, &mut last)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a session's team change runs a pass");

    set_rows(
        &app,
        vec![moved.clone(), row("helper", "Helper", SessionState::Idle)],
    );
    inbox_pass(app.handle(), &host, HOSTS, &mut last)
        .await
        .unwrap();
    assert_eq!(host.take_passes(), 1, "a new session runs a pass");

    set_rows(
        &app,
        vec![moved, row("helper", "Helper", SessionState::Exited)],
    );
    inbox_pass(app.handle(), &host, REBUILD, &mut last)
        .await
        .unwrap();
    assert_eq!(
        host.take_passes(),
        1,
        "a session that stops running runs a pass"
    );

    // A team synced or removed reconciles the team set with the rows unchanged.
    inbox_pass(app.handle(), &host, FOOTPRINT, &mut last)
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
    {
        let mut model = hub.model.lock().unwrap();
        model.agent_views.insert("all".into());
        model
            .projections
            .subscribe_window("native", "inbox", "all", None, None)
            .unwrap();
    }
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
}
