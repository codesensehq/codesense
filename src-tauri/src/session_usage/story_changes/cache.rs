// SPDX-License-Identifier: MIT
//! SV-ENG-121: the git half of a hosted story read, kept per story until origin's head or a
//! branch tip of the repos it read moves. A retry of a read that outlived the answer timeout
//! (the walk finishes on its own) is then an index read, not a second walk.
use super::*;

/// The longest a kept half is trusted: the worktree facts and session links in it have no ref or
/// file to watch.
/// It is also how long a new note on a kept commit may go unread: the stamp watches
/// origin's head and the story's branch tips, never the notes refs, so a note git-ai writes after
/// the read that kept the half shows on the first read after a tip moves or within this bound.
const KEPT_FOR: std::time::Duration = std::time::Duration::from_secs(300);
/// The most stories kept at once; the oldest goes first.
const KEPT_STORIES: usize = 16;
/// The most task walks kept at once, apart from the read halves: a task list over many stories
/// does not push out the halves the story pages and record lines read.
const KEPT_WALKS: usize = 32;

struct Kept {
    at: std::time::Instant,
    used: std::time::Instant,
    stamp: String,
    git: git::GitFacts,
    planned: planned::PlannedFacts,
    part: GitTotals,
}

/// The kept halves by key, and how many it holds (tests keep their own).
struct Store(std::sync::Mutex<std::collections::BTreeMap<String, Kept>>, usize);

static KEPT: Store = Store::new();
static WALKS: Store = Store::keeping(KEPT_WALKS);

impl Store {
    const fn new() -> Self {
        Store::keeping(KEPT_STORIES)
    }

    const fn keeping(most: usize) -> Self {
        Store(std::sync::Mutex::new(std::collections::BTreeMap::new()), most)
    }
}

/// What the git half was read from: the home, the story, who asked and the sessions' links.
pub(super) fn key(
    home: &Path,
    story: &str,
    scope: &CallerScope,
    refs: &[git::SessionRef],
    sessions: &str,
) -> String {
    format!(
        "{}\n{}\n{:?}\n{:?}\n{}",
        std::path::Path::display(home),
        str::to_ascii_uppercase(story),
        scope,
        refs,
        sessions
    )
}

/// What a kept half was stamped from: the story, per repo the branch names its walk read, and
/// the story files its planned and done facts were read from.
#[derive(Debug, Clone, Default)]
pub struct StampSpec {
    pub story: String,
    pub repos: Vec<(std::path::PathBuf, BTreeSet<String>)>,
    pub files: Vec<std::path::PathBuf>,
}

/// Origin's default head, the names of the story's branches now, and the tips of those and of
/// `names`, the branches the walk read: a branch created or fetched later changes it too.
pub(super) fn repo_stamp(repo: &git2::Repository, story: &str, names: &BTreeSet<String>) -> String {
    let mut out = std::string::String::new();
    if let Some(oid) = crate::attribution::history::default_branch(repo) {
        String::push_str(&mut out, &format!("origin {oid}\n"));
    }
    let mut all = git::story_branch_names(repo, story);
    String::push_str(&mut out, &format!("branches {all:?}\n"));
    all.extend(names.iter().cloned());
    for name in &all {
        for prefix in ["refs/heads/", "refs/remotes/origin/"] {
            let tip = Option::and_then(
                Result::ok(git2::Repository::find_reference(
                    repo,
                    &format!("{prefix}{name}"),
                )),
                |found| git2::Reference::target(&found),
            );
            String::push_str(&mut out, &format!("{prefix}{name} {tip:?}\n"));
        }
    }
    // A deepen (refresh_history) moves only the shallow boundary, no tip.
    let shallow = Result::unwrap_or_default(std::fs::read_to_string(std::path::Path::join(
        git2::Repository::commondir(repo),
        "shallow",
    )));
    String::push_str(&mut out, &format!("shallow {shallow:?}\n"));
    out
}

