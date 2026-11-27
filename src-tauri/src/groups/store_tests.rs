// SPDX-License-Identifier: MIT
//! The group store's tests: compare-and-set, repair, the version gate, the private layer, the
//! Scratch exclude and the flag-off rule.

use super::*;
use crate::groups::shape::Axis;
use std::collections::BTreeMap;
use tempfile::tempdir;

const ORG: &str = "acme/ctx";

fn me() -> Principal {
    Principal::from(42u64)
}

fn store(home: &Path, tiles: bool) -> GroupStore {
    GroupStore::at(home, &me(), ORG, tiles).unwrap()
}

fn leaf(id: &str) -> SavedNode {
    SavedNode::Leaf {
        id: id.into(),
        workspace_id: id.into(),
    }
}

fn split(axis: Axis, children: Vec<SavedNode>, sizes: Vec<f64>) -> SavedNode {
    SavedNode::Split {
        axis,
        children,
        sizes,
    }
}

fn put(root: SavedNode) -> Change {
    Change::Put {
        owner: OwnerKind::Group,
        root: Some(root),
    }
}

fn file_of(home: &Path, id: &str) -> PathBuf {
    groups_dir(&scratch_space::org_space_at(home, &me(), ORG).unwrap()).join(format!("{id}.json"))
}

/// Every file under `root` with its bytes (and every folder, so a new empty one shows).
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut seen = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                seen.insert(relative, None);
                stack.push(path);
            } else {
                seen.insert(relative, Some(std::fs::read(&path).unwrap_or_default()));
            }
        }
    }
    seen
}

/// The scratch repo's status entries under a group folder.
fn group_statuses(home: &Path) -> Vec<String> {
    let repo = git2::Repository::open(scratch_space::scratch_root(home, &me())).unwrap();
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).unwrap();
    statuses
        .iter()
        .filter_map(|s| s.path().map(str::to_string).ok())
        .filter(|p| p.contains("config/groups"))
        .collect()
}

// 1.1 compare-and-set at head under the one lock.

#[test]
fn a_write_on_a_stale_base_rev_is_a_conflict_that_changes_nothing() {
    let tmp = tempdir().unwrap();
    let a = store(tmp.path(), true);
    let b = store(tmp.path(), true);
    assert_eq!(a.commit("main", 0, put(leaf("ws-a"))), Ok(1));
    let before = std::fs::read(file_of(tmp.path(), "main")).unwrap();
    assert_eq!(
        b.commit("main", 0, put(leaf("ws-b"))),
        Err(StoreError::Conflict {
            current_revision: 1
        })
    );
    assert_eq!(std::fs::read(file_of(tmp.path(), "main")).unwrap(), before);
    assert_eq!(b.commit("main", 1, put(leaf("ws-b"))), Ok(2));
    assert_eq!(
        a.commit("main", 1, Change::Delete),
        Err(StoreError::Conflict {
            current_revision: 2
        })
    );
    let loaded = a.load("main").unwrap();
    assert_eq!(loaded.file.rev, 2);
    assert_eq!(loaded.file.root, Some(leaf("ws-b")));
}

/// Two writers through the public API, each retrying on a conflict: every applied write gets
/// its own `rev`, the revs are 1..=2N with none lost or reused, and the file ends at the last.
#[test]
fn concurrent_writers_are_linearizable_by_rev() {
    const EACH: usize = 25;
    let tmp = tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let writers: Vec<_> = ["ws-a", "ws-b"]
        .into_iter()
        .map(|who| {
            let home = home.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let writer = store(&home, true);
                barrier.wait();
                let mut revs = vec![];
                let mut base = 0;
                while revs.len() < EACH {
                    match writer.commit("shared", base, put(leaf(who))) {
                        Ok(rev) => {
                            revs.push(rev);
                            base = rev;
                        }
                        Err(StoreError::Conflict { current_revision }) => base = current_revision,
                        Err(e) => panic!("{who}: {e}"),
                    }
                }
                revs
            })
        })
        .collect();
    let mut all: Vec<u64> = writers
        .into_iter()
        .flat_map(|w| w.join().unwrap())
        .collect();
    all.sort_unstable();
    assert_eq!(all, (1..=(2 * EACH) as u64).collect::<Vec<_>>());
    assert_eq!(
        store(&home, true).load("shared").unwrap().file.rev,
        2 * EACH as u64
    );
}

