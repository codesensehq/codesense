// SPDX-License-Identifier: MIT
use super::*;

pub(crate) struct Fixture {
    pub temp: tempfile::TempDir,
    pub home: std::path::PathBuf,
    pub root: std::path::PathBuf,
    pub scope: CallerScope,
}
impl Fixture {
    pub fn new() -> Self {
        let (temp, _) = inheritance::test_fixture();
        let home = temp.path().canonicalize().unwrap().join(".codesense");
        std::fs::create_dir(&home).unwrap();
        std::fs::rename(temp.path().join("users"), home.join("users")).unwrap();
        let root = home.join("users/1/orgs/acme/ctx");
        std::fs::create_dir(root.join(".git")).unwrap();
        let scope = CallerScope::Team(inheritance::team_view(&root, "acme/ctx", "child"));
        Self {
            temp,
            home,
            root,
            scope,
        }
    }
    pub fn path(&self, team: &str, logical: &str) -> std::path::PathBuf {
        self.root.join(format!("{team}/{logical}"))
    }
    pub fn write(&self, team: &str, logical: &str, content: &str) -> std::path::PathBuf {
        let path = self.path(team, logical);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }
    pub fn roots(&self) -> Vec<crate::context_query::index::IndexRoot> {
        ["child", "parent", "grand", "sibling"]
            .into_iter()
            .map(|team| crate::context_query::index::IndexRoot {
                dir: self.path(team, "content"),
                org: Some("acme/ctx".into()),
                team: Some(team.into()),
                layer: crate::context_query::model::Layer::Team,
            })
            .collect()
    }
    pub fn agent(&self, team: &str, id: &str) -> crate::agents::AgentKey {
        crate::agents::service::save(
            &self.home,
            &Principal::from(1u64),
            crate::agents::SaveTarget::Create(crate::agents::Placement::Team {
                org: "acme/ctx".into(),
                team: team.into(),
            }),
            crate::routines::test_support::agent(
                id,
                codesense_pty_core::agent_cli::AgentCli::Claude,
            ),
            &crate::routines::Author::user("1"),
        )
        .unwrap()
        .key
    }
    pub fn routine(&self, team: &str, id: &str) -> String {
        self.write(team, &format!("config/agents/{}/routines/{id}/routine.yml", crate::routines::layout::COMMAND_DIR),
            &format!("id: {id}\nname: {team} routine\nowner: '1'\naction: command\npolicy: {{max_runtime: 5m, overlap: queue}}\ncommand: [echo, hello]\nwhere: {{kind: team_workspace}}\nrevision: 1\n"));
        format!("acme/ctx/{team}/{id}")
    }
    pub fn service(&self) -> crate::context_query::ContextIndexService {
        self.service_with(self.roots())
    }
    pub fn service_with(
        &self,
        roots: Vec<crate::context_query::index::IndexRoot>,
    ) -> crate::context_query::ContextIndexService {
        use std::sync::Arc;
        let service = crate::context_query::ContextIndexService::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        service.start(
            Arc::new(move || {
                Some(crate::context_query::service::Footprint {
                    owner: 1,
                    roots: roots.clone(),
                    summary_headings: vec![],
                })
            }),
            Arc::new(move |_| {
                let _ = tx.lock().unwrap().send(());
            }),
        );
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        service
    }
}

