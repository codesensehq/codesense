// SPDX-License-Identifier: MIT
use super::*;
#[test]
fn inherited_listing_and_reads_use_the_sharing_gate() {
    use crate::context_repo::inheritance::team_view;
    let (_tmp, root) = crate::context_repo::inheritance::test_fixture();
    std::fs::remove_file(root.join("child/content/shared.md")).unwrap();
    let view = team_view(&root, "acme/ctx", "child");
    let access = ContentAccess::new(
        view.own_content().own_path().unwrap().into(),
        Some(view),
        crate::context_repo::caller_scope::CallerScope::Human,
    );
    let rows = access.list_rows(None).unwrap();
    let shared = rows.iter().find(|r| r["name"] == "shared.md").unwrap();
    assert_eq!(shared["inheritedFrom"], "parent");
    assert!(access
        .admits_path(Path::new(shared["path"].as_str().unwrap()))
        .is_ok());
    for path in [
        root.join("parent/content/secret.md"),
        root.join("sibling/content/shared.md"),
        root.join("parent/content/missing.md"),
    ] {
        assert_eq!(access.admits_path(&path).unwrap_err(), NOT_FOUND);
    }
}

#[test]
fn selecting_an_ancestor_keeps_the_callers_view_at_the_same_boundary() {
    let (_tmp, root) = crate::context_repo::inheritance::test_fixture();
    let view = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "child");
    let parent = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "parent");
    let access = ContentAccess::new(
        parent.own_content().own_path().unwrap().into(),
        Some(view),
        crate::context_repo::caller_scope::CallerScope::Human,
    );
    let rows = access.list_rows(None).unwrap();
    assert!(rows.iter().any(|r| r["name"] == "shared.md"));
    assert!(!rows.iter().any(|r| r["name"] == "secret.md"));
    assert_eq!(
        access
            .admits_path(&access.own.join("secret.md"))
            .unwrap_err(),
        NOT_FOUND
    );
}

#[test]
fn missing_own_reads_have_the_same_not_found_response_as_denied_paths() {
    let (_tmp, root) = crate::context_repo::inheritance::test_fixture();
    let view = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "child");
    let own = view.own_content().own_path().unwrap().to_path_buf();
    let access = ContentAccess::new(
        own.clone(),
        Some(view),
        crate::context_repo::caller_scope::CallerScope::Human,
    );
    assert_eq!(
        access.admits_path(&own.join("absent.md")).unwrap_err(),
        NOT_FOUND
    );
    assert_eq!(
        access
            .admits_path(&root.join("parent/content/secret.md"))
            .unwrap_err(),
        NOT_FOUND
    );
}

#[test]
fn selected_parent_lists_filter_directories_before_summaries_and_winners() {
    let (_tmp, root) = crate::context_repo::inheritance::test_fixture();
    for (relative, text) in [
        ("parent/content/hidden-dir/hidden.md", "hidden"),
        ("parent/content/shared-dir/shared.md", "shared"),
    ] {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    std::fs::write(
        root.join("parent/config/sharing.yml"),
        "share:\n  - content/shared.md\n  - content/shared-dir/shared.md\n",
    )
    .unwrap();
    let child = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "child");
    let parent = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "parent");
    let access = ContentAccess::new(
        parent.own_content().own_path().unwrap().into(),
        Some(parent),
        crate::context_repo::caller_scope::CallerScope::Team(child),
    );
    let rows = access.list_rows(None).unwrap();
    assert!(rows.iter().any(|r| r["name"] == "shared-dir"));
    assert!(!rows.iter().any(|r| r["name"] == "hidden-dir"));
    assert_eq!(
        access.list_rows(Some("hidden-dir")).unwrap(),
        access.list_rows(Some("absent-dir")).unwrap()
    );
    assert_eq!(
        access.list_rows(Some("shared-dir")).unwrap()[0]["name"],
        "shared.md"
    );
}