#[test]
fn the_rev_is_read_from_the_file_so_it_carries_on_after_a_restart() {
    let tmp = tempdir().unwrap();
    assert_eq!(
        store(tmp.path(), true).commit("main", 0, put(leaf("ws-1"))),
        Ok(1)
    );
    assert_eq!(
        store(tmp.path(), true).commit("main", 1, put(leaf("ws-2"))),
        Ok(2)
    );
    let restarted = store(tmp.path(), true);
    assert_eq!(restarted.load("main").unwrap().file.rev, 2);
    assert_eq!(
        restarted.commit("main", 0, put(leaf("ws-3"))),
        Err(StoreError::Conflict {
            current_revision: 2
        })
    );
}

#[test]
fn a_recreate_continues_from_the_tombstone_so_an_old_base_rev_never_passes() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    assert_eq!(s.commit("main", 1, put(leaf("ws-2"))), Ok(2));
    assert_eq!(s.commit("main", 2, Change::Delete), Ok(3));
    let tombstone: serde_json::Value =
        serde_json::from_slice(&std::fs::read(file_of(tmp.path(), "main")).unwrap()).unwrap();
    assert_eq!(
        tombstone,
        serde_json::json!({ "version": 2, "deleted": true, "rev": 3 })
    );
    assert_eq!(s.load("main"), Err(StoreError::NotFound));
    assert!(s.list().unwrap().is_empty(), "list skips tombstones");
    assert_eq!(
        s.commit("main", 2, Change::Delete),
        Err(StoreError::NotFound)
    );
    for stale in [0, 1, 2] {
        assert_eq!(
            s.commit("main", stale, put(leaf("ws-3"))),
            Err(StoreError::Conflict {
                current_revision: 3
            }),
            "base {stale}"
        );
    }
    assert_eq!(s.commit("main", 3, put(leaf("ws-3"))), Ok(4));
    assert_eq!(s.load("main").unwrap().file.rev, 4);
    assert_eq!(
        s.commit("never", 0, Change::Delete),
        Err(StoreError::NotFound)
    );
}

// 1.2 atomic writes, repair, the version gate.

#[test]
fn a_write_killed_mid_way_leaves_the_file_whole() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    let path = file_of(tmp.path(), "main");
    let before = std::fs::read(&path).unwrap();
    // A kill between the temp write and the rename leaves a torn temp beside the file.
    let tmp_file = path.with_extension("json.tmp");
    std::fs::write(&tmp_file, br#"{"version": 2, "owner": "gr"#).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(s.load("main").unwrap().file.root, Some(leaf("ws-1")));
    assert_eq!(s.list().unwrap().len(), 1, "the temp is not a group");
    assert_eq!(s.commit("main", 1, put(leaf("ws-2"))), Ok(2));
    assert!(!tmp_file.exists(), "the next write replaces the stale temp");
    assert_eq!(s.load("main").unwrap().file.root, Some(leaf("ws-2")));
}

#[test]
fn repair_on_load_is_in_memory_and_reaches_the_file_with_the_next_write() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    let path = file_of(tmp.path(), "main");
    let stored = serde_json::json!({
        "version": 2,
        "owner": "group",
        "rev": 1,
        "root": {
            "kind": "split",
            "axis": "row",
            "children": [
                { "kind": "leaf", "id": "agent:core/dev", "workspaceId": "agent:core/dev" },
                { "kind": "leaf", "id": "doc:../x", "workspaceId": "doc:../x" },
                {
                    "kind": "leaf",
                    "id": "doc:core/notes/missing.md",
                    "workspaceId": "doc:core/notes/missing.md"
                }
            ],
            "sizes": [20, 50, 30]
        }
    });
    let bytes = serde_json::to_vec_pretty(&stored).unwrap();
    std::fs::write(&path, &bytes).unwrap();

    let loaded = s.load("main").unwrap();
    assert_eq!(loaded.dropped, vec!["doc:../x".to_string()]);
    let repaired = split(
        Axis::Row,
        vec![leaf("agent:core/dev"), leaf("doc:core/notes/missing.md")],
        vec![40.0, 60.0],
    );
    assert_eq!(loaded.file.root, Some(repaired.clone()));
    assert_eq!(loaded.file.rev, 1, "a load never bumps the rev");
    assert_eq!(
        s.list().unwrap()[0].file.as_ref().unwrap().root,
        Some(repaired.clone())
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        bytes,
        "a load writes nothing"
    );

    assert_eq!(s.commit("main", 1, put(repaired.clone())), Ok(2));
    let written = s.load("main").unwrap();
    assert_eq!(
        written.file.rev, 2,
        "the repair bumps rev once, with the write"
    );
    assert_eq!(written.file.root, Some(repaired));
    assert!(written.dropped.is_empty());
}