/// What a second org on the same profile holds, beside the placed docs and two
/// look-alikes of them.
pub(crate) struct OtherOrg {
    pub team_file: PathBuf,
    pub private_file: PathBuf,
    pub private_root: PathBuf,
    pub docs_file: PathBuf,
    pub look_alikes: Vec<PathBuf>,
    pub roots: Vec<crate::context_query::index::IndexRoot>,
}
fn write_file(path: &Path, content: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
    path.to_path_buf()
}
fn write_org(root: &Path, slug: &str, team: &str) {
    write_file(
        &root.join("org.yml"),
        &format!("slug: {slug}\ndisplay_name: Other\ncreated_at: \"2026-01-01T00:00:00Z\"\n"),
    );
    write_file(
        &root.join("teams.yml"),
        &format!("teams:\n  - name: {team}\n"),
    );
}
impl Fixture {
    pub fn other_org(&self) -> OtherOrg {
        use crate::context_query::{index::IndexRoot, model::Layer};
        use crate::context_repo::{codesense_docs, scratch_space};
        let principal = Principal::from(1u64);
        let other = self.home.join("users/1/orgs/globex/ctx");
        write_org(&other, "globex/ctx", "ops");
        let team_file = write_file(&other.join("ops/content/plan.md"), "globex-plan-bytes");
        let space = scratch_space::ensure_org_space(&self.home, &principal, "globex/ctx")
            .unwrap()
            .0;
        let private_file = write_file(&space.content_dir().join("notes.md"), "globex-notes-bytes");
        let docs = codesense_docs::docs_root(&self.home, &principal);
        let bundle = codesense_docs::bundle_info();
        write_org(&docs, &bundle.slug, &bundle.team);
        let docs_file = write_file(
            &docs.join(&bundle.team).join("content/guide.md"),
            "docs-guide-bytes",
        );
        // The docs' slug outside the placed root, and a docs-shaped folder in another org.
        let named_like = self.home.join("users/1/orgs/lookalike/docs");
        let nested = other.join("codesense-docs");
        let look_alikes: Vec<PathBuf> = [named_like, nested]
            .iter()
            .map(|root| {
                write_org(root, &bundle.slug, &bundle.team);
                write_file(
                    &root.join(&bundle.team).join("content/fake.md"),
                    "look-alike-bytes",
                )
            })
            .collect();
        let team_root = |dir: &Path, org: &str, team: &str| IndexRoot {
            dir: dir.to_path_buf(),
            org: Some(org.into()),
            team: Some(team.into()),
            layer: Layer::Team,
        };
        let mut roots = vec![
            team_root(team_file.parent().unwrap(), "globex/ctx", "ops"),
            IndexRoot {
                dir: space.content_dir(),
                org: Some("globex/ctx".into()),
                team: None,
                layer: Layer::Private,
            },
        ];
        for file in std::iter::once(&docs_file).chain(&look_alikes) {
            roots.push(team_root(
                file.parent().unwrap(),
                &bundle.slug,
                &bundle.team,
            ));
        }
        OtherOrg {
            team_file,
            private_file,
            private_root: space.root(),
            docs_file,
            look_alikes,
            roots,
        }
    }
    pub fn team_view(&self) -> Arc<inheritance::TeamView> {
        match &self.scope {
            CallerScope::Team(view) => view.clone(),
            _ => unreachable!(),
        }
    }
}

pub(crate) struct AppFixture {
    pub fixture: Fixture,
    pub app: tauri::App<tauri::test::MockRuntime>,
    previous: Option<std::ffi::OsString>,
    _env: std::sync::MutexGuard<'static, ()>,
}
impl AppFixture {
    pub fn new() -> Self {
        use tauri::Manager;
        let guard = crate::content_engine::test_support::env_guard();
        let fixture = Fixture::new();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", fixture.home.parent().unwrap());
        let app = crate::routines::test_support::launch_app(&fixture.home);
        app.manage(Arc::new(
            crate::dashboard_stream::frame::FrameStore::default(),
        ));
        app.state::<crate::mcp::state::ActiveTeamState>()
            .update(crate::mcp::state::ActiveTeam {
                org_slug: "acme/ctx".into(),
                team_name: "child".into(),
            });
        Self {
            fixture,
            app,
            previous,
            _env: guard,
        }
    }
    pub fn session(&self, id: &str, team: Option<&str>) {
        use crate::commands::dashboard_launch::{DashboardLaunchState, LaunchTeam};
        if self.app.try_state::<DashboardLaunchState>().is_none() {
            self.app.manage(DashboardLaunchState::new(16));
        }
        let state = self.app.state::<DashboardLaunchState>();
        state.register(id, id, Some("codesense"));
        if let Some(team) = team {
            state.set_launch_team_if_absent(
                id,
                LaunchTeam {
                    org: "acme/ctx".into(),
                    team: team.into(),
                },
            );
        }
    }

