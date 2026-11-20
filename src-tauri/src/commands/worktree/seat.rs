// SPDX-License-Identifier: MIT
//! Seat worktrees: a named session of a story launched into its own worktree beside the
//! story's base worktree (`open_workspace` `seatWorktree`). A `branch` seat is a writable
//! worktree on its own branch, cut from the story branch tip; a `commit` seat is a detached
//! checkout pinned to one commit.
//!
//! The git work here takes no app handle, so it runs against a temp repo in tests;
//! `mcp_workspace::ensure_seat_worktree` adds the record, setup and launch around it.

use std::path::{Path, PathBuf};

use crate::install::worktree_index::{SeatKind, SeatRecord};

/// What a seat launch asks for: `seatWorktree` on a story `open_workspace`. Read by the
/// hand-written [`Deserialize`](serde::Deserialize) below, which refuses an unknown key
/// (a `commit` on a branch seat, a misspelled `commit`) instead of ignoring it; the
/// `serde` attributes here shape only the JSON schema.
#[derive(Debug, Clone, PartialEq, Eq, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SeatWorktreeParam {
    /// A writable worktree on its own branch, `<story branch>-seat-<name>`, cut from the
    /// story branch tip. The repo's worktree.yaml setup runs there. A relaunch of the same
    /// name reuses it; an earlier seat branch of that name is fast-forwarded to the story
    /// branch tip when it has no commits of its own, else reused as it stands.
    Branch,
    /// A detached checkout pinned to `commit`. No setup runs, so it has no installed
    /// dependencies. A relaunch with another commit re-pins it when it is clean.
    Commit {
        /// The commit to pin: a sha, or a ref that names a commit.
        commit: String,
    },
}

impl<'de> serde::Deserialize<'de> for SeatWorktreeParam {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;

        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            kind: String,
            #[serde(default)]
            commit: Option<String>,
        }
        let raw = Raw::deserialize(deserializer)?;
        match (raw.kind.as_str(), raw.commit) {
            ("branch", None) => Ok(Self::Branch),
            ("branch", Some(_)) => Err(D::Error::custom(
                "seatWorktree: commit is only for kind \"commit\"",
            )),
            ("commit", Some(commit)) => Ok(Self::Commit { commit }),
            ("commit", None) => Err(D::Error::custom(
                "seatWorktree: kind \"commit\" needs a commit",
            )),
            (other, _) => Err(D::Error::custom(format!(
                "seatWorktree: unknown kind {other:?} (use branch or commit)"
            ))),
        }
    }
}

/// A story session launched into its own seat worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SeatLaunch {
    /// The handle's normalized name: the `<name>` of `<storyId>#<name>`.
    pub name: String,
    pub worktree: SeatWorktreeParam,
}

/// A seat worktree ready for its session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SeatOutcome {
    pub path: PathBuf,
    /// The seat as its story record carries it.
    pub seat: SeatRecord,
    /// Whether the worktree was created by this call (`false`: reused or re-pinned).
    pub created: bool,
}

/// Why a seat worktree was not prepared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SeatError {
    /// The request can't be used (an unknown commit, a dirty worktree to re-pin, a seat
    /// of the other kind under that name). Nothing was created or changed.
    Invalid(String),
    /// Git or the filesystem failed.
    Failed(String),
}

/// The branch a seat named `slug` of a story on `story_branch` works on. Its worktree
/// folder is the one `worktree_dir` renders for this branch name, for both kinds.
pub(crate) fn seat_branch_name(story_branch: &str, slug: &str) -> String {
    format!("{story_branch}-seat-{slug}")
}

/// The folder of the seat named `slug` of the story on `story_branch`: the one
/// `worktree_dir_template` renders for [`seat_branch_name`] beside `repo`, for both kinds.
pub(crate) fn seat_worktree_path(
    repo: &Path,
    story_branch: &str,
    slug: &str,
    worktree_dir_template: &str,
) -> Result<PathBuf, String> {
    super::render_worktree_dir(
        worktree_dir_template,
        repo,
        &seat_branch_name(story_branch, slug),
    )
}

