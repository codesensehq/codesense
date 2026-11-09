// SPDX-License-Identifier: MIT
use std::sync::atomic::{AtomicUsize, Ordering};

use tempfile::TempDir;

use super::*;

const UID: u64 = 7;
const ORG: &str = "acme/widgets";

const PEOPLE_YML: &str = "people:\n  - github_user_id: 1\n    github_username: member\n";
/// `backend` is synced (its content folder exists), `frontend` is listed but not synced.
const TEAMS_YML: &str = "teams:\n  - name: backend\n  - name: frontend\n";

fn org_root(home: &Path) -> PathBuf {
    crate::context_repo::path_to_org_root(home, &Principal::from(UID), ORG).unwrap()
}

fn content_dir(home: &Path, team: &str) -> PathBuf {
    crate::context_repo::path_to_team_content_dir(&org_root(home), team)
}

/// A cloned org with the registry above and `backend`'s content folder.
fn home_with_org() -> TempDir {
    let home = TempDir::new().unwrap();
    let root = org_root(home.path());
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("org.yml"),
        format!("slug: {ORG}\ndisplay_name: Test Org\ncreated_at: \"2026-01-01T00:00:00Z\"\n"),
    )
    .unwrap();
    std::fs::write(root.join("people.yml"), PEOPLE_YML).unwrap();
    std::fs::write(root.join("teams.yml"), TEAMS_YML).unwrap();
    std::fs::create_dir_all(content_dir(home.path(), "backend")).unwrap();
    home
}

fn write_teams(home: &Path, teams_yml: &str) {
    std::fs::write(org_root(home).join("teams.yml"), teams_yml).unwrap();
}

/// The real disk, counting every stamp and every registry read. Each fill runs
/// exactly one blocking-pool task, which stamps once, so `stamps` also counts the
/// blocking tasks this cache ran.
#[derive(Default)]
struct CountingDisk {
    stamps: AtomicUsize,
    resolves: AtomicUsize,
    /// Run during the registry read, to land an invalidation mid-fill.
    during_resolve: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl CountingDisk {
    fn counts(&self) -> (usize, usize) {
        (
            self.stamps.load(Ordering::SeqCst),
            self.resolves.load(Ordering::SeqCst),
        )
    }
}

impl Disk for CountingDisk {
    fn stamp(&self, home: &Path, user_id: u64, org: &str, team: &str) -> Stamp {
        self.stamps.fetch_add(1, Ordering::SeqCst);
        LocalDisk.stamp(home, user_id, org, team)
    }
    fn resolve(&self, home: &Path, user_id: u64, org: &str, team: &str) -> ContextResolution {
        self.resolves.fetch_add(1, Ordering::SeqCst);
        if let Some(during) = self.during_resolve.lock().unwrap().as_ref() {
            during();
        }
        LocalDisk.resolve(home, user_id, org, team)
    }
}

/// A clock that moves only when told.
#[derive(Clone)]
struct ManualClock(Arc<Mutex<Instant>>);

impl ManualClock {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Instant::now())))
    }
    fn advance(&self, by: Duration) {
        *self.0.lock().unwrap() += by;
    }
    fn clock(&self) -> Clock {
        let now = self.0.clone();
        Arc::new(move || *now.lock().unwrap())
    }
}

struct Fixture {
    home: TempDir,
    disk: Arc<CountingDisk>,
    clock: ManualClock,
    cache: TeamResolutionCache,
}

impl Fixture {
    fn new() -> Self {
        let disk = Arc::new(CountingDisk::default());
        let clock = ManualClock::new();
        let cache = TeamResolutionCache::with(disk.clone(), clock.clock());
        Self {
            home: home_with_org(),
            disk,
            clock,
            cache,
        }
    }

    async fn resolve(&self, team: &str) -> ContextResolution {
        self.resolve_as(UID, team).await
    }

    async fn resolve_as(&self, user_id: u64, team: &str) -> ContextResolution {
        self.cache
            .resolve(self.home.path().to_path_buf(), user_id, ORG, team)
            .await
            .unwrap()
    }

    fn counts(&self) -> (usize, usize) {
        self.disk.counts()
    }

    fn home(&self) -> &Path {
        self.home.path()
    }
}

fn is_ok(resolution: &ContextResolution, team: &str) -> bool {
    matches!(resolution, ContextResolution::Ok(ctx) if ctx.team_name.as_deref() == Some(team))
}