    pub fn frame(&self, page: &Path, scope: &str) -> crate::dashboard_stream::frame::FrameRecord {
        self.frame_for_team(page, scope, "child")
    }
    pub fn frame_for_team(
        &self,
        page: &Path,
        scope: &str,
        team: &str,
    ) -> crate::dashboard_stream::frame::FrameRecord {
        use crate::dashboard_stream::frame::*;
        use tauri::Manager;
        self.app.state::<Arc<FrameStore>>().mint(
            9321,
            FrameGrant {
                frame_id: String::new(),
                principal: "1".into(),
                dashboard: page.to_string_lossy().into(),
                slot: "right-pane".into(),
                team: Some(FrameTeam {
                    org: "acme/ctx".into(),
                    team: team.into(),
                }),
                scope: scope.into(),
            },
            self.fixture.path(team, "content").to_string_lossy().into(),
            page.to_string_lossy().into(),
            page.parent().unwrap().to_string_lossy().into(),
            FramePolicy::default(),
            None,
        )
    }
}
impl Drop for AppFixture {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
    }
}

#[test]
fn recorded_worktree_fills_missing_launch_team_before_remote_or_layout() {
    use crate::install::worktree_index::{self, ContextWorktreeRecord};
    let f = Fixture::new();
    let root = f.temp.path().join("retained");
    let cwd = root.join("child/content");
    std::fs::create_dir_all(&cwd).unwrap();
    let principal = Principal::from(1u64);
    worktree_index::write_context_record(
        &f.home,
        &principal,
        &ContextWorktreeRecord {
            owner: None,
            extras: Default::default(),
            schema_version: worktree_index::SCHEMA_VERSION,
            kind: "context".into(),
            id: "retained-child".into(),
            org: "acme/ctx".into(),
            team: "child".into(),
            name: "Retained".into(),
            branch: "work/child".into(),
            base_sha: "0".repeat(40),
            root,
            launch_cwd: cwd.clone(),
            created_at: 1,
            last_used_at: 1,
        },
    )
    .unwrap();
    let recorded = workspace_team(&f.home, &principal, &cwd).unwrap();
    assert_eq!(recorded.team, "child");
    let scope = CallerScope::team(&f.home, &principal, &recorded);
    assert_eq!(
        scope.existing(&f.path("parent", "content/secret.md")),
        scope.existing(&f.path("parent", "content/missing.md"))
    );
    assert!(scope
        .existing(&f.path("parent", "content/shared.md"))
        .is_ok());
}
#[test]
fn caller_admission_hides_ancestors_but_preserves_other_teams() {
    let (temp, root) = inheritance::test_fixture();
    let scope = CallerScope::Team(inheritance::team_view(&root, "acme/ctx", "child"));
    assert_eq!(
        scope.existing(&root.join("parent/content/secret.md")),
        scope.existing(&root.join("parent/content/missing.md"))
    );
    assert!(scope
        .existing(&root.join("parent/content/shared.md"))
        .is_ok());
    assert!(scope
        .existing(&root.join("sibling/content/secret.md"))
        .is_ok());
    assert!(CallerScope::Human
        .existing(&root.join("parent/content/secret.md"))
        .is_ok());
    assert_eq!(
        CallerScope::Unknown.existing(&root.join("child/content/secret.md")),
        Err(MISSING.into())
    );
    let (space, _) = crate::context_repo::scratch_space::ensure_org_space(
        temp.path(),
        &Principal::from(1u64),
        "acme/ctx",
    )
    .unwrap();
    let private = space.content_dir().join("private.md");
    std::fs::create_dir_all(private.parent().unwrap()).unwrap();
    std::fs::write(&private, "private").unwrap();
    assert!(CallerScope::Unknown.existing(&private).is_ok());
}