/// Create or reuse the seat worktree named `slug` of the story on `story_branch` in
/// `repo` (the story's source clone), at [`seat_worktree_path`]. Blocking: it runs git.
pub(crate) fn seat_worktree_inner(
    repo: &Path,
    story_branch: &str,
    slug: &str,
    kind: &SeatWorktreeParam,
    worktree_dir_template: &str,
) -> Result<SeatOutcome, SeatError> {
    let branch = seat_branch_name(story_branch, slug);
    let path = seat_worktree_path(repo, story_branch, slug, worktree_dir_template)
        .map_err(SeatError::Failed)?;
    let path_text = path.to_string_lossy().into_owned();
    let listed =
        super::run_git(&["worktree", "list", "--porcelain"], repo).map_err(SeatError::Failed)?;
    let existing = super::parse_worktree_porcelain(&listed)
        .into_iter()
        .find(|entry| super::paths_equal(&entry.path, &path_text));
    if existing.is_some() && !path.is_dir() {
        return Err(SeatError::Failed(format!(
            "the seat worktree folder {path_text} is gone but git still lists it; run `git worktree prune` in {}, then retry",
            repo.display()
        )));
    }
    if existing.is_none() && path.exists() {
        return Err(SeatError::Failed(format!(
            "a folder already exists at {path_text} and is not a worktree of {}; remove it, then retry",
            repo.display()
        )));
    }
    match kind {
        SeatWorktreeParam::Branch => {
            if let Some(entry) = &existing {
                if entry.branch.as_deref() != Some(branch.as_str()) {
                    return Err(SeatError::Invalid(format!(
                        "seat {slug} already has a pinned checkout at {path_text}; launch it with a commit, or use another name"
                    )));
                }
            }
            // Cut from the story branch itself, never from the clone's HEAD.
            let start = format!("refs/heads/{story_branch}");
            if existing.is_none() {
                catch_up_seat_branch(repo, &branch, &start)?;
            }
            let opened = super::story_branch_worktree_inner(
                repo,
                &branch,
                &path_text,
                Some(start.as_str()),
                None,
            )
            .map_err(SeatError::Failed)?;
            if !super::paths_equal(&opened.worktree_path, &path_text) {
                return Err(SeatError::Invalid(format!(
                    "branch {branch} is already checked out at {}; close that checkout or use another name",
                    opened.worktree_path
                )));
            }
            Ok(SeatOutcome {
                path,
                seat: SeatRecord {
                    name: slug.to_string(),
                    kind: SeatKind::Branch,
                    pinned_commit: None,
                },
                created: existing.is_none(),
            })
        }
        SeatWorktreeParam::Commit { commit } => {
            let (sha, created) = match &existing {
                None => (create_pinned_checkout(repo, &path, commit)?, true),
                Some(entry) if entry.branch.is_some() => {
                    return Err(SeatError::Invalid(format!(
                        "seat {slug} already has a worktree on branch {branch} at {path_text}; launch it as a branch seat, or use another name"
                    )));
                }
                Some(entry) => {
                    let sha = resolve_commit(repo, commit)?;
                    if entry.head_sha != sha {
                        repin(&path, &sha)?;
                    }
                    (sha, false)
                }
            };
            Ok(SeatOutcome {
                path,
                seat: SeatRecord {
                    name: slug.to_string(),
                    kind: SeatKind::Commit,
                    pinned_commit: Some(sha),
                },
                created,
            })
        }
    }
}