#[test]
fn rename_tints_admit_sources_before_exposing_old_names() {
    for old_shared in [false, true] {
        let (_tmp, root) = crate::context_repo::inheritance::test_fixture();
        let old = if old_shared {
            "old-shared.md"
        } else {
            "secret.md"
        };
        std::fs::write(root.join("parent/content").join(old), "identical bytes").unwrap();
        std::fs::write(root.join("parent/content/extra.md"), "shared control").unwrap();
        std::fs::write(
            root.join("parent/config/sharing.yml"),
            "share:\n  - content/shared.md\n  - content/old-shared.md\n  - content/extra.md\n",
        )
        .unwrap();
        let repo = git2::Repository::init(&root).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_path(&PathBuf::from("parent/content").join(old))
            .unwrap();
        index.write().unwrap();
        let tree = index.write_tree().unwrap();
        let tree = repo.find_tree(tree).unwrap();
        let sig = git2::Signature::now("Test", "test@example.test").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .unwrap();
        std::fs::remove_file(root.join("parent/content/shared.md")).unwrap();
        std::fs::rename(
            root.join("parent/content").join(old),
            root.join("parent/content/shared.md"),
        )
        .unwrap();
        index
            .remove_path(&PathBuf::from("parent/content").join(old))
            .unwrap();
        index
            .add_path(Path::new("parent/content/shared.md"))
            .unwrap();
        index.write().unwrap();
        let child = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "child");
        let parent = crate::context_repo::inheritance::team_view(&root, "acme/ctx", "parent");
        let access = ContentAccess::new(
            parent.own_content().own_path().unwrap().into(),
            Some(parent),
            crate::context_repo::caller_scope::CallerScope::Team(child),
        );
        let mut rows = access.list_rows(None).unwrap();
        let shared = rows.iter_mut().find(|r| r["name"] == "shared.md").unwrap();
        assert_eq!(
            shared["gitState"],
            if old_shared { "renamed" } else { "added" }
        );
        assert_eq!(
            shared.get("oldName").and_then(Value::as_str),
            old_shared.then_some(old)
        );
        assert_eq!(
            access.admits_path(&root.join("parent/content/secret.md")),
            access.admits_path(&root.join("parent/content/absent.md"))
        );
    }
}

#[test]
fn tint_status_options_detect_staged_renames_only() {
    let (_dir, repo, own) = tests::committed_repo(&[
        ("staged-before.md", "staged bytes"),
        ("moved-before.md", "moved bytes"),
    ]);
    tests::stage_move(&repo, &own, "staged-before.md", "staged-after.md");
    std::fs::rename(own.join("moved-before.md"), own.join("moved-after.md")).unwrap();
    let statuses = repo.statuses(Some(&mut tint_status_options())).unwrap();
    let entries: Vec<_> = statuses
        .iter()
        .map(|entry| (entry.path().unwrap().to_owned(), entry.status()))
        .collect();
    // An index rename's entry path is its old path; the delta names both sides.
    let staged: Vec<_> = statuses
        .iter()
        .filter(|entry| entry.status().contains(git2::Status::INDEX_RENAMED))
        .filter_map(|entry| {
            let delta = entry.head_to_index()?;
            Some((
                delta.old_file().path()?.to_owned(),
                delta.new_file().path()?.to_owned(),
            ))
        })
        .collect();
    assert_eq!(
        staged,
        vec![(
            PathBuf::from("content/staged-before.md"),
            PathBuf::from("content/staged-after.md")
        )],
        "{entries:?}"
    );
    assert!(
        entries
            .iter()
            .all(|(_, status)| !status.contains(git2::Status::WT_RENAMED)),
        "{entries:?}"
    );
    assert!(
        entries
            .iter()
            .any(|(path, status)| path == "content/moved-after.md"
                && status.contains(git2::Status::WT_NEW)),
        "{entries:?}"
    );
}

#[test]
fn an_unstaged_move_tints_added_without_old_name() {
    let (_dir, _repo, own) =
        tests::committed_repo(&[("before.md", "identical bytes"), ("other.md", "other")]);
    std::fs::rename(own.join("before.md"), own.join("after.md")).unwrap();
    let access = ContentAccess::new(
        own,
        None,
        crate::context_repo::caller_scope::CallerScope::Human,
    );
    let rows = access.list_rows(None).unwrap();
    let moved = rows.iter().find(|r| r["name"] == "after.md").unwrap();
    assert_eq!(moved["gitState"], "added");
    assert!(moved.get("oldName").is_none(), "{moved}");
}

#[test]
fn a_delta_tint_keeps_its_single_row_pathspec() {
    let (_dir, _repo, own) =
        tests::committed_repo(&[("tracked.md", "first"), ("other.md", "other")]);
    std::fs::write(own.join("tracked.md"), "changed").unwrap();
    std::fs::write(own.join("untracked.md"), "new").unwrap();
    let access = ContentAccess::new(
        own.clone(),
        None,
        crate::context_repo::caller_scope::CallerScope::Human,
    );
    let listed = access.list_rows(None).unwrap();
    let mut row = access.row_for_path(&own.join("tracked.md")).unwrap();
    TINT_STATUSES.take();
    access.tint_rows(std::slice::from_mut(&mut row));
    assert_eq!(
        TINT_STATUSES.take(),
        vec![Some(PathBuf::from("content/tracked.md"))]
    );
    assert_eq!(row["gitState"], "modified");
    assert_eq!(
        &row,
        listed.iter().find(|r| r["name"] == "tracked.md").unwrap()
    );
}