#[test]
fn a_team_caller_cannot_see_another_orgs_team_content() {
    let f = Fixture::new();
    let other = f.other_org();
    let missing = other.team_file.with_file_name("missing.md");
    assert_eq!(f.team_view().admits_path(&other.team_file), Admit::Denied);
    assert_eq!(
        f.scope.existing(&other.team_file),
        f.scope.existing(&missing)
    );
    assert_eq!(
        f.scope.read_admitted(&other.team_file),
        f.scope.read_admitted(&missing)
    );
    assert!(!f.scope.visible(other.team_file.parent().unwrap()));
    assert!(CallerScope::Human.existing(&other.team_file).is_ok());
}
#[test]
fn a_team_caller_cannot_see_another_orgs_private_space() {
    let f = Fixture::new();
    let other = f.other_org();
    let missing = other.private_file.with_file_name("missing.md");
    assert_eq!(
        f.team_view().admits_path(&other.private_file),
        Admit::Denied
    );
    assert_eq!(
        f.scope.existing(&other.private_file),
        f.scope.existing(&missing)
    );
    assert_eq!(
        f.scope.read_admitted(&other.private_file),
        f.scope.read_admitted(&missing)
    );
    assert!(f.scope.existing(&other.private_root).is_err());
    assert!(CallerScope::Human.existing(&other.private_file).is_ok());
}
#[test]
fn a_team_caller_still_reads_the_placed_docs() {
    let f = Fixture::new();
    let other = f.other_org();
    assert_ne!(f.team_view().admits_path(&other.docs_file), Admit::Denied);
    assert_eq!(
        f.scope.read_admitted(&other.docs_file).unwrap(),
        "docs-guide-bytes"
    );
}
#[test]
fn docs_look_alikes_read_as_missing_to_a_team_caller() {
    let f = Fixture::new();
    let other = f.other_org();
    for file in &other.look_alikes {
        let missing = file.with_file_name("missing.md");
        assert_eq!(f.team_view().admits_path(file), Admit::Denied, "{file:?}");
        assert_eq!(
            f.scope.existing(file),
            f.scope.existing(&missing),
            "{file:?}"
        );
    }
}
#[test]
fn a_team_caller_keeps_its_own_private_space_and_profile_files() {
    let f = Fixture::new();
    let other = f.other_org();
    let principal = Principal::from(1u64);
    let (space, _) =
        crate::context_repo::scratch_space::ensure_org_space(&f.home, &principal, "acme/ctx")
            .unwrap();
    let own = write_file(&space.content_dir().join("own.md"), "own");
    let all_orgs = write_file(
        &crate::context_repo::scratch_space::scratch_all_orgs_root(&f.home, &principal)
            .join("everywhere.md"),
        "everywhere",
    );
    let profile = write_file(&f.home.join("users/1/profile-notes.md"), "profile");
    let view = f.team_view();
    for file in [&own, &all_orgs, &profile] {
        assert_eq!(view.admits_path(file), Admit::Private, "{file:?}");
        assert!(f.scope.existing(file).is_ok(), "{file:?}");
    }
    assert_eq!(
        view.admits_path(&f.path("sibling", "content/secret.md")),
        Admit::OtherTeam
    );
    // An unplaced caller is unchanged: private space yes, any team's layer no.
    assert!(CallerScope::Unknown.existing(&other.private_file).is_ok());
    assert_eq!(
        CallerScope::Unknown.existing(&other.team_file),
        Err(MISSING.into())
    );
    let mut memo = inheritance::ScopeMemo::for_index_rows();
    assert!(memo.unknown_caller_admits_real(&other.private_file));
    assert!(!memo.unknown_caller_admits_real(&other.team_file));
}