/// The full sha `commit` names in `repo`, or `Invalid` when it names no commit there.
fn resolve_commit(repo: &Path, commit: &str) -> Result<String, SeatError> {
    let commit = commit.trim();
    let unknown = || SeatError::Invalid(format!("unknown commit {commit:?}"));
    if commit.is_empty() || commit.starts_with('-') {
        return Err(unknown());
    }
    let spec = format!("{commit}^{{commit}}");
    super::run_git(&["rev-parse", "--verify", "--quiet", &spec], repo)
        .map(|out| out.trim().to_string())
        .ok()
        .filter(|sha| !sha.is_empty())
        .ok_or_else(unknown)
}

/// Check out `commit` detached at `path`, a new linked worktree of `repo`. The commit
/// is resolved first, so an unknown one is refused before anything is created. No setup
/// runs here. Returns the pinned sha.
pub(crate) fn create_pinned_checkout(
    repo: &Path,
    path: &Path,
    commit: &str,
) -> Result<String, SeatError> {
    let sha = resolve_commit(repo, commit)?;
    let path_text = path.to_string_lossy();
    super::reject_unsafe_git_arg("worktree path", &path_text).map_err(SeatError::Invalid)?;
    super::ensure_parent_dir(path).map_err(SeatError::Failed)?;
    super::run_git(
        &["worktree", "add", "--detach", "--", &path_text, &sha],
        repo,
    )
    .map_err(SeatError::Failed)?;
    Ok(sha)
}

/// Before an earlier seat branch with no worktree is checked out again, move it to the
/// story branch tip (`story_ref`) when that only fast-forwards it: a seat branch with
/// commits of its own (not yet in the story branch) is kept as it stands. A seat branch
/// that doesn't exist locally is left to be cut from the story branch.
fn catch_up_seat_branch(repo: &Path, branch: &str, story_ref: &str) -> Result<(), SeatError> {
    let seat_ref = format!("refs/heads/{branch}");
    let tip = |reference: &str| {
        super::run_git(&["rev-parse", "--verify", "--quiet", reference], repo)
            .ok()
            .map(|out| out.trim().to_string())
    };
    let (Some(seat), Some(story)) = (tip(&seat_ref), tip(story_ref)) else {
        return Ok(());
    };
    let behind = seat != story
        && super::run_git(&["merge-base", "--is-ancestor", &seat, &story], repo).is_ok();
    if behind {
        super::run_git(&["update-ref", &seat_ref, &story, &seat], repo)
            .map_err(SeatError::Failed)?;
    }
    Ok(())
}

/// Move a commit seat to `sha`. A worktree with uncommitted changes, or one whose status
/// can't be read, is refused and left as it was.
fn repin(path: &Path, sha: &str) -> Result<(), SeatError> {
    if super::worktree_git_dirty_opt(path) != Some(false) {
        return Err(SeatError::Invalid(format!(
            "the seat worktree at {} has uncommitted changes, so it was not re-pinned to {sha}; it is unchanged",
            path.display()
        )));
    }
    super::run_git(&["checkout", "--quiet", "--detach", sha], path)
        .map(|_| ())
        .map_err(SeatError::Failed)
}

