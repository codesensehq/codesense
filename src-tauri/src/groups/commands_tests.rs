// SPDX-License-Identifier: MIT
//! The window's group commands over a store: the replies' wire shapes, the read of an absent, a
//! deleted and a saved file, and the flag-off refusal.

use super::*;
use crate::domain::Principal;
use crate::groups::store::Change;
use serde_json::json;
use tempfile::tempdir;

fn store(home: &std::path::Path, tiles: bool) -> GroupStore {
    GroupStore::at(home, &Principal::from(42u64), "acme/ctx", tiles).unwrap()
}

fn main_file() -> GroupFileRef {
    serde_json::from_value(json!({"owner": "group", "id": "main"})).unwrap()
}

fn place(id: &str) -> serde_json::Value {
    json!({"op": "place", "leafId": id})
}

fn reply(value: Result<CommitReply, String>) -> serde_json::Value {
    serde_json::to_value(value.unwrap()).unwrap()
}

#[test]
fn a_commit_replies_with_its_rev_and_a_read_returns_the_tree() {
    let home = tempdir().unwrap();
    let s = store(home.path(), true);
    assert_eq!(read(&s, &main_file()), Ok(None));
    assert_eq!(
        reply(commit(&s, "main", &main_file(), 0, &[place("ws-a")])),
        json!({"rev": 1})
    );
    let head = serde_json::to_value(read(&s, &main_file()).unwrap()).unwrap();
    assert_eq!(
        head,
        json!({"rev": 1, "tree": {"kind": "leaf", "id": "ws-a", "workspaceId": "ws-a"}})
    );
}

/// A deleted file reads as its tombstone's rev with no tree, so a new file continues from it.
#[test]
fn a_deleted_file_reads_as_its_rev_with_no_tree() {
    let home = tempdir().unwrap();
    let s = store(home.path(), true);
    commit(&s, "main", &main_file(), 0, &[place("ws-a")]).unwrap();
    s.commit("main", 1, Change::Delete).unwrap();
    assert_eq!(
        read(&s, &main_file()),
        Ok(Some(GroupHead { rev: 2, tree: None }))
    );
    assert_eq!(
        reply(commit(&s, "main", &main_file(), 2, &[place("ws-b")])),
        json!({"rev": 3})
    );
}

fn agent_writes(s: &GroupStore, base_rev: u64, op: serde_json::Value) {
    let write = StoreWrite {
        writer: Writer::Agent {
            session: "s1".into(),
        },
        base_rev,
        owner: OwnerKind::Group,
        ops: vec![parse_op(&op).unwrap()],
    };
    s.write("main", write).unwrap();
}

/// A second window's failed rebase replies with no `collided`, so the window replays; an
/// agent's collision names the keys, so the window reloads and drops the op.
#[test]
fn a_conflict_names_collided_keys_only_for_an_agent_collision() {
    let home = tempdir().unwrap();
    let s = store(home.path(), true);
    commit(&s, "main", &main_file(), 0, &[place("ws-a"), place("ws-b")]).unwrap();
    let close_b = json!({"op": "close", "leafId": "ws-b"});
    commit(&s, "second", &main_file(), 1, &[close_b]).unwrap();
    let swap_b = json!({"op": "swap", "a": "ws-a", "b": "ws-b"});
    assert_eq!(
        reply(commit(&s, "main", &main_file(), 1, &[swap_b])),
        json!({"conflict": {"currentRevision": 2}})
    );

    agent_writes(&s, 2, place("ws-c"));
    agent_writes(&s, 3, json!({"op": "close", "leafId": "ws-c"}));
    let swap_c = json!({"op": "swap", "a": "ws-a", "b": "ws-c"});
    assert_eq!(
        reply(commit(&s, "main", &main_file(), 3, &[swap_c])),
        json!({"conflict": {"currentRevision": 4, "collided": ["ws-c"]}})
    );
}

/// With the tiles flag off both commands are refused and nothing is made on disk.
#[test]
fn with_tiles_off_both_commands_are_refused() {
    let home = tempdir().unwrap();
    let s = store(home.path(), false);
    assert!(read(&s, &main_file()).is_err());
    assert!(commit(&s, "main", &main_file(), 0, &[place("ws-a")]).is_err());
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
}

/// An op that isn't a kit op, or a file ref with another key, is refused before the store runs.
#[test]
fn a_malformed_op_or_file_ref_is_refused() {
    let home = tempdir().unwrap();
    let s = store(home.path(), true);
    let refused = commit(&s, "main", &main_file(), 0, &[json!({"op": "teleport"})]);
    assert!(refused.unwrap_err().contains("refused"));
    assert_eq!(read(&s, &main_file()), Ok(None));
    assert!(serde_json::from_value::<GroupFileRef>(
        json!({"owner": "group", "id": "main", "x": 1})
    )
    .is_err());
}

fn pins(value: Result<PinsReply, String>) -> serde_json::Value {
    serde_json::to_value(value.unwrap()).unwrap()
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|key| String::from(*key)).collect()
}

/// The pins write's replies on the wire: `{ok: true}`, and `{refused}` for a fourth pin, the
/// flag off and no active org; the read returns what was written, or none with no org.
#[test]
fn the_pins_commands_reply_on_the_wire() {
    let home = tempdir().unwrap();
    let s = store(home.path(), true);
    let three = keys(&["agent:core/dev", "ws-1a2b3c", "tab_7F3e"]);
    assert_eq!(
        pins(write_pins(true, Some(&s), "main", three.clone())),
        json!({"ok": true})
    );
    assert_eq!(read_pins(true, Some(&s), "main"), Ok(three.clone()));

    let mut four = three.clone();
    four.push(String::from("doc:core/notes/plan.md"));
    assert_eq!(
        pins(write_pins(true, Some(&s), "main", four)),
        json!({"refused": "fourth"})
    );
    assert_eq!(
        pins(write_pins(false, Some(&s), "main", keys(&["ws-1a2b3c"]))),
        json!({"refused": "flag-off"})
    );
    let off = store(home.path(), false);
    assert_eq!(
        pins(write_pins(true, Some(&off), "main", keys(&["ws-1a2b3c"]))),
        json!({"refused": "flag-off"})
    );
    assert_eq!(
        pins(write_pins(true, None, "main", keys(&["ws-1a2b3c"]))),
        json!({"refused": "no-org"})
    );
    assert_eq!(read_pins(true, Some(&s), "main"), Ok(three));
    assert_eq!(read_pins(true, None, "main"), Ok(vec![]));
    assert!(read_pins(false, Some(&s), "main").is_err());
}