/// [`repo_stamp`] of each repo of `spec`, and the size and content hash of each story file (a
/// small file; an edit within the filesystem's timestamp granularity still changes it).
pub(super) fn stamp_of(spec: &StampSpec) -> String {
    let mut out = std::string::String::new();
    for file in &spec.files {
        let seen = Option::map(Result::ok(std::fs::read(file)), |bytes| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            std::hash::Hash::hash(&bytes, &mut hasher);
            (
                std::vec::Vec::len(&bytes),
                std::hash::Hasher::finish(&hasher),
            )
        });
        String::push_str(
            &mut out,
            &format!("file {} {seen:?}\n", std::path::Path::display(file)),
        );
    }
    for (dir, names) in &spec.repos {
        let Ok(repo) = git2::Repository::open(dir) else {
            continue;
        };
        String::push_str(&mut out, &format!("{}\n", std::path::Path::display(dir)));
        String::push_str(&mut out, &repo_stamp(&repo, &spec.story, names));
    }
    out
}

/// The kept half for `key`, when it is young and no ref it read has moved.
pub(super) async fn get(key: &str) -> Option<(git::GitFacts, planned::PlannedFacts, GitTotals)> {
    KEPT.get_at(key, std::time::Instant::now()).await
}

/// What a story walk alone (no planned or totals half: a task's evidence) was read from: the
/// home, the story, the scopes it admits and the sessions' links. Never a read's [`key`].
pub(super) fn walk_key(home: &Path, story: &str, scopes: &[CallerScope], refs: &[git::SessionRef]) -> String {
    format!(
        "walk\n{}\n{}\n{:?}\n{:?}",
        std::path::Path::display(home),
        str::to_ascii_uppercase(story),
        scopes,
        refs
    )
}

/// [`get`] for a caller already off the async runtime, of a walk kept by [`put_walk`].
pub(super) fn get_walk(key: &str) -> Option<git::GitFacts> {
    let (spec, kept_stamp) = Store::fresh(&WALKS, key, std::time::Instant::now())?;
    if stamp_of(&spec) != kept_stamp {
        return None;
    }
    Option::map(Store::renew(&WALKS, key, std::time::Instant::now()), |(git, _, _)| git)
}

/// [`put`] for a caller already off the async runtime: keeps a story walk alone.
pub(super) fn put_walk(key: String, git: &git::GitFacts) {
    let seen = stamp_of(&git.stamp_spec);
    Store::insert(&WALKS, key, seen, git, &Default::default(), &Default::default(), std::time::Instant::now());
}

/// Keep a half just read for `key`, unless a ref it read moved while the walk ran (`git.refs_stamp`
/// was taken before the walk): that answer is served, not kept.
pub(super) async fn put(
    key: String,
    git: &git::GitFacts,
    planned: &planned::PlannedFacts,
    part: &GitTotals,
) {
    KEPT.put_at(key, git, planned, part, std::time::Instant::now())
        .await;
}

/// Forget every half and walk kept for `home`: a test that changes what a half was read from
/// without moving a ref it watches (a session mapped later shows within [`KEPT_FOR`]).
#[cfg(test)]
pub(super) fn forget_home(home: &Path) {
    let home = format!("{}\n", std::path::Path::display(home));
    for store in [&KEPT, &WALKS] {
        let mut kept = store.0.lock().unwrap();
        kept.retain(|key, _| !key.starts_with(&home) && !key.starts_with(&format!("walk\n{home}")));
    }
}

impl Store {
    async fn get_at(
        &self,
        key: &str,
        now: std::time::Instant,
    ) -> Option<(git::GitFacts, planned::PlannedFacts, GitTotals)> {
        let (spec, kept_stamp) = self.fresh(key, now)?;
        let seen = Result::ok(
            crate::commands::await_blocking("story_changes.cache", move || Ok(stamp_of(&spec)))
                .await,
        )?;
        if seen != kept_stamp {
            return None;
        }
        self.renew(key, now)
    }

    /// The stamp spec and stamp of `key`'s half while it is young enough to trust.
    fn fresh(&self, key: &str, now: std::time::Instant) -> Option<(StampSpec, String)> {
        let kept = Result::ok(self.0.lock())?;
        let entry = std::collections::BTreeMap::get(&kept, key)?;
        if std::time::Instant::saturating_duration_since(&now, entry.at) > KEPT_FOR {
            return None;
        }
        Some((entry.git.stamp_spec.clone(), entry.stamp.clone()))
    }

    /// `key`'s half, marked used at `now`.
    fn renew(
        &self,
        key: &str,
        now: std::time::Instant,
    ) -> Option<(git::GitFacts, planned::PlannedFacts, GitTotals)> {
        let mut kept = Result::ok(self.0.lock())?;
        let entry = std::collections::BTreeMap::get_mut(&mut kept, key)?;
        entry.used = now;
        Some((entry.git.clone(), entry.planned.clone(), entry.part.clone()))
    }