#[test]
fn a_split_left_with_one_child_collapses_and_nothing_left_is_an_empty_root() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    let path = file_of(tmp.path(), "main");
    let write = |root: serde_json::Value| {
        let file = serde_json::json!({ "version": 2, "owner": "group", "rev": 1, "root": root });
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
    };
    write(serde_json::json!({
        "kind": "split", "axis": "column", "sizes": [50, 50],
        "children": [
            { "kind": "leaf", "id": "ws-1", "workspaceId": "ws-1" },
            { "kind": "leaf", "id": "bad id", "workspaceId": "bad id" }
        ]
    }));
    assert_eq!(s.load("main").unwrap().file.root, Some(leaf("ws-1")));
    write(serde_json::json!({ "kind": "leaf", "id": "x:y", "workspaceId": "x:y" }));
    let loaded = s.load("main").unwrap();
    assert_eq!(loaded.file.root, None);
    assert_eq!(loaded.dropped, vec!["x:y".to_string()]);
}

/// The files the store can't read, each listed with the reason and never written.
fn unreadable_files() -> Vec<(&'static str, Vec<u8>)> {
    let json = |v: serde_json::Value| serde_json::to_vec(&v).unwrap();
    vec![
        ("torn", b"{\"version\": 2, \"own".to_vec()),
        ("not-json", b"not json".to_vec()),
        ("empty", vec![]),
        ("array", b"[]".to_vec()),
        (
            "newer",
            json(serde_json::json!({ "version": 3, "owner": "group", "rev": 4, "root": null })),
        ),
        (
            "older",
            json(serde_json::json!({ "version": 1, "owner": "group", "rev": 4, "root": null })),
        ),
        (
            "no-version",
            json(serde_json::json!({ "owner": "group", "rev": 4, "root": null })),
        ),
        (
            "extra-key",
            json(
                serde_json::json!({ "version": 2, "owner": "group", "rev": 4, "root": null, "pins": [] }),
            ),
        ),
        (
            "bad-owner",
            json(serde_json::json!({ "version": 2, "owner": "team", "rev": 4, "root": null })),
        ),
        (
            "no-root",
            json(serde_json::json!({ "version": 2, "owner": "group", "rev": 4 })),
        ),
        (
            "bad-split",
            json(
                serde_json::json!({ "version": 2, "owner": "group", "rev": 4, "root": {
                    "kind": "split", "axis": "row", "sizes": [100],
                    "children": [{ "kind": "leaf", "id": "ws-1", "workspaceId": "ws-1" }]
                }}),
            ),
        ),
        (
            "bad-tombstone",
            json(serde_json::json!({ "version": 2, "deleted": false, "rev": 4 })),
        ),
    ]
}

#[test]
fn an_unreadable_or_newer_file_is_listed_as_cant_be_read_and_never_written() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    scratch_space::open_group_space(tmp.path(), &me(), ORG, true).unwrap();
    let files = unreadable_files();
    for (id, bytes) in &files {
        std::fs::write(file_of(tmp.path(), id), bytes).unwrap();
    }
    let listed = s.list().unwrap();
    assert_eq!(listed.len(), files.len());
    for row in &listed {
        assert_eq!(row.file, Err(UNREADABLE), "{}", row.id);
    }
    assert_eq!(UNREADABLE, "can't be read");
    for (id, bytes) in &files {
        assert_eq!(s.load(id), Err(StoreError::Unreadable), "{id}");
        for base in [0, 1, 4, 5, u64::MAX] {
            assert_eq!(
                s.commit(id, base, put(leaf("ws-1"))),
                Err(StoreError::Unreadable),
                "{id} put at {base}"
            );
            assert_eq!(
                s.commit(id, base, Change::Delete),
                Err(StoreError::Unreadable),
                "{id} delete at {base}"
            );
        }
        assert_eq!(
            &std::fs::read(file_of(tmp.path(), id)).unwrap(),
            bytes,
            "{id}"
        );
    }
}

