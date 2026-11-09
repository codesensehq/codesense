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
#[derive(Clone, Default)]
struct Counts {
    stamps: Arc<AtomicUsize>,
    resolves: Arc<AtomicUsize>,
}

impl Counts {
    fn get(&self) -> (usize, usize) {
        (
            self.stamps.load(Ordering::SeqCst),
            self.resolves.load(Ordering::SeqCst),
        )
    }
}

struct CountingDisk {
    disk: LocalDisk,
    counts: Counts,
    /// Run during the registry read, to land an invalidation mid-fill.
    during_resolve: Option<Box<dyn Fn() + Send>>,
}

impl Disk for CountingDisk {
    fn stamp(&self, user_id: u64, org: &str, team: &str) -> Stamp {
        self.counts.stamps.fetch_add(1, Ordering::SeqCst);
        self.disk.stamp(user_id, org, team)
    }
    fn resolve(&self, user_id: u64, org: &str, team: &str) -> ContextResolution {
        self.counts.resolves.fetch_add(1, Ordering::SeqCst);
        if let Some(during) = &self.during_resolve {
            during();
        }
        self.disk.resolve(user_id, org, team)
    }
}

fn disk(home: &TempDir, counts: &Counts) -> CountingDisk {
    CountingDisk {
        disk: LocalDisk {
            home: home.path().to_path_buf(),
        },
        counts: counts.clone(),
        during_resolve: None,
    }
}

async fn resolve(
    cache: &TeamResolutionCache,
    home: &TempDir,
    counts: &Counts,
    team: &str,
) -> ContextResolution {
    cache
        .resolve(disk(home, counts), UID, ORG, team)
        .await
        .unwrap()
}

fn is_ok(resolution: &ContextResolution, team: &str) -> bool {
    matches!(resolution, ContextResolution::Ok(ctx) if ctx.team_name.as_deref() == Some(team))
}

#[tokio::test]
async fn a_hit_runs_no_blocking_task_and_reads_nothing() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();

    assert!(is_ok(
        &resolve(&cache, &home, &counts, "backend").await,
        "backend"
    ));
    assert_eq!(counts.get(), (1, 1), "a miss fills once");

    for _ in 0..5 {
        assert!(is_ok(
            &resolve(&cache, &home, &counts, "backend").await,
            "backend"
        ));
    }
    assert_eq!(counts.get(), (1, 1), "hits stamp nothing and read nothing");
}

#[tokio::test]
async fn editing_teams_yml_changes_the_answer_after_an_invalidation() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();
    assert!(is_ok(
        &resolve(&cache, &home, &counts, "backend").await,
        "backend"
    ));

    write_teams(home.path(), "teams:\n  - name: frontend\n");
    cache.invalidate();

    assert!(matches!(
        resolve(&cache, &home, &counts, "backend").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(counts.get(), (2, 2));
}

#[tokio::test]
async fn removing_the_content_dir_changes_the_answer_after_an_invalidation() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();
    assert!(is_ok(
        &resolve(&cache, &home, &counts, "backend").await,
        "backend"
    ));

    std::fs::remove_dir_all(content_dir(home.path(), "backend")).unwrap();
    cache.invalidate();

    assert!(matches!(
        resolve(&cache, &home, &counts, "backend").await,
        ContextResolution::NotSynced
    ));
}

#[tokio::test]
async fn a_cached_not_synced_is_kept_and_turns_ok_once_the_dir_exists() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();
    assert!(matches!(
        resolve(&cache, &home, &counts, "frontend").await,
        ContextResolution::NotSynced
    ));
    assert!(matches!(
        resolve(&cache, &home, &counts, "frontend").await,
        ContextResolution::NotSynced
    ));
    assert_eq!(counts.get(), (1, 1), "NotSynced is cached like Ok");

    std::fs::create_dir_all(content_dir(home.path(), "frontend")).unwrap();
    cache.invalidate();

    assert!(is_ok(
        &resolve(&cache, &home, &counts, "frontend").await,
        "frontend"
    ));
}