    async fn put_at(
        &self,
        key: String,
        git: &git::GitFacts,
        planned: &planned::PlannedFacts,
        part: &GitTotals,
        now: std::time::Instant,
    ) {
        let spec = git.stamp_spec.clone();
        let Ok(seen) =
            crate::commands::await_blocking("story_changes.cache", move || Ok(stamp_of(&spec)))
                .await
        else {
            return;
        };
        self.insert(key, seen, git, planned, part, now);
    }

    /// Keep a half whose refs read `seen` now, unless they moved since the walk began.
    fn insert(
        &self,
        key: String,
        seen: String,
        git: &git::GitFacts,
        planned: &planned::PlannedFacts,
        part: &GitTotals,
        now: std::time::Instant,
    ) {
        if seen != git.refs_stamp {
            return;
        }
        let Ok(mut kept) = self.0.lock() else {
            return;
        };
        if std::collections::BTreeMap::len(&kept) >= self.1
            && !std::collections::BTreeMap::contains_key(&kept, &key)
        {
            let oldest = Option::map(
                Iterator::min_by_key(std::collections::BTreeMap::iter(&kept), |(_, entry)| {
                    entry.used
                }),
                |(oldest, _)| String::clone(oldest),
            );
            if let Some(oldest) = oldest {
                std::collections::BTreeMap::remove(&mut kept, &oldest);
            }
        }
        std::collections::BTreeMap::insert(
            &mut kept,
            key,
            Kept {
                at: now,
                used: now,
                stamp: seen,
                git: git.clone(),
                planned: planned.clone(),
                part: part.clone(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn half(stamp: &str) -> (git::GitFacts, planned::PlannedFacts, GitTotals) {
        let git = git::GitFacts {
            refs_stamp: stamp.to_owned(),
            ..Default::default()
        };
        (git, Default::default(), Default::default())
    }

    #[tokio::test]
    async fn expiry_scope_and_a_mid_walk_ref_move() {
        let store = Store::new();
        let (git, planned, part) = half("");
        let base = std::time::Instant::now();
        store
            .put_at("t-expiry".into(), &git, &planned, &part, base)
            .await;
        assert!(store.get_at("t-expiry", base).await.is_some());
        assert!(store.get_at("t-expiry", base + KEPT_FOR).await.is_some());
        let late = base + KEPT_FOR + std::time::Duration::from_secs(1);
        assert!(
            store.get_at("t-expiry", late).await.is_none(),
            "a kept half is trusted for KEPT_FOR"
        );

        let home = Path::new("/home");
        let human = key(home, "SV-1", &CallerScope::Human, &[], "s");
        let unknown = key(home, "SV-1", &CallerScope::Unknown, &[], "s");
        assert_ne!(human, unknown, "another scope must not share a kept half");
        assert_eq!(human, key(home, "sv-1", &CallerScope::Human, &[], "s"));

        // The refs moved while the walk ran: the stamp taken at its start no longer matches.
        let (moved, planned, part) = half("origin before the walk");
        store
            .put_at("t-moved".into(), &moved, &planned, &part, base)
            .await;
        assert!(
            store.get_at("t-moved", base).await.is_none(),
            "a half read across a ref move was kept"
        );
    }

    #[tokio::test]
    async fn the_least_recently_used_half_goes_first() {
        let store = Store::new();
        let (git, planned, part) = half("");
        let base = std::time::Instant::now();
        let at = |n: u64| base + std::time::Duration::from_millis(n);
        for n in 0..KEPT_STORIES {
            store
                .put_at(format!("t-lru-{n:02}"), &git, &planned, &part, at(n as u64))
                .await;
        }
        // A hit renews the oldest, so the next oldest goes when one more is kept.
        assert!(store.get_at("t-lru-00", at(100)).await.is_some());
        store
            .put_at("t-lru-new".into(), &git, &planned, &part, at(101))
            .await;
        assert!(store.get_at("t-lru-00", at(102)).await.is_some());
        assert!(store.get_at("t-lru-01", at(102)).await.is_none());
        assert!(store.get_at("t-lru-new", at(102)).await.is_some());
    }
}