#[test]
fn a_refused_tree_writes_nothing_and_says_why() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    let mismatched = SavedNode::Leaf {
        id: "ws-1".into(),
        workspace_id: "ws-2".into(),
    };
    for (tree, says) in [
        (leaf("doc:../x"), "doc:../x"),
        (mismatched, "differ"),
        (
            split(Axis::Row, vec![leaf("ws-1")], vec![100.0]),
            "two or more",
        ),
        (
            split(Axis::Row, vec![leaf("ws-1"), leaf("ws-2")], vec![100.0]),
            "one size per child",
        ),
        (
            split(
                Axis::Row,
                vec![leaf("ws-1"), leaf("ws-2")],
                vec![-1.0, 101.0],
            ),
            "finite",
        ),
        (
            split(
                Axis::Row,
                vec![leaf("ws-1"), leaf("ws-2")],
                vec![f64::NAN, 50.0],
            ),
            "finite",
        ),
    ] {
        match s.commit("main", 0, put(tree)) {
            Err(StoreError::InvalidTree(why)) => assert!(why.contains(says), "{why}"),
            other => panic!("{says}: {other:?}"),
        }
    }
    assert!(snapshot(tmp.path()).is_empty(), "nothing written");
}

// 1.3 the private layer: profile isolation, ids and paths.

