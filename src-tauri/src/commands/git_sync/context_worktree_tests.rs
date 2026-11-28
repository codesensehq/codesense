// SPDX-License-Identifier: MIT
use super::*;
use crate::agents::prepare::step3::tests::{git, write, Fx};
use crate::agents::resolve::tests::{alice, ORG, TEAM};
use crate::install::worktree_index::{ContextWorkItem, ContextWorktreeOwner};
use crate::work_item::WorkItemId;

const LEAD: &str = "sprint-lead";

fn item(id: &str) -> WorkItemId {
    WorkItemId::parse(id).unwrap()
}

fn carry(mut row: ContextWorktreeRecord, id: &WorkItemId) -> ContextWorktreeRecord {
    row.work_item = Some(ContextWorkItem {
        id: id.clone(),
        lead_session: None,
        lead_handle: Some(LEAD.into()),
        lead_agent: Some("Sprint lead".into()),
        sprint_id: None,
    });
    row
}

fn commit(row: &ContextWorktreeRecord, files: &[(&str, &str)]) {
    for (path, body) in files {
        write(&row.launch_cwd, path, body.as_bytes());
    }
    git(&row.root, &["add", "."]);
    git(&row.root, &["commit", "-qm", "edit"]);
}

fn content(path: &str) -> String {
    format!("{TEAM}/content/{path}")
}

fn paths(branch: &LeadBranch) -> Vec<(&str, usize)> {
    branch
        .files
        .iter()
        .map(|f| (f.file.path.as_str(), f.branches))
        .collect()
}

#[test]
fn a_lead_diff_lists_each_branch_against_its_own_merge_base_and_never_latest_wins() {
    let fx = Fx::new();
    write(&fx.team, "README.md", b"base\n");
    let id = item("wi_00000000000000a1");
    let first = carry(fx.context("story-one"), &id);
    commit(&first, &[("README.md", "one\n"), ("one.md", "one\n")]);
    // Main moves on after the first story forked: its file must not count against that story.
    let canonical = crate::context_repo::path_to_org_root(fx.home.path(), &alice(), ORG).unwrap();
    write(&fx.team, "main-only.md", b"main\n");
    git(&canonical, &["add", "."]);
    git(&canonical, &["commit", "-qm", "main edit"]);
    let second = carry(fx.context("story-two"), &id);
    commit(&second, &[("README.md", "two\n")]);
    let mut own = carry(fx.context("lead-own"), &id);
    own.owner = Some(ContextWorktreeOwner::Agent {
        handle: LEAD.into(),
        name: "Sprint lead".into(),
    });
    commit(&own, &[("sprint.md", "plan\n")]);
    let other = carry(fx.context("elsewhere"), &item("wi_00000000000000b2"));
    commit(&other, &[("README.md", "other\n")]);

    let diff = lead_diff_impl(&[own.clone(), other, second.clone(), first.clone()], &id).unwrap();

    assert_eq!(diff.work_item, id.as_str());
    assert_eq!(diff.lead.as_deref(), Some("Sprint lead"));
    let names: Vec<_> = diff
        .branches
        .iter()
        .map(|b| (b.story.as_str(), b.own))
        .collect();
    assert_eq!(
        names,
        [
            ("story-one", false),
            ("story-two", false),
            ("lead-own", true)
        ]
    );
    assert_eq!(
        paths(&diff.branches[0]),
        [
            (content("README.md").as_str(), 2),
            (content("one.md").as_str(), 1)
        ]
    );
    assert_eq!(
        paths(&diff.branches[1]),
        [(content("README.md").as_str(), 2)]
    );
    assert_eq!(
        paths(&diff.branches[2]),
        [(content("sprint.md").as_str(), 1)]
    );
    let readme = &diff.branches[0].files[0];
    assert_eq!(readme.file.status, PublishFileStatus::Modified);
    assert_eq!((readme.file.added, readme.file.removed), (Some(1), Some(1)));
    assert!(diff.branches.iter().all(|b| !b.deleted));
    assert_eq!(diff.branches[0].worktree, first.id);
    assert_eq!(diff.branches[1].branch, second.branch);
}

#[test]
fn a_branch_whose_ref_is_gone_comes_back_deleted_and_a_lead_without_a_worktree_has_only_stories() {
    let fx = Fx::new();
    write(&fx.team, "README.md", b"base\n");
    let id = item("wi_00000000000000c3");
    let kept = carry(fx.context("kept"), &id);
    commit(&kept, &[("README.md", "kept\n")]);
    let gone = carry(fx.context("gone"), &id);
    commit(&gone, &[("README.md", "gone\n")]);
    git(
        &gone.root,
        &["update-ref", "-d", &format!("refs/heads/{}", gone.branch)],
    );
    let removed = carry(fx.context("removed"), &id);
    std::fs::remove_dir_all(&removed.root).unwrap();

    let diff = lead_diff_impl(&[kept, gone, removed], &id).unwrap();

    let rows: Vec<_> = diff
        .branches
        .iter()
        .map(|b| (b.story.as_str(), b.own, b.deleted, b.files.len()))
        .collect();
    assert_eq!(
        rows,
        [
            ("gone", false, true, 0),
            ("kept", false, false, 1),
            ("removed", false, true, 0),
        ]
    );
    // A deleted branch changes nothing, so it adds no branch to a path's count.
    assert_eq!(diff.branches[1].files[0].branches, 1);
}

#[test]
fn a_work_item_no_worktree_carries_reads_as_no_branches() {
    let fx = Fx::new();
    let row = fx.context("unrelated");
    let diff = lead_diff_impl(&[row], &item("wi_00000000000000d4")).unwrap();
    assert!(diff.branches.is_empty());
    assert_eq!(diff.lead, None);
}

#[test]
fn a_branch_that_cannot_be_read_carries_its_error_and_the_rest_are_still_read() {
    let fx = Fx::new();
    write(&fx.team, "README.md", b"base\n");
    let id = item("wi_00000000000000e5");
    let kept = carry(fx.context("kept"), &id);
    commit(&kept, &[("README.md", "kept\n")]);
    // Its registration now names another checkout: the diff must not read that one.
    let mut moved = carry(fx.context("moved"), &id);
    moved.launch_cwd = kept.launch_cwd.clone();
    // Its head shares no history with main, so its merge base cannot be found.
    let lonely = carry(fx.context("lonely"), &id);
    git(
        &lonely.root,
        &["checkout", "-q", "--orphan", "lonely-orphan"],
    );
    commit(&lonely, &[("README.md", "lonely\n")]);

    let diff = lead_diff_impl(&[kept, moved, lonely], &id).unwrap();

    let rows: Vec<_> = diff
        .branches
        .iter()
        .map(|b| {
            (
                b.story.as_str(),
                b.deleted,
                b.error.is_some(),
                b.files.len(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("kept", false, false, 1),
            ("lonely", false, true, 0),
            ("moved", false, true, 0),
        ]
    );
    assert_eq!(
        diff.branches[2].error.as_deref(),
        Some("That context worktree's Git registration changed")
    );
    assert_eq!(diff.branches[0].files[0].branches, 1);
}
