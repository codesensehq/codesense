// SPDX-License-Identifier: MIT
// Work items and launchers across the launch paths: each row launches through the registry
// entry method its path uses and checks the `launched_by` it records and its work item.

/// A launch's record with `launched_by` as its path passes it.
fn by(launched_by: Option<&str>) -> LaunchRecord {
    LaunchRecord {
        meta: LaunchMeta {
            launched_by: launched_by.map(str::to_string),
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Launch `handle` as an agent through `begin_with_provenance`, bound to `session`.
fn launch_agent(state: &DashboardLaunchState, handle: &str, session: &str, record: LaunchRecord) {
    assert!(state.begin_with_provenance(handle, None, record).unwrap());
    state.bind(handle, session, Some("codesense")).unwrap();
}

fn launched_by(state: &DashboardLaunchState, handle: &str) -> Option<String> {
    state
        .snapshot()
        .into_iter()
        .find(|s| s.handle == handle)
        .and_then(|s| s.meta.launched_by)
}

fn wi(raw: &str) -> crate::work_item::WorkItemId {
    crate::work_item::WorkItemId::parse(raw).unwrap()
}

/// The registry's side of every fresh launch path: who it records as the launcher and
/// whether it mints, inherits or leaves no work item.
#[test]
fn every_launch_path_records_its_launcher_and_work_item() {
    let state = DashboardLaunchState::new(16);
    // A lead a person started, and a lead's worker.
    launch_agent(&state, "lead", "s-lead", by(None));
    let lead = state.work_item("lead").expect("a person's agent launch mints");
    launch_agent(&state, "lead#worker", "s-worker", by(Some("s-lead")));
    // A plain shell the app opened, and one an agent opened through `open_terminal_tab`.
    state.register("shell", "s-shell", Some("codesense"));
    state.register("lead-shell", "s-lead-shell", Some("codesense"));
    state.set_launched_by_if_absent("lead-shell", "s-lead");
    // An agent launched from inside that shell, which belongs to no work item.
    launch_agent(&state, "shell#agent", "s-shell-agent", by(Some("s-shell")));
    // The Foreman's launch, the durable dispatch bridge and a routine's run: no launcher.
    launch_agent(&state, "foreman-story", "s-foreman", by(None));
    launch_agent(&state, "bridged", "s-bridged", by(None));
    let routine = RunProvenance {
        run_id: "run-1".into(),
        routine_key: Some("acme/ops/weekly".into()),
        ..Default::default()
    };
    assert!(state.begin_with_provenance("routine:acme/ops/weekly@run-1", Some(routine), by(None)).unwrap());

    let minted = |handle: &str| {
        let id = state.work_item(handle).unwrap_or_else(|| panic!("{handle} minted nothing"));
        assert_ne!(id, lead, "{handle} mints its own work item");
        id
    };
    struct Row<'a> {
        handle: &'a str,
        launched_by: Option<&'a str>,
    }
    for row in [
        Row { handle: "lead", launched_by: None },
        Row { handle: "lead#worker", launched_by: Some("lead") },
        Row { handle: "shell", launched_by: None },
        Row { handle: "lead-shell", launched_by: Some("lead") },
        Row { handle: "shell#agent", launched_by: Some("shell") },
        Row { handle: "foreman-story", launched_by: None },
        Row { handle: "bridged", launched_by: None },
        Row { handle: "routine:acme/ops/weekly@run-1", launched_by: None },
    ] {
        assert_eq!(launched_by(&state, row.handle).as_deref(), row.launched_by, "{}", row.handle);
    }
    assert_eq!(state.work_item("lead#worker"), Some(lead.clone()), "a worker inherits");
    assert_eq!(state.work_item("shell"), None, "a plain shell never mints");
    assert_eq!(state.work_item("lead-shell"), None, "an agent's shell never mints");
    let outside = minted("shell#agent");
    let foreman = minted("foreman-story");
    let bridged = minted("bridged");
    let routine = minted("routine:acme/ops/weekly@run-1");
    let all = [&lead, &outside, &foreman, &bridged, &routine];
    let distinct: std::collections::HashSet<_> = all.iter().collect();
    assert_eq!(distinct.len(), all.len(), "each root launch mints its own");
}

#[test]
fn a_tab_opener_never_overwrites_a_recorded_launcher_or_names_itself() {
    let state = DashboardLaunchState::new(4);
    launch_agent(&state, "lead", "s-lead", by(None));
    state.register("tab", "s-tab", Some("codesense"));
    state.set_launched_by_if_absent("tab", "s-tab");
    assert_eq!(launched_by(&state, "tab"), None, "a tab is not its own launcher");
    state.set_launched_by_if_absent("tab", "s-lead");
    state.set_launched_by_if_absent("tab", "someone-else");
    assert_eq!(launched_by(&state, "tab").as_deref(), Some("lead"));
}

/// A remote shell never mints; a remote agent inherits its launcher's work item, mints
/// without one, and a record that carries one (a restore, or its own receipt) keeps it.
#[test]
fn remote_launches_follow_the_same_rule() {
    let state = DashboardLaunchState::new(8);
    launch_agent(&state, "lead", "s-lead", by(None));
    let lead = state.work_item("lead").unwrap();

    let shell = roster_remote_record("remote-shell", "rs-1", "1", false);
    state.reserve_remote_shell(shell).unwrap();
    assert_eq!(state.work_item("remote-shell"), None);

    let mut worker = roster_remote_record("remote-worker", "rs-2", "1", true);
    worker.request_id = uuid::Uuid::new_v4();
    worker.identity.launched_by = Some("lead".into());
    state.reserve_remote_shell(worker).unwrap();
    assert_eq!(state.work_item("remote-worker"), Some(lead.clone()));

    let mut root = roster_remote_record("remote-root", "rs-3", "1", true);
    root.request_id = uuid::Uuid::new_v4();
    root.identity.launched_by = None;
    state.reserve_remote_shell(root).unwrap();
    let minted = state.work_item("remote-root").expect("a root remote agent mints");
    assert_ne!(minted, lead);

    let mut restored = roster_remote_record("remote-restored", "rs-4", "1", true);
    restored.request_id = uuid::Uuid::new_v4();
    restored.identity.launched_by = Some("lead".into());
    restored.identity.work_item = Some(wi("wi_00000000000000b2"));
    state.reserve_remote_shell(restored).unwrap();
    assert_eq!(state.work_item("remote-restored"), Some(wi("wi_00000000000000b2")));
}

#[test]
fn a_work_item_is_not_something_a_remote_launcher_says() {
    let identity = crate::commands::pty_layout::RemoteLaunchIdentity {
        work_item: Some(wi("wi_00000000000000a1")),
        ..Default::default()
    };
    assert!(identity.is_empty());
}

/// Both local restore paths keep the work item and never mint: a relaunch continuing a
/// session (read from its session record) and a tab's launch rebuilt from its tags (or,
/// without the tag, the saved registry).
#[test]
fn local_restores_keep_the_work_item_and_never_mint() {
    let dir = tempfile::tempdir().unwrap();
    let usage = dir.path().join("usage.sqlite");
    let store = crate::session_usage::UsageStore::open(&usage).unwrap();
    let mut old = crate::session_usage::record::SessionRecord::new("s-old");
    old.work_item = Some("wi_00000000000000a1".into());
    store.write_session_record(&old).unwrap();

    let state = DashboardLaunchState::new(8);
    state.set_task_store_path_for_test(usage.clone());
    launch_agent(&state, "lead", "s-lead", by(None));
    let mut relaunch = by(Some("lead"));
    relaunch.meta.continues = Some("s-old".into());
    launch_agent(&state, "restored", "s-new", relaunch);
    assert_eq!(state.work_item("restored"), Some(wi("wi_00000000000000a1")), "kept, not inherited");
    assert_eq!(launched_by(&state, "restored").as_deref(), Some("lead"));

    let mut none = by(None);
    none.meta.continues = Some("s-unknown".into());
    launch_agent(&state, "restored-none", "s-none", none);
    assert_eq!(state.work_item("restored-none"), None, "a restore never mints");

    let tagged = |session: &str, handle: &str, work_item: Option<&str>| RestoredLaunch {
        session: session.into(),
        handle: handle.into(),
        kind: KIND_DASHBOARD_LAUNCHED,
        agent_revision: None,
        team_key: None,
        principal: None,
        launcher: None,
        bound_at_ms: None,
        started_at_ms: None,
        launched_by: Some("lead".into()),
        name: None,
        role: None,
        avatar: None,
        story: None,
        chat_workspace_id: None,
        routine_key: None,
        deadline_ms: None,
        work_item: work_item.map(wi),
    };
    assert!(state.restore_launch(&tagged("s-tagged", "tagged", Some("wi_00000000000000c3")), None, None));
    assert_eq!(state.work_item("tagged"), Some(wi("wi_00000000000000c3")));
    assert!(state.restore_launch(&tagged("s-untagged", "untagged", None), None, None));
    assert_eq!(state.work_item("untagged"), None, "a restore never mints");
}

/// The work item is written to the launch tags and the saved registry, and a later app
/// process restores and registers the session with it.
#[test]
fn the_work_item_survives_an_app_restart() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("launch-registry.json");
    let before = DashboardLaunchState::new(4);
    before.install_persistence(registry.clone());
    launch_agent(&before, "lead", "s-lead", by(None));
    let id = before.work_item("lead").unwrap();
    before.flush_now();
    let patch = before.launch_tags_for_session("s-lead").unwrap();
    assert_eq!(
        patch.get(local_restore::TAG_LAUNCH_WORK_ITEM).cloned().flatten().as_deref(),
        Some(id.as_str())
    );
    assert!(is_launch_tag(local_restore::TAG_LAUNCH_WORK_ITEM));

    let after = DashboardLaunchState::new(4);
    after.install_persistence(registry);
    assert_eq!(after.persisted_work_item("lead", "s-lead"), Some(id.clone()));
    assert_eq!(after.persisted_work_item("lead", "s-other"), None, "only for its own session");
    after.register("lead", "s-lead", Some("codesense"));
    assert_eq!(after.work_item("lead"), Some(id), "a registration keeps it");
}

#[test]
fn a_bound_launch_writes_its_work_item_on_the_session_record() {
    let state = DashboardLaunchState::new(4);
    launch_agent(&state, "lead", "s-lead", by(None));
    state.register("shell", "s-shell", Some("codesense"));
    let write = compose_launch_write(&state, "s-lead", "lead", task_facts(None)).unwrap();
    assert_eq!(
        write.record.work_item.as_deref(),
        state.work_item("lead").as_ref().map(|id| id.as_str())
    );
    let shell = compose_launch_write(&state, "s-shell", "shell", task_facts(None)).unwrap();
    assert_eq!(shell.record.work_item, None);
}

/// Routine launches record `routine:<key>`, the identifier their queue authority uses; a
/// launcher filter matches it, and still matches a record in the legacy `routine <name>`.
#[test]
fn routine_launchers_match_in_both_forms() {
    assert_eq!(routine_launcher("acme/ops/weekly"), "routine:acme/ops/weekly");
    for (recorded, filter, matches) in [
        (Some("routine:acme/ops/weekly"), "routine:acme/ops/weekly", true),
        (Some("routine Weekly"), "routine:acme/ops/weekly", true),
        (Some("routine Weekly"), "routine Weekly", true),
        (Some("routine Steward weekly"), "routine:acme/ops/steward-weekly", true),
        (Some("routine Daily"), "routine:acme/ops/weekly", false),
        (Some("routine "), "routine:acme/ops/weekly", false),
        (Some("lead"), "routine:acme/ops/weekly", false),
        (Some("lead"), "lead", true),
        (None, "lead", false),
    ] {
        assert_eq!(launcher_matches(recorded, filter), matches, "{recorded:?} vs {filter}");
    }
}

#[test]
fn a_routine_session_owns_its_queue_as_its_launcher_id() {
    let state = DashboardLaunchState::new(4);
    let routine = RunProvenance {
        run_id: "run-1".into(),
        routine_key: Some("acme/ops/weekly".into()),
        ..Default::default()
    };
    assert!(state.begin_with_provenance("weekly-run", Some(routine), by(None)).unwrap());
    state.bind("weekly-run", "s-run", Some("routine")).unwrap();
    assert_eq!(
        state.queue_owner_for_session("s-run"),
        Some(routine_launcher("acme/ops/weekly"))
    );
}