#[tokio::test]
async fn a_hit_runs_no_blocking_task_and_reads_nothing() {
    let f = Fixture::new();
    assert!(is_ok(&f.resolve("backend").await, "backend"));
    assert_eq!(f.counts(), (1, 1), "a miss fills once");

    for _ in 0..5 {
        assert!(is_ok(&f.resolve("backend").await, "backend"));
    }
    assert_eq!(f.counts(), (1, 1), "hits stamp nothing and read nothing");
}

#[tokio::test]
async fn editing_teams_yml_changes_the_answer_after_an_invalidation() {
    let f = Fixture::new();
    assert!(is_ok(&f.resolve("backend").await, "backend"));

    write_teams(f.home(), "teams:\n  - name: frontend\n");
    f.cache.invalidate();

    assert!(matches!(
        f.resolve("backend").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(f.counts(), (2, 2));
}

#[tokio::test]
async fn removing_the_content_dir_changes_the_answer_after_an_invalidation() {
    let f = Fixture::new();
    assert!(is_ok(&f.resolve("backend").await, "backend"));

    std::fs::remove_dir_all(content_dir(f.home(), "backend")).unwrap();
    f.cache.invalidate();

    assert!(matches!(
        f.resolve("backend").await,
        ContextResolution::NotSynced
    ));
}

#[tokio::test]
async fn a_cached_not_synced_is_kept_and_turns_ok_once_the_dir_exists() {
    let f = Fixture::new();
    for _ in 0..2 {
        assert!(matches!(
            f.resolve("frontend").await,
            ContextResolution::NotSynced
        ));
    }
    assert_eq!(f.counts(), (1, 1), "NotSynced is cached like Ok");

    std::fs::create_dir_all(content_dir(f.home(), "frontend")).unwrap();
    f.cache.invalidate();

    assert!(is_ok(&f.resolve("frontend").await, "frontend"));
}

#[tokio::test]
async fn unauthorized_is_cached_and_invalidated_the_same_way() {
    let f = Fixture::new();
    for _ in 0..2 {
        assert!(matches!(
            f.resolve("design").await,
            ContextResolution::Unauthorized
        ));
    }
    assert_eq!(f.counts(), (1, 1), "Unauthorized is cached like Ok");

    write_teams(f.home(), &format!("{TEAMS_YML}  - name: design\n"));
    std::fs::create_dir_all(content_dir(f.home(), "design")).unwrap();
    f.cache.invalidate();

    assert!(is_ok(&f.resolve("design").await, "design"));
}

#[tokio::test]
async fn an_unreported_teams_yml_edit_shows_once_the_backstop_passes() {
    let f = Fixture::new();
    assert!(is_ok(&f.resolve("backend").await, "backend"));

    // A hand edit no event reports: inside the backstop the entry still answers.
    write_teams(f.home(), "teams:\n  - name: frontend\n");
    f.clock.advance(MAX_AGE - Duration::from_millis(1));
    assert!(is_ok(&f.resolve("backend").await, "backend"));
    assert_eq!(f.counts(), (1, 1), "still a hit, with no I/O");

    f.clock.advance(Duration::from_millis(1));
    assert!(matches!(
        f.resolve("backend").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(f.counts(), (2, 2), "one stamp, and a read because it moved");
}

#[tokio::test]
async fn an_expired_entry_rereads_the_registry_only_when_its_stamp_moved() {
    let f = Fixture::new();
    assert!(matches!(
        f.resolve("frontend").await,
        ContextResolution::NotSynced
    ));

    // Nothing moved: re-stamped, not re-read.
    f.clock.advance(MAX_AGE);
    assert!(matches!(
        f.resolve("frontend").await,
        ContextResolution::NotSynced
    ));
    assert_eq!(f.counts(), (2, 1));

    // A folder made with no event moves the stamp, so the registry is read again.
    std::fs::create_dir_all(content_dir(f.home(), "frontend")).unwrap();
    f.clock.advance(MAX_AGE);
    assert!(is_ok(&f.resolve("frontend").await, "frontend"));
    assert_eq!(f.counts(), (3, 2));
}

#[tokio::test]
async fn an_unreported_people_yml_break_shows_once_the_backstop_passes() {
    let f = Fixture::new();
    assert!(is_ok(&f.resolve("backend").await, "backend"));

    std::fs::write(org_root(f.home()).join("people.yml"), "people: [unclosed\n").unwrap();
    f.clock.advance(MAX_AGE);
    assert!(matches!(
        f.resolve("backend").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(f.counts(), (2, 2));
}

#[tokio::test]
async fn an_expired_unauthorized_is_read_again_even_on_an_unchanged_stamp() {
    // A registry read that failed for a passing reason also reads Unauthorized, so it
    // isn't kept just because the files look the same.
    let f = Fixture::new();
    assert!(matches!(
        f.resolve("design").await,
        ContextResolution::Unauthorized
    ));
    f.clock.advance(MAX_AGE);
    assert!(matches!(
        f.resolve("design").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(f.counts(), (2, 2));
}

#[tokio::test]
async fn an_invalidation_during_a_fill_keeps_its_answer_out_of_the_cache() {
    let f = Fixture::new();
    let racing = f.cache.clone();
    *f.disk.during_resolve.lock().unwrap() = Some(Box::new(move || racing.invalidate()));

    assert!(
        is_ok(&f.resolve("backend").await, "backend"),
        "the racing fill still answers"
    );
    *f.disk.during_resolve.lock().unwrap() = None;

    assert!(is_ok(&f.resolve("backend").await, "backend"));
    assert_eq!(f.counts(), (2, 2), "the raced answer wasn't kept");
}

#[tokio::test]
async fn entries_are_kept_per_principal_and_team() {
    let f = Fixture::new();
    f.resolve("backend").await;
    f.resolve("frontend").await;
    // The other principal has no clone of the org.
    assert!(matches!(
        f.resolve_as(UID + 1, "backend").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(f.counts(), (3, 3));
}

#[tokio::test]
async fn a_full_map_drops_its_expired_entries() {
    let f = Fixture::new();
    for i in 0..PRUNE_ABOVE {
        f.resolve(&format!("ghost-{i}")).await;
    }
    assert_eq!(f.cache.lock().entries.len(), PRUNE_ABOVE);

    f.clock.advance(MAX_AGE);
    f.resolve("backend").await;
    assert_eq!(
        f.cache.lock().entries.len(),
        1,
        "only the new entry is left"
    );
}

fn mock_app(f: &Fixture) -> tauri::App<tauri::test::MockRuntime> {
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    app.manage(crate::commands::local_profile::LocalProfileState::for_test(
        f.home(),
        UID,
        crate::commands::local_profile::MachineOwner::LegacyGithub { id: UID },
    ));
    app.manage(f.cache.clone());
    app
}

/// The inbox host's `team_store` and `role_configs` read through the managed cache:
/// the second read of a team is a hit, and every answer matches an uncached resolve.
#[tokio::test]
async fn the_inbox_host_reads_through_the_cache() {
    use crate::commands::agent_inbox::{app_role_configs, app_team_store, team_store_path};
    use crate::commands::dashboard_launch::LaunchTeam;

    // The counted disk reads the fixture's home whatever home the app reports.
    struct FixtureHome(Arc<CountingDisk>, PathBuf);
    impl Disk for FixtureHome {
        fn stamp(&self, _: &Path, user_id: u64, org: &str, team: &str) -> Stamp {
            self.0.stamp(&self.1, user_id, org, team)
        }
        fn resolve(&self, _: &Path, user_id: u64, org: &str, team: &str) -> ContextResolution {
            self.0.resolve(&self.1, user_id, org, team)
        }
    }
    let mut f = Fixture::new();
    f.cache = TeamResolutionCache::with(
        Arc::new(FixtureHome(f.disk.clone(), f.home().to_path_buf())),
        f.clock.clock(),
    );
    let app = mock_app(&f);

    for (i, name) in ["backend", "frontend", "design"].into_iter().enumerate() {
        let team = LaunchTeam {
            org: ORG.into(),
            team: name.into(),
        };
        let uncached = team_store_path(
            resolve_local(f.home().to_path_buf(), UID, ORG.into(), name.into()),
            &team,
        );
        assert_eq!(
            app_team_store(app.handle(), &team).await,
            uncached,
            "{name}"
        );
        assert_eq!(f.counts(), (i + 1, i + 1), "{name}: one fill");
        assert_eq!(
            app_team_store(app.handle(), &team).await,
            uncached,
            "{name}"
        );
        let _ = app_role_configs(app.handle(), &team, &Default::default()).await;
        assert_eq!(f.counts(), (i + 1, i + 1), "{name}: later reads are hits");
    }
}

#[tokio::test]
async fn each_invalidating_event_drops_the_entries() {
    use tauri::Emitter;
    let f = Fixture::new();
    let app = mock_app(&f);
    listen(app.handle());

    for (i, event) in INVALIDATING_EVENTS.iter().enumerate() {
        f.resolve("backend").await;
        assert_eq!(f.counts(), (i + 1, i + 1), "{event}: filled once");
        app.emit(event, ()).unwrap();
        f.resolve("backend").await;
        assert_eq!(f.counts(), (i + 2, i + 2), "{event}: dropped the entry");
    }
}