#[tokio::test]
async fn unauthorized_is_cached_and_invalidated_the_same_way() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();
    for _ in 0..2 {
        assert!(matches!(
            resolve(&cache, &home, &counts, "design").await,
            ContextResolution::Unauthorized
        ));
    }
    assert_eq!(counts.get(), (1, 1), "Unauthorized is cached like Ok");

    write_teams(home.path(), &format!("{TEAMS_YML}  - name: design\n"));
    std::fs::create_dir_all(content_dir(home.path(), "design")).unwrap();
    cache.invalidate();

    assert!(is_ok(
        &resolve(&cache, &home, &counts, "design").await,
        "design"
    ));
}

#[tokio::test]
async fn an_expired_entry_rereads_the_registry_only_when_its_stamp_moved() {
    let home = home_with_org();
    let cache = TeamResolutionCache::with_max_age(Duration::ZERO);
    let counts = Counts::default();
    assert!(matches!(
        resolve(&cache, &home, &counts, "frontend").await,
        ContextResolution::NotSynced
    ));

    // Nothing moved: re-stamped, not re-read.
    assert!(matches!(
        resolve(&cache, &home, &counts, "frontend").await,
        ContextResolution::NotSynced
    ));
    assert_eq!(counts.get(), (2, 1));

    // A folder made with no event: the stamp moved, so the registry is read again.
    std::fs::create_dir_all(content_dir(home.path(), "frontend")).unwrap();
    assert!(is_ok(
        &resolve(&cache, &home, &counts, "frontend").await,
        "frontend"
    ));
    assert_eq!(counts.get(), (3, 2));

    // A registry edit with no event moves the stamp too.
    write_teams(home.path(), "teams:\n  - name: backend\n");
    assert!(matches!(
        resolve(&cache, &home, &counts, "frontend").await,
        ContextResolution::Unauthorized
    ));
    assert_eq!(counts.get(), (4, 3));
}

#[tokio::test]
async fn an_invalidation_during_a_fill_keeps_its_answer_out_of_the_cache() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();
    let racing = cache.clone();
    let mut racing_disk = disk(&home, &counts);
    racing_disk.during_resolve = Some(Box::new(move || racing.invalidate()));

    let first = cache
        .resolve(racing_disk, UID, ORG, "backend")
        .await
        .unwrap();
    assert!(is_ok(&first, "backend"), "the racing fill still answers");

    assert!(is_ok(
        &resolve(&cache, &home, &counts, "backend").await,
        "backend"
    ));
    assert_eq!(counts.get(), (2, 2), "the raced answer wasn't kept");
}

#[tokio::test]
async fn entries_are_kept_per_principal_and_team() {
    let home = home_with_org();
    let cache = TeamResolutionCache::default();
    let counts = Counts::default();
    resolve(&cache, &home, &counts, "backend").await;
    resolve(&cache, &home, &counts, "frontend").await;
    let other = cache
        .resolve(disk(&home, &counts), UID + 1, ORG, "backend")
        .await
        .unwrap();
    // The other principal has no clone of the org.
    assert!(matches!(other, ContextResolution::Unauthorized));
    assert_eq!(counts.get(), (3, 3));
}

#[tokio::test]
async fn each_invalidating_event_drops_the_entries() {
    use tauri::{Emitter, Manager};
    let home = home_with_org();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let cache = TeamResolutionCache::default();
    app.manage(cache.clone());
    listen(app.handle());
    let counts = Counts::default();

    for (i, event) in INVALIDATING_EVENTS.iter().enumerate() {
        resolve(&cache, &home, &counts, "backend").await;
        assert_eq!(counts.get(), (i + 1, i + 1), "{event}: filled once");
        app.emit(event, ()).unwrap();
        resolve(&cache, &home, &counts, "backend").await;
        assert_eq!(counts.get(), (i + 2, i + 2), "{event}: dropped the entry");
    }
}