/// Whether preparing a seat runs the repo's worktree.yaml setup: a branch seat that was
/// just created, or whose recorded setup has not completed (`setup_complete` is its
/// record's, `None` with no record). A commit seat never does.
pub(crate) fn seat_needs_setup(
    kind: SeatKind,
    created: bool,
    setup_complete: Option<bool>,
) -> bool {
    kind == SeatKind::Branch && (created || setup_complete != Some(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit_file(repo: &Path, name: &str, body: &str) -> String {
        std::fs::write(repo.join(name), body).unwrap();
        git(repo, &["add", name]);
        git(repo, &["commit", "-qm", name]);
        git(repo, &["rev-parse", "HEAD"])
    }

    /// A clone on `main` with a story branch `feat/story` one commit ahead of it; the
    /// clone's HEAD stays on `main`, so a seat cut from HEAD would miss `story.txt`.
    struct Fixture {
        _tmp: tempfile::TempDir,
        repo: PathBuf,
        main: String,
        story_tip: String,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("app");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["-c", "init.defaultBranch=main", "init", "-q"]);
        git(&repo, &["config", "user.email", "test@example.test"]);
        git(&repo, &["config", "user.name", "Test"]);
        let main = commit_file(&repo, "README.md", "# app\n");
        git(&repo, &["switch", "-q", "-c", "feat/story"]);
        let story_tip = commit_file(&repo, "story.txt", "story work\n");
        git(&repo, &["switch", "-q", "main"]);
        Fixture {
            _tmp: tmp,
            repo,
            main,
            story_tip,
        }
    }

    const TEMPLATE: &str = "../{repo}-wt/{slug}";

    fn seat_path(f: &Fixture, slug: &str) -> PathBuf {
        super::super::render_worktree_dir(TEMPLATE, &f.repo, &seat_branch_name("feat/story", slug))
            .unwrap()
    }

    fn commit(sha: &str) -> SeatWorktreeParam {
        SeatWorktreeParam::Commit {
            commit: sha.to_string(),
        }
    }

    #[test]
    fn a_branch_seat_is_cut_from_the_story_branch_tip_on_its_own_branch() {
        let f = fixture();
        let slug = crate::commands::workspace_open::worker_slug("Worker 2").unwrap();
        let out = seat_worktree_inner(
            &f.repo,
            "feat/story",
            &slug,
            &SeatWorktreeParam::Branch,
            TEMPLATE,
        )
        .unwrap();
        assert_eq!(out.path, seat_path(&f, "worker-2"));
        assert!(out.path.ends_with("app-wt/feat-story-seat-worker-2"));
        assert!(out.created);
        assert_eq!(
            git(&out.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feat/story-seat-worker-2"
        );
        assert_eq!(git(&out.path, &["rev-parse", "HEAD"]), f.story_tip);
        assert_ne!(f.story_tip, f.main);
        assert!(out.path.join("story.txt").exists());
        assert_eq!(
            out.seat,
            SeatRecord {
                name: "worker-2".into(),
                kind: SeatKind::Branch,
                pinned_commit: None,
            }
        );
        // The clone and the story branch are untouched.
        assert_eq!(git(&f.repo, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(git(&f.repo, &["rev-parse", "feat/story"]), f.story_tip);
    }

    #[test]
    fn a_branch_seat_relaunch_reuses_its_worktree_and_keeps_its_work() {
        let f = fixture();
        let first = seat_worktree_inner(
            &f.repo,
            "feat/story",
            "dev",
            &SeatWorktreeParam::Branch,
            TEMPLATE,
        )
        .unwrap();
        let seat_commit = commit_file(&first.path, "seat.txt", "seat work\n");
        let again = seat_worktree_inner(
            &f.repo,
            "feat/story",
            "dev",
            &SeatWorktreeParam::Branch,
            TEMPLATE,
        )
        .unwrap();
        assert!(!again.created);
        assert_eq!(again.path, first.path);
        assert_eq!(git(&again.path, &["rev-parse", "HEAD"]), seat_commit);
    }

    #[test]
    fn an_earlier_seat_branch_catches_up_with_the_story_or_keeps_its_own_work() {
        let f = fixture();
        let launch = |slug: &str| {
            seat_worktree_inner(
                &f.repo,
                "feat/story",
                slug,
                &SeatWorktreeParam::Branch,
                TEMPLATE,
            )
            .unwrap()
        };
        let remove = |path: &Path| {
            git(&f.repo, &["worktree", "remove", path.to_str().unwrap()]);
        };
        // Two seats, removed by hand with their branches kept; one has a commit of its own.
        let plain = launch("dev");
        let busy = launch("dev-2");
        let own = commit_file(&busy.path, "seat.txt", "seat work\n");
        remove(&plain.path);
        remove(&busy.path);
        // The story moves on.
        let story = f.repo.parent().unwrap().join("story-wt");
        git(
            &f.repo,
            &[
                "worktree",
                "add",
                "-q",
                story.to_str().unwrap(),
                "feat/story",
            ],
        );
        let new_tip = commit_file(&story, "more.txt", "more story work\n");

        // No commits of its own: fast-forwarded to the new story tip.
        let again = launch("dev");
        assert!(again.created);
        assert_eq!(git(&again.path, &["rev-parse", "HEAD"]), new_tip);
        // Commits of its own: reused as it stands, its work kept.
        let kept = launch("dev-2");
        assert_eq!(git(&kept.path, &["rev-parse", "HEAD"]), own);
        assert!(kept.path.join("seat.txt").exists());
    }

    #[test]
    fn a_commit_seat_is_a_detached_checkout_at_the_commit_with_nothing_installed() {
        let f = fixture();
        let out = seat_worktree_inner(&f.repo, "feat/story", "review", &commit(&f.main), TEMPLATE)
            .unwrap();
        assert!(out.created);
        assert_eq!(out.path, seat_path(&f, "review"));
        assert_eq!(
            git(&out.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "HEAD"
        );
        assert_eq!(git(&out.path, &["rev-parse", "HEAD"]), f.main);
        assert!(!out.path.join("node_modules").exists());
        assert!(!out.path.join("story.txt").exists());
        assert_eq!(out.seat.kind, SeatKind::Commit);
        assert_eq!(out.seat.pinned_commit.as_deref(), Some(f.main.as_str()));
        // No branch is created for a commit seat.
        assert!(git(&f.repo, &["branch", "--list", "feat/story-seat-review"]).is_empty());
        // A short sha or a ref resolves to the full sha.
        let by_ref = seat_worktree_inner(
            &f.repo,
            "feat/story",
            "review-2",
            &commit("feat/story"),
            TEMPLATE,
        )
        .unwrap();
        assert_eq!(
            by_ref.seat.pinned_commit.as_deref(),
            Some(f.story_tip.as_str())
        );
    }

    #[test]
    fn an_unknown_commit_is_refused_before_anything_is_created() {
        let f = fixture();
        for bad in [
            "0123456789abcdef0123456789abcdef01234567",
            "no-such-ref",
            "--orphan",
            " ",
        ] {
            let err = seat_worktree_inner(&f.repo, "feat/story", "review", &commit(bad), TEMPLATE)
                .unwrap_err();
            assert!(matches!(err, SeatError::Invalid(_)), "{bad:?}: {err:?}");
            assert!(!seat_path(&f, "review").exists(), "{bad:?}");
        }
        let err = create_pinned_checkout(&f.repo, &seat_path(&f, "x"), "nope").unwrap_err();
        assert_eq!(err, SeatError::Invalid("unknown commit \"nope\"".into()));
        assert!(!seat_path(&f, "x").exists());
        assert_eq!(
            git(&f.repo, &["worktree", "list", "--porcelain"])
                .matches("worktree ")
                .count(),
            1
        );
    }

    #[test]
    fn a_clean_commit_seat_re_pins_and_a_dirty_one_is_refused_unchanged() {
        let f = fixture();
        let first =
            seat_worktree_inner(&f.repo, "feat/story", "qa", &commit(&f.main), TEMPLATE).unwrap();
        // The same commit again reuses it as it is.
        let same =
            seat_worktree_inner(&f.repo, "feat/story", "qa", &commit(&f.main), TEMPLATE).unwrap();
        assert!(!same.created);
        // Clean: re-pinned to the new commit, still detached.
        let moved =
            seat_worktree_inner(&f.repo, "feat/story", "qa", &commit(&f.story_tip), TEMPLATE)
                .unwrap();
        assert!(!moved.created);
        assert_eq!(moved.path, first.path);
        assert_eq!(git(&moved.path, &["rev-parse", "HEAD"]), f.story_tip);
        assert_eq!(
            git(&moved.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "HEAD"
        );
        assert_eq!(
            moved.seat.pinned_commit.as_deref(),
            Some(f.story_tip.as_str())
        );
        // Dirty: refused, and the worktree keeps its commit and its change.
        std::fs::write(moved.path.join("notes.txt"), "uncommitted\n").unwrap();
        let err = seat_worktree_inner(&f.repo, "feat/story", "qa", &commit(&f.main), TEMPLATE)
            .unwrap_err();
        assert!(matches!(err, SeatError::Invalid(_)), "{err:?}");
        assert_eq!(git(&moved.path, &["rev-parse", "HEAD"]), f.story_tip);
        assert!(moved.path.join("notes.txt").exists());
    }

    #[test]
    fn a_seat_name_keeps_its_kind() {
        let f = fixture();
        seat_worktree_inner(
            &f.repo,
            "feat/story",
            "dev",
            &SeatWorktreeParam::Branch,
            TEMPLATE,
        )
        .unwrap();
        let err = seat_worktree_inner(&f.repo, "feat/story", "dev", &commit(&f.main), TEMPLATE)
            .unwrap_err();
        assert!(matches!(err, SeatError::Invalid(_)), "{err:?}");
        seat_worktree_inner(&f.repo, "feat/story", "qa", &commit(&f.main), TEMPLATE).unwrap();
        let err = seat_worktree_inner(
            &f.repo,
            "feat/story",
            "qa",
            &SeatWorktreeParam::Branch,
            TEMPLATE,
        )
        .unwrap_err();
        assert!(matches!(err, SeatError::Invalid(_)), "{err:?}");
        assert!(git(&f.repo, &["branch", "--list", "feat/story-seat-qa"]).is_empty());
    }

    #[test]
    fn a_stray_folder_at_the_seat_path_is_never_adopted() {
        let f = fixture();
        let path = seat_path(&f, "dev");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("keep.txt"), "not a worktree\n").unwrap();
        let err = seat_worktree_inner(
            &f.repo,
            "feat/story",
            "dev",
            &SeatWorktreeParam::Branch,
            TEMPLATE,
        )
        .unwrap_err();
        assert!(matches!(err, SeatError::Failed(_)), "{err:?}");
        assert!(path.join("keep.txt").exists());
        assert!(git(&f.repo, &["branch", "--list", "feat/story-seat-dev"]).is_empty());
    }

    #[test]
    fn only_a_new_or_unfinished_branch_seat_runs_setup() {
        assert!(seat_needs_setup(SeatKind::Branch, true, None));
        // A record left behind by an earlier worktree at the same folder doesn't skip it.
        assert!(seat_needs_setup(SeatKind::Branch, true, Some(true)));
        assert!(seat_needs_setup(SeatKind::Branch, false, Some(false)));
        assert!(seat_needs_setup(SeatKind::Branch, false, None));
        assert!(!seat_needs_setup(SeatKind::Branch, false, Some(true)));
        for (created, complete) in [(true, None), (false, Some(false)), (false, Some(true))] {
            assert!(!seat_needs_setup(SeatKind::Commit, created, complete));
        }
    }

    #[test]
    fn the_param_reads_both_kinds_and_refuses_others() {
        let read = |v: serde_json::Value| serde_json::from_value::<SeatWorktreeParam>(v);
        assert_eq!(
            read(serde_json::json!({"kind": "branch"})).unwrap(),
            SeatWorktreeParam::Branch
        );
        assert_eq!(
            read(serde_json::json!({"kind": "commit", "commit": "abc123"})).unwrap(),
            commit("abc123")
        );
        // A key that doesn't belong is refused, never ignored.
        for refused in [
            serde_json::json!({"kind": "commit"}),
            serde_json::json!({"kind": "commit", "comit": "abc123"}),
            serde_json::json!({"kind": "branch", "commit": "abc123"}),
            serde_json::json!({"kind": "branch", "base": "main"}),
            serde_json::json!({"kind": "shared"}),
            serde_json::json!({}),
        ] {
            assert!(read(refused.clone()).is_err(), "{refused}");
        }
    }
}