#[test]
fn profile_b_never_sees_profile_a_and_nothing_is_staged_or_pushed() {
    let tmp = tempdir().unwrap();
    let a = store(tmp.path(), true);
    let b = GroupStore::at(tmp.path(), &Principal::from(43u64), ORG, true).unwrap();
    assert_eq!(a.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    assert_eq!(a.commit("other", 0, put(leaf("ws-2"))), Ok(1));
    assert!(b.list().unwrap().is_empty());
    assert_eq!(b.load("main"), Err(StoreError::NotFound));
    assert_eq!(
        b.commit("main", 0, put(leaf("ws-3"))),
        Ok(1),
        "B's own file"
    );
    assert_eq!(a.load("main").unwrap().file.root, Some(leaf("ws-1")));
    assert_eq!(a.list().unwrap().len(), 2);

    let path = file_of(tmp.path(), "main");
    assert!(path.starts_with(scratch_space::scratch_root(tmp.path(), &me())));
    assert!(!path.components().any(|c| c.as_os_str() == "content"));
    let repo = git2::Repository::open(scratch_space::scratch_root(tmp.path(), &me())).unwrap();
    assert!(repo.remotes().unwrap().is_empty(), "nothing to push to");
    assert_eq!(repo.index().unwrap().len(), 0, "nothing staged");
    assert!(group_statuses(tmp.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn group_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempdir().unwrap();
    assert_eq!(
        store(tmp.path(), true).commit("main", 0, put(leaf("ws-1"))),
        Ok(1)
    );
    let mode = std::fs::metadata(file_of(tmp.path(), "main"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_refused_id_writes_nothing() {
    let tmp = tempdir().unwrap();
    let s = store(tmp.path(), true);
    let long = "a".repeat(65);
    for id in [
        "",
        "Main",
        "a_b",
        "a.b",
        "main.json",
        "..",
        "../content/x",
        "a/b",
        "a\\b",
        "/etc/passwd",
        "C:\\x",
        "a b",
        "a\0b",
        long.as_str(),
    ] {
        assert!(
            matches!(
                s.commit(id, 0, put(leaf("ws-1"))),
                Err(StoreError::InvalidId(_))
            ),
            "{id:?}"
        );
        assert!(
            matches!(
                s.commit(id, 0, Change::Delete),
                Err(StoreError::InvalidId(_))
            ),
            "{id:?}"
        );
        assert!(
            matches!(s.load(id), Err(StoreError::InvalidId(_))),
            "{id:?}"
        );
    }
    assert!(snapshot(tmp.path()).is_empty(), "nothing written");
    assert_eq!(s.commit(&"a".repeat(64), 0, put(leaf("ws-1"))), Ok(1));
    assert_eq!(s.commit("0-a-9", 0, put(leaf("ws-1"))), Ok(1));
}

#[cfg(unix)]
#[test]
fn a_symlinked_folder_or_file_is_refused_and_written_through_never() {
    let tmp = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let s = store(tmp.path(), true);
    let dir = scratch_space::open_group_space(tmp.path(), &me(), ORG, true)
        .unwrap()
        .unwrap();

    // The group file is a symlink.
    let target = outside.path().join("target.json");
    std::fs::write(&target, b"theirs").unwrap();
    std::os::unix::fs::symlink(&target, dir.join("main.json")).unwrap();
    assert!(matches!(
        s.commit("main", 0, put(leaf("ws-1"))),
        Err(StoreError::Refused(_))
    ));
    assert!(matches!(
        s.commit("main", 0, Change::Delete),
        Err(StoreError::Refused(_))
    ));
    assert!(matches!(s.load("main"), Err(StoreError::Refused(_))));
    assert_eq!(s.list().unwrap()[0].file, Err(UNREADABLE));
    assert_eq!(std::fs::read(&target).unwrap(), b"theirs");

    // The group folder is a symlink.
    std::fs::remove_file(dir.join("main.json")).unwrap();
    std::fs::remove_file(dir.join(".gitignore")).unwrap();
    std::fs::remove_dir(&dir).unwrap();
    std::os::unix::fs::symlink(outside.path(), &dir).unwrap();
    assert!(matches!(
        s.commit("new", 0, put(leaf("ws-1"))),
        Err(StoreError::Refused(_))
    ));
    assert!(matches!(s.list(), Err(StoreError::Refused(_))));
    assert!(matches!(s.load("new"), Err(StoreError::Refused(_))));
    std::fs::remove_file(&dir).unwrap();

    // A folder above it is a symlink.
    let config = dir.parent().unwrap();
    std::fs::remove_dir_all(config).unwrap();
    std::os::unix::fs::symlink(outside.path(), config).unwrap();
    assert!(matches!(
        s.commit("new", 0, put(leaf("ws-1"))),
        Err(StoreError::Refused(_))
    ));
    let mut left: Vec<_> = std::fs::read_dir(outside.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    left.sort();
    assert_eq!(
        left,
        vec![std::ffi::OsString::from("target.json")],
        "nothing written outside"
    );
}

// 1.4 the saved leaf's keys.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeafRow {
    id: Option<String>,
    workspace_id: Option<String>,
    valid: bool,
}

#[derive(serde::Deserialize)]
struct LeafFixture {
    leaves: Vec<LeafRow>,
}

/// Every saved-leaf row: both keys are checked and must be equal, on load and on write.
#[test]
fn the_saved_leaf_rows_of_the_fixture_hold() {
    let fixture: LeafFixture =
        serde_json::from_str(include_str!("../../../tests/fixtures/leaf-keys.json")).unwrap();
    assert!(!fixture.leaves.is_empty());
    for row in fixture.leaves {
        let mut node = serde_json::json!({ "kind": "leaf" });
        if let Some(id) = &row.id {
            node["id"] = id.clone().into();
        }
        if let Some(workspace_id) = &row.workspace_id {
            node["workspaceId"] = workspace_id.clone().into();
        }
        let mut dropped = vec![];
        let repaired = repair(&node, &mut dropped).expect("a leaf is always this shape");
        assert_eq!(repaired.is_some(), row.valid, "load {node}");
        if let (Some(id), Some(workspace_id)) = (&row.id, &row.workspace_id) {
            let written = SavedNode::Leaf {
                id: id.clone(),
                workspace_id: workspace_id.clone(),
            };
            assert_eq!(tree_problem(&written).is_none(), row.valid, "write {node}");
        }
    }
}

// 1.5 restart restores splits and sizes.

#[test]
fn a_restart_restores_splits_and_sizes_exactly() {
    let tmp = tempdir().unwrap();
    let tree = split(
        Axis::Row,
        vec![
            leaf("agent:core/dev"),
            split(
                Axis::Column,
                vec![leaf("doc:core/notes/plan.md"), leaf("ws-1"), leaf("tab-7")],
                vec![12.5, 37.5, 50.0],
            ),
        ],
        vec![33.25, 66.75],
    );
    let s = store(tmp.path(), true);
    assert_eq!(s.commit("main", 0, put(tree.clone())), Ok(1));
    // A resize is one more write of the same leaves.
    let resized = split(
        Axis::Row,
        vec![
            leaf("agent:core/dev"),
            split(
                Axis::Column,
                vec![leaf("doc:core/notes/plan.md"), leaf("ws-1"), leaf("tab-7")],
                vec![25.0, 25.0, 50.0],
            ),
        ],
        vec![40.0, 60.0],
    );
    assert_eq!(s.commit("main", 1, put(resized.clone())), Ok(2));
    drop(s);
    let loaded = store(tmp.path(), true).load("main").unwrap();
    assert_eq!(loaded.file.root, Some(resized));
    assert_eq!(loaded.file.owner, OwnerKind::Group);
    assert!(loaded.dropped.is_empty());
}

/// The store's own write raises no change event for the watcher.
#[test]
fn a_store_write_is_suppressed_for_the_watcher() {
    let tmp = tempdir().unwrap();
    let dispatcher = crate::content_engine::Dispatcher::new(0, 100, 60_000, 60_000);
    let handle = dispatcher.suppression_handle();
    let s = store(tmp.path(), true).with_suppression(handle.clone());
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    assert!(handle.is_suppressed(&file_of(tmp.path(), "main")));
}

#[test]
fn the_fixture_file_round_trips_through_the_rust_shape() {
    let text = include_str!("../../../tests/fixtures/group-file-v2.json");
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    let file: GroupFile = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(file.version, VERSION);
    // What the store writes for it reads back the same (sizes compare as numbers, so the
    // fixture's `40` and a written `40.0` are one value).
    let written = serde_json::to_vec_pretty(&file).unwrap();
    assert_eq!(serde_json::from_slice::<GroupFile>(&written).unwrap(), file);
    let Head::File(loaded) = parse_head(&value).unwrap() else {
        panic!("the fixture is a live file");
    };
    assert_eq!(loaded.file, file);
    assert!(loaded.dropped.is_empty());
}

// 1.6 the Scratch exclude.

fn exclude_of(home: &Path) -> PathBuf {
    scratch_space::scratch_root(home, &me()).join(".git/info/exclude")
}

#[test]
fn opening_the_space_excludes_group_files_and_writes_the_folder_gitignore() {
    let tmp = tempdir().unwrap();
    let dir = scratch_space::open_group_space(tmp.path(), &me(), ORG, true)
        .unwrap()
        .unwrap();
    assert_eq!(dir, file_of(tmp.path(), "x").parent().unwrap());
    let exclude = std::fs::read_to_string(exclude_of(tmp.path())).unwrap();
    assert_eq!(exclude.lines().filter(|l| *l == GROUPS_EXCLUDE).count(), 1);
    assert_eq!(
        std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
        "*\n"
    );
    assert_eq!(
        store(tmp.path(), true).commit("main", 0, put(leaf("ws-1"))),
        Ok(1)
    );
    assert!(group_statuses(tmp.path()).is_empty());
    // The exclude alone keeps the status clean.
    std::fs::remove_file(dir.join(".gitignore")).unwrap();
    assert!(
        group_statuses(tmp.path()).is_empty(),
        "{:?}",
        group_statuses(tmp.path())
    );
}

#[test]
fn an_existing_repo_gets_the_entry_once_and_keeps_its_other_lines() {
    let tmp = tempdir().unwrap();
    scratch_space::ensure_scratch_repo(tmp.path(), &me()).unwrap();
    let exclude = exclude_of(tmp.path());
    std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    std::fs::write(&exclude, "# mine\n*.log").unwrap();
    for _ in 0..2 {
        scratch_space::open_group_space(tmp.path(), &me(), ORG, true).unwrap();
        scratch_space::exclude_group_files(&scratch_space::scratch_root(tmp.path(), &me()), true);
    }
    assert_eq!(
        std::fs::read_to_string(&exclude).unwrap(),
        format!("# mine\n*.log\n{GROUPS_EXCLUDE}\n")
    );
}

#[test]
fn the_exclude_waits_for_the_repo() {
    let tmp = tempdir().unwrap();
    let root = scratch_space::scratch_root(tmp.path(), &me());
    scratch_space::exclude_group_files(&root, true);
    assert!(snapshot(tmp.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn a_read_only_git_folder_fails_the_exclude_but_not_the_open() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempdir().unwrap();
    let root = scratch_space::ensure_scratch_repo(tmp.path(), &me()).unwrap();
    let info = root.join(".git/info");
    std::fs::create_dir_all(&info).unwrap();
    let before = std::fs::read(info.join("exclude")).ok();
    let mode = |m: u32| std::fs::set_permissions(&info, std::fs::Permissions::from_mode(m));
    mode(0o555).unwrap();
    if std::fs::write(info.join("probe"), b"").is_ok() {
        // Running as a user the permission bits don't bind (root): nothing to prove.
        mode(0o755).unwrap();
        return;
    }
    let opened = scratch_space::open_group_space(tmp.path(), &me(), ORG, true);
    let committed = store(tmp.path(), true).commit("main", 0, put(leaf("ws-1")));
    let after = std::fs::read(info.join("exclude")).ok();
    mode(0o755).unwrap();
    assert!(opened.unwrap().is_some(), "the open does not fail");
    assert_eq!(committed, Ok(1));
    assert_eq!(after, before, "the exclude write failed");
    assert!(
        group_statuses(tmp.path()).is_empty(),
        "the folder's .gitignore keeps it clean"
    );
}

// 1.7 and 1.8 the flag-off rule.

/// A profile holding a group written with the flag on, one with a ref the load drops, and an
/// existing scratch repo.
fn written_profile(home: &Path) {
    let s = store(home, true);
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    assert_eq!(s.commit("gone", 0, put(leaf("ws-2"))), Ok(1));
    assert_eq!(s.commit("gone", 1, Change::Delete), Ok(2));
    let file = serde_json::json!({ "version": 2, "owner": "group", "rev": 1, "root": {
        "kind": "split", "axis": "row", "sizes": [50, 50],
        "children": [
            { "kind": "leaf", "id": "ws-1", "workspaceId": "ws-1" },
            { "kind": "leaf", "id": "doc:/etc/x", "workspaceId": "doc:/etc/x" }
        ]
    }});
    std::fs::write(file_of(home, "repair"), serde_json::to_vec(&file).unwrap()).unwrap();
}

/// Every entry point this story ships, with the flag off.
fn call_every_entry_point_flag_off(home: &Path) {
    let s = store(home, false);
    for (id, base) in [
        ("main", 1),
        ("main", 0),
        ("new", 0),
        ("gone", 2),
        ("repair", 1),
    ] {
        assert_eq!(
            s.commit(id, base, put(leaf("ws-9"))),
            Err(StoreError::TilesOff)
        );
        assert_eq!(
            s.commit(id, base, Change::Delete),
            Err(StoreError::TilesOff)
        );
    }
    let _ = s.load("repair");
    let _ = s.load("main");
    let _ = s.list();
    assert_eq!(
        scratch_space::open_group_space(home, &me(), ORG, false).unwrap(),
        None
    );
    assert_eq!(
        scratch_space::open_group_space(home, &me(), "acme/other", false).unwrap(),
        None
    );
    scratch_space::exclude_group_files(&scratch_space::scratch_root(home, &me()), false);
}

#[test]
fn with_the_flag_off_no_entry_point_writes_and_the_profile_is_byte_identical() {
    let tmp = tempdir().unwrap();
    written_profile(tmp.path());
    // An exclude without the entry, so a flag-off open that added it would show.
    let exclude = exclude_of(tmp.path());
    std::fs::write(&exclude, "# mine\n").unwrap();
    std::fs::remove_file(file_of(tmp.path(), "x").with_file_name(".gitignore")).unwrap();
    let before = snapshot(tmp.path());
    call_every_entry_point_flag_off(tmp.path());
    assert_eq!(snapshot(tmp.path()), before);

    let fresh = tempdir().unwrap();
    call_every_entry_point_flag_off(fresh.path());
    assert!(
        snapshot(fresh.path()).is_empty(),
        "a new profile stays empty"
    );
}

#[test]
fn a_layout_written_with_the_flag_on_survives_a_flag_off_launch() {
    let tmp = tempdir().unwrap();
    let text = include_str!("../../../tests/fixtures/group-file-v2.json");
    let fixture: GroupFile = serde_json::from_str(text).unwrap();
    let s = store(tmp.path(), true);
    assert_eq!(s.commit("main", 0, put(leaf("ws-1"))), Ok(1));
    assert_eq!(s.commit("main", 1, put(leaf("ws-2"))), Ok(2));
    let written = Change::Put {
        owner: fixture.owner,
        root: fixture.root.clone(),
    };
    assert_eq!(s.commit("main", 2, written), Ok(fixture.rev));
    let path = file_of(tmp.path(), "main");
    let bytes = std::fs::read(&path).unwrap();
    let before = snapshot(tmp.path());

    call_every_entry_point_flag_off(tmp.path());
    assert_eq!(store(tmp.path(), false).load("main").unwrap().file, fixture);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(snapshot(tmp.path()), before);

    let on = store(tmp.path(), true).load("main").unwrap();
    assert_eq!(on.file, fixture);
    assert!(on.dropped.is_empty());
}
