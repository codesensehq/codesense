// SPDX-License-Identifier: MIT
//! The kit ops' table (`tests/fixtures/kit-ops.json`), read here and by the Vitest of
//! `apply-kit-op.ts`: every op's shape and what every op does to a tree.

use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct ShapeRow {
    name: String,
    op: Value,
    valid: bool,
}

#[derive(Deserialize)]
struct ApplyRow {
    name: String,
    before: Option<SavedNode>,
    op: Value,
    #[serde(default)]
    after: Option<SavedNode>,
    #[serde(default)]
    fails: bool,
}

#[derive(Deserialize)]
struct Fixture {
    shapes: Vec<ShapeRow>,
    apply: Vec<ApplyRow>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../../../tests/fixtures/kit-ops.json")).unwrap()
}

/// Two trees equal but for float noise in their sizes.
fn same_tree(a: &Option<SavedNode>, b: &Option<SavedNode>) -> bool {
    fn same(a: &SavedNode, b: &SavedNode) -> bool {
        match (a, b) {
            (SavedNode::Leaf { .. }, SavedNode::Leaf { .. }) => a == b,
            (
                SavedNode::Split {
                    axis: ax,
                    children: ac,
                    sizes: as_,
                },
                SavedNode::Split {
                    axis: bx,
                    children: bc,
                    sizes: bs,
                },
            ) => {
                ax == bx
                    && same_sizes(as_, bs)
                    && ac.len() == bc.len()
                    && ac.iter().zip(bc).all(|(x, y)| same(x, y))
            }
            _ => false,
        }
    }
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same(a, b),
        _ => false,
    }
}

#[test]
fn every_shape_row_is_accepted_or_refused_as_listed() {
    let rows = fixture().shapes;
    let kinds = [
        "place", "splitAt", "move", "close", "resize", "swap", "evenOut", "replace", "pin", "unpin",
    ];
    for kind in kinds {
        assert!(
            rows.iter().any(|r| r.valid && r.op["op"] == kind),
            "the table accepts a {kind} op"
        );
    }
    for row in rows {
        let parsed = parse_op(&row.op);
        assert_eq!(parsed.is_ok(), row.valid, "{}: {parsed:?}", row.name);
    }
}

#[test]
fn every_apply_row_leaves_the_tree_the_kit_leaves() {
    let rows = fixture().apply;
    assert!(
        rows.len() >= 30,
        "the table holds a row per op and per failure"
    );
    for row in rows {
        let op = parse_op(&row.op).unwrap_or_else(|e| panic!("{}: {e}", row.name));
        let result = apply(row.before.clone(), &op);
        if row.fails {
            assert!(result.is_err(), "{} fails: {result:?}", row.name);
        } else {
            let after = result.unwrap_or_else(|e| panic!("{}: {e:?}", row.name));
            assert!(
                same_tree(&after, &row.after),
                "{}: {after:?} != {:?}",
                row.name,
                row.after
            );
        }
    }
}

fn op(value: Value) -> KitOp {
    parse_op(&value).unwrap()
}

fn tree() -> SavedNode {
    serde_json::from_value(serde_json::json!({
        "kind": "split", "axis": "row", "sizes": [40, 60], "children": [
            {"kind": "leaf", "id": "ws-a", "workspaceId": "ws-a"},
            {"kind": "split", "axis": "column", "sizes": [30, 70], "children": [
                {"kind": "leaf", "id": "ws-b", "workspaceId": "ws-b"},
                {"kind": "leaf", "id": "ws-c", "workspaceId": "ws-c"}
            ]}
        ]
    }))
    .unwrap()
}

/// A resize or an even-out touches every leaf under its split; the other ops the leaves they
/// name. A failed op reports the same keys.
#[test]
fn an_op_touches_the_keys_it_names_or_the_leaves_under_its_split() {
    let root = Some(tree());
    let keys = |value| touched_keys(root.as_ref(), &op(value));
    assert_eq!(
        keys(serde_json::json!({"op": "resize", "path": [1], "sizes": [1, 1]})),
        ["ws-b", "ws-c"]
    );
    assert_eq!(
        keys(serde_json::json!({"op": "evenOut"})),
        ["ws-a", "ws-b", "ws-c"]
    );
    assert_eq!(
        keys(serde_json::json!({"op": "swap", "a": "ws-a", "b": "ws-c"})),
        ["ws-a", "ws-c"]
    );
    assert_eq!(
        keys(serde_json::json!({"op": "move", "leafId": "ws-a",
            "target": {"targetWorkspaceId": "ws-b", "axis": "row", "side": "after"}})),
        ["ws-a", "ws-b"]
    );
    let failed = apply(
        root.clone(),
        &op(serde_json::json!({"op": "swap", "a": "ws-a", "b": "ws-x"})),
    );
    assert_eq!(
        failed,
        Err(OpFailed {
            keys: vec!["ws-a".into(), "ws-x".into()]
        })
    );
}

/// A JSON index written as `1.0` reads as the index 1, as it does in TS.
#[test]
fn a_whole_float_index_is_an_index() {
    assert_eq!(
        op(serde_json::json!({"op": "evenOut", "path": [1.0]})),
        KitOp::EvenOut {
            path: Some(vec![1])
        }
    );
}
