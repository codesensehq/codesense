// SPDX-License-Identifier: MIT
//! The kit ops: the Rust twins of the tiling kit's tree functions (`src/shared/tiling/
//! mosaic-tree.ts`), one per variant of `KitOp` (`src/shared/tiling/kit-op.ts`).
//!
//! A window sends its gesture as ops, not as a tree, so the store can rebase it onto a newer
//! head. [`parse_op`] checks an op's shape and [`apply`] runs it, each the twin of
//! `kitOpProblem` and `applyKitOp` in `src/shared/tiling/apply-kit-op.ts`. One table,
//! `tests/fixtures/kit-ops.json`, holds the cases both sides must agree on. Every tile ref is
//! the kit's opaque leaf id; the store checks the tree an op leaves with the leaf-id grammar.
//!
//! An op that can't run on a tree (its leaf or split is gone, or its new leaf is already
//! placed) is an [`OpFailed`] naming its tile keys, so a rebase onto a newer head can tell a
//! failed op from one that applied. Closing a leaf that is gone and placing one already there
//! do nothing and succeed, as two windows doing the same thing should.

use super::shape::{Axis, SavedNode};
use serde_json::Value;

/// The longest path an op names, and the largest index in it.
const PATH_MAX: usize = 64;
const INDEX_MAX: f64 = 4096.0;

/// Which side of its target a split puts the new leaf on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Before,
    After,
}

/// The kit's `TilePlacementTarget`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub leaf_id: String,
    pub axis: Axis,
    pub side: Side,
}

/// One kit op. `Pin` and `Unpin` are the window's pins, not tree ops; [`apply`] refuses them.
#[derive(Debug, Clone, PartialEq)]
pub enum KitOp {
    /// `appendLeaf`.
    Place {
        leaf_id: String,
    },
    /// `splitAt`.
    SplitAt {
        target_leaf_id: String,
        axis: Axis,
        side: Side,
        leaf_id: String,
    },
    /// `moveLeaf`.
    Move {
        leaf_id: String,
        target: Target,
    },
    /// `pruneLeaf`.
    Close {
        leaf_id: String,
    },
    /// `setNodeSizes`.
    Resize {
        path: Vec<usize>,
        sizes: Vec<f64>,
    },
    /// `swapLeaves`.
    Swap {
        a: String,
        b: String,
    },
    /// `evenSizes`.
    EvenOut {
        path: Option<Vec<usize>>,
    },
    /// `replaceLeafWorkspaceId`.
    Replace {
        from: String,
        to: String,
    },
    Pin {
        leaf_id: String,
    },
    Unpin {
        leaf_id: String,
    },
}

/// An op that can't run on the tree it was given; nothing changed.
#[derive(Debug, Clone, PartialEq)]
pub struct OpFailed {
    pub keys: Vec<String>,
}

/// The op `value` holds, or why it isn't one. The twin of `kitOpProblem`.
pub fn parse_op(value: &Value) -> Result<KitOp, String> {
    let object = value.as_object().ok_or("an op is an object")?;
    let kind = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or("an op names its kind in \"op\"")?;
    let (required, optional): (&[&str], &[&str]) = match kind {
        "place" | "close" | "pin" | "unpin" => (&["leafId"], &[]),
        "splitAt" => (&["targetLeafId", "axis", "side", "leafId"], &[]),
        "move" => (&["leafId", "target"], &[]),
        "resize" => (&["path", "sizes"], &[]),
        "swap" => (&["a", "b"], &[]),
        "evenOut" => (&[], &["path"]),
        "replace" => (&["from", "to"], &[]),
        other => return Err(format!("{other:?} is not a kit op")),
    };
    if let Some(key) = Iterator::find(&mut object.keys(), |k| {
        *k != "op" && !required.contains(&&***k) && !optional.contains(&&***k)
    }) {
        return Err(format!("a {kind} op has no {key:?}"));
    }
    if let Some(key) = Iterator::find(&mut required.iter(), |k| !object.contains_key(**k)) {
        return Err(format!("a {kind} op needs {key:?}"));
    }
    let id = |key: &str| ref_at(object.get(key), key);
    Ok(match kind {
        "place" => KitOp::Place {
            leaf_id: id("leafId")?,
        },
        "close" => KitOp::Close {
            leaf_id: id("leafId")?,
        },
        "pin" => KitOp::Pin {
            leaf_id: id("leafId")?,
        },
        "unpin" => KitOp::Unpin {
            leaf_id: id("leafId")?,
        },
        "splitAt" => KitOp::SplitAt {
            target_leaf_id: id("targetLeafId")?,
            axis: axis_at(object.get("axis"))?,
            side: side_at(object.get("side"))?,
            leaf_id: id("leafId")?,
        },
        "move" => KitOp::Move {
            leaf_id: id("leafId")?,
            target: target_at(object.get("target"))?,
        },
        "resize" => KitOp::Resize {
            path: path_at(object.get("path"))?,
            sizes: sizes_at(object.get("sizes"))?,
        },
        "swap" => KitOp::Swap {
            a: id("a")?,
            b: id("b")?,
        },
        "evenOut" => KitOp::EvenOut {
            path: object.get("path").map(|p| path_at(Some(p))).transpose()?,
        },
        _ => KitOp::Replace {
            from: id("from")?,
            to: id("to")?,
        },
    })
}

fn ref_at(value: Option<&Value>, key: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !str::is_empty(s))
        .map(str::to_string)
        .ok_or_else(|| format!("{key:?} is a non-empty tile ref"))
}

fn axis_at(value: Option<&Value>) -> Result<Axis, String> {
    match value.and_then(Value::as_str) {
        Some("row") => Ok(Axis::Row),
        Some("column") => Ok(Axis::Column),
        _ => Err("\"axis\" is \"row\" or \"column\"".into()),
    }
}

fn side_at(value: Option<&Value>) -> Result<Side, String> {
    match value.and_then(Value::as_str) {
        Some("before") => Ok(Side::Before),
        Some("after") => Ok(Side::After),
        _ => Err("\"side\" is \"before\" or \"after\"".into()),
    }
}

fn target_at(value: Option<&Value>) -> Result<Target, String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or("\"target\" is an object")?;
    if object
        .keys()
        .any(|k| !matches!(&**k, "targetWorkspaceId" | "axis" | "side"))
        || object.len() != 3
    {
        return Err("\"target\" holds targetWorkspaceId, axis and side".into());
    }
    Ok(Target {
        leaf_id: ref_at(object.get("targetWorkspaceId"), "targetWorkspaceId")?,
        axis: axis_at(object.get("axis"))?,
        side: side_at(object.get("side"))?,
    })
}

/// An index path: at most [`PATH_MAX`] whole numbers from 0 to [`INDEX_MAX`]. A JSON number is
/// read as a float, as the TS side reads it, so `1.0` is the index 1 on both.
fn path_at(value: Option<&Value>) -> Result<Vec<usize>, String> {
    let items = value
        .and_then(Value::as_array)
        .filter(|items| items.len() <= PATH_MAX)
        .ok_or("\"path\" is a list of at most 64 indexes")?;
    items
        .iter()
        .map(|item| {
            item.as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= INDEX_MAX)
                .map(|n| n as usize)
                .ok_or_else(|| "a path index is a whole number from 0 to 4096".to_string())
        })
        .collect()
}

/// A split's sizes: two or more finite numbers of 0 or more.
fn sizes_at(value: Option<&Value>) -> Result<Vec<f64>, String> {
    let items = value
        .and_then(Value::as_array)
        .filter(|items| items.len() >= 2)
        .ok_or("\"sizes\" is a list of two or more sizes")?;
    items
        .iter()
        .map(|item| {
            item.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .ok_or_else(|| "a size is a finite number, 0 or more".to_string())
        })
        .collect()
}

/// The tile keys `op` touches on `root`: the leaves it names, and for a resize or an even-out
/// every leaf under the split it changes.
pub fn touched_keys(root: Option<&SavedNode>, op: &KitOp) -> Vec<String> {
    let under = |path: &[usize]| {
        root.and_then(|root| node_at(root, path))
            .map(leaf_ids)
            .unwrap_or_default()
    };
    match op {
        KitOp::Place { leaf_id }
        | KitOp::Close { leaf_id }
        | KitOp::Pin { leaf_id }
        | KitOp::Unpin { leaf_id } => vec![leaf_id.clone()],
        KitOp::SplitAt {
            target_leaf_id,
            leaf_id,
            ..
        } => vec![target_leaf_id.clone(), leaf_id.clone()],
        KitOp::Move { leaf_id, target } => vec![leaf_id.clone(), target.leaf_id.clone()],
        KitOp::Swap { a, b } => vec![a.clone(), b.clone()],
        KitOp::Replace { from, to } => vec![from.clone(), to.clone()],
        KitOp::Resize { path, .. } => under(path),
        KitOp::EvenOut { path } => under(path.as_deref().unwrap_or(&[])),
    }
}

/// `root` after `op`, as the kit computes it. The twin of `applyKitOp`.
pub fn apply(root: Option<SavedNode>, op: &KitOp) -> Result<Option<SavedNode>, OpFailed> {
    if !can_apply(root.as_ref(), op) {
        return Err(OpFailed {
            keys: touched_keys(root.as_ref(), op),
        });
    }
    Ok(match op {
        KitOp::Place { leaf_id } => Some(append_leaf(root, leaf_id)),
        KitOp::Close { leaf_id } => root.and_then(|r| prune_leaf(r, leaf_id)),
        KitOp::SplitAt {
            target_leaf_id,
            axis,
            side,
            leaf_id,
        } => root.map(|r| split_at(r, target_leaf_id, *axis, *side, leaf_id)),
        KitOp::Move { leaf_id, target } => root.map(|r| move_leaf(r, leaf_id, target)),
        KitOp::Resize { path, sizes } => root.map(|r| set_node_sizes(r, path, sizes)),
        KitOp::Swap { a, b } => root.map(|r| swap_leaves(r, a, b)),
        KitOp::EvenOut { path: None } => root.map(even_all),
        KitOp::EvenOut { path: Some(path) } => root.map(|r| even_at(r, path)),
        KitOp::Replace { from, to } if from == to => root,
        KitOp::Replace { from, to } => root.and_then(|r| replace_leaf(r, from, to)),
        KitOp::Pin { .. } | KitOp::Unpin { .. } => root,
    })
}

/// Whether `op` can run on `root`: the leaves and the split it names are there, and a leaf it
/// adds by splitting or replacing is not placed yet. A pin is never a tree op.
fn can_apply(root: Option<&SavedNode>, op: &KitOp) -> bool {
    let has = |id: &str| root.is_some_and(|r| find_leaf_path(r, id).is_some());
    let split_at_path = |path: &[usize]| root.and_then(|r| node_at(r, path)).and_then(split_len);
    match op {
        KitOp::Pin { .. } | KitOp::Unpin { .. } => false,
        KitOp::Place { .. } | KitOp::Close { .. } => true,
        KitOp::SplitAt {
            target_leaf_id,
            leaf_id,
            ..
        } => has(target_leaf_id) && !has(leaf_id),
        KitOp::Move { leaf_id, target } => has(leaf_id) && has(&target.leaf_id),
        KitOp::Resize { path, sizes } => split_at_path(path) == Some(sizes.len()),
        KitOp::Swap { a, b } => has(a) && has(b),
        KitOp::EvenOut { path: None } => true,
        KitOp::EvenOut { path: Some(path) } => split_at_path(path).is_some(),
        KitOp::Replace { from, to } => from == to || (has(from) && !has(to)),
    }
}

/// A split's child count; `None` for a leaf.
fn split_len(node: &SavedNode) -> Option<usize> {
    match node {
        SavedNode::Split { children, .. } => Some(children.len()),
        SavedNode::Leaf { .. } => None,
    }
}

fn leaf(id: &str) -> SavedNode {
    SavedNode::Leaf {
        id: id.to_string(),
        workspace_id: id.to_string(),
    }
}

fn leaf_id(node: &SavedNode) -> Option<&str> {
    match node {
        SavedNode::Leaf { id, .. } => Some(id),
        SavedNode::Split { .. } => None,
    }
}

/// In-order leaf ids.
fn leaf_ids(node: &SavedNode) -> Vec<String> {
    match node {
        SavedNode::Leaf { id, .. } => vec![id.clone()],
        SavedNode::Split { children, .. } => children.iter().flat_map(leaf_ids).collect(),
    }
}

fn even_split(n: usize) -> Vec<f64> {
    vec![100.0 / n as f64; n]
}

/// The kit's `normalizeSizes`: scaled to sum 100, an even split when they sum to 0.
fn normalize_sizes(sizes: &[f64]) -> Vec<f64> {
    if <[f64]>::is_empty(sizes) {
        return vec![];
    }
    let sum = sizes.iter().fold(0.0, |a, b| a + b);
    if sum <= 0.0 {
        return even_split(sizes.len());
    }
    sizes.iter().map(|s| s / sum * 100.0).collect()
}

fn same_sizes(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && Iterator::all(&mut a.iter().zip(b), |(x, y)| (x - y).abs() < 1e-9)
}

fn find_leaf_path(node: &SavedNode, id: &str) -> Option<Vec<usize>> {
    match node {
        SavedNode::Leaf { id: at, .. } => (at == id).then(Vec::new),
        SavedNode::Split { children, .. } => {
            Iterator::enumerate(children.iter()).find_map(|(i, c)| {
                find_leaf_path(c, id).map(|mut sub| {
                    sub.insert(0, i);
                    sub
                })
            })
        }
    }
}

fn node_at<'a>(node: &'a SavedNode, path: &[usize]) -> Option<&'a SavedNode> {
    let mut at = node;
    for i in path {
        let SavedNode::Split { children, .. } = at else {
            return None;
        };
        at = children.get(*i)?;
    }
    Some(at)
}

/// The kit's `replaceAt`: put `next` at `path` (or drop the slot), collapsing a split left with
/// one child and renormalizing the sizes of every split on the path.
fn replace_at(node: SavedNode, path: &[usize], next: Option<SavedNode>) -> Option<SavedNode> {
    let Some((&head, rest)) = path.split_first() else {
        return next;
    };
    let SavedNode::Split {
        axis,
        children,
        sizes,
    } = node
    else {
        return Some(node);
    };
    let count = children.len();
    let mut kept = vec![];
    let mut kept_sizes = vec![];
    for (i, child) in Iterator::enumerate(children.into_iter()) {
        let size = sizes.get(i).copied().unwrap_or(100.0 / count as f64);
        let child = if i == head {
            replace_at(child, rest, next.clone())
        } else {
            Some(child)
        };
        if let Some(child) = child {
            kept.push(child);
            kept_sizes.push(size);
        }
    }
    match kept.len() {
        0 => None,
        1 => kept.pop(),
        _ => Some(SavedNode::Split {
            axis,
            children: kept,
            sizes: normalize_sizes(&kept_sizes),
        }),
    }
}

/// The kit's `withNodeAt`: put `next` at `path`, keeping every size off the path.
fn with_node_at(node: SavedNode, path: &[usize], next: SavedNode) -> SavedNode {
    let Some((&head, rest)) = path.split_first() else {
        return next;
    };
    match node {
        SavedNode::Split {
            axis,
            mut children,
            sizes,
        } if head < children.len() => {
            let child = children.remove(head);
            children.insert(head, with_node_at(child, rest, next));
            SavedNode::Split {
                axis,
                children,
                sizes,
            }
        }
        other => other,
    }
}

/// The kit's `appendLeaf`.
fn append_leaf(root: Option<SavedNode>, id: &str) -> SavedNode {
    let Some(root) = root else {
        return leaf(id);
    };
    if find_leaf_path(&root, id).is_some() {
        return root;
    }
    match root {
        SavedNode::Leaf { .. } => SavedNode::Split {
            axis: Axis::Row,
            children: vec![root, leaf(id)],
            sizes: vec![50.0, 50.0],
        },
        SavedNode::Split {
            axis, mut children, ..
        } => {
            children.push(leaf(id));
            let sizes = even_split(children.len());
            SavedNode::Split {
                axis,
                children,
                sizes,
            }
        }
    }
}

/// The kit's `pruneLeaf`.
fn prune_leaf(root: SavedNode, id: &str) -> Option<SavedNode> {
    match find_leaf_path(&root, id) {
        None => Some(root),
        Some(path) if Vec::is_empty(&path) => None,
        Some(path) => replace_at(root, &path, None),
    }
}

/// The kit's `splitAt`.
fn split_at(root: SavedNode, target: &str, axis: Axis, side: Side, id: &str) -> SavedNode {
    let Some(path) = find_leaf_path(&root, target) else {
        return root;
    };
    if let Some((&idx, parent_path)) = path.split_last() {
        if let Some(SavedNode::Split {
            axis: parent_axis,
            children,
            sizes,
        }) = node_at(&root, parent_path)
        {
            if *parent_axis == axis {
                let mut children = children.clone();
                let mut sizes = sizes.clone();
                let slot = sizes
                    .get(idx)
                    .copied()
                    .unwrap_or(100.0 / children.len() as f64);
                let insert = if side == Side::Before { idx } else { idx + 1 };
                children.insert(insert, leaf(id));
                sizes[idx] = slot / 2.0;
                sizes.insert(insert, slot / 2.0);
                let next = SavedNode::Split {
                    axis,
                    children,
                    sizes: normalize_sizes(&sizes),
                };
                let parent_path = parent_path.to_vec();
                return replace_at(root, &parent_path, Some(next.clone())).unwrap_or(next);
            }
        }
    }
    let Some(target_node) = node_at(&root, &path).cloned() else {
        return root;
    };
    let children = match side {
        Side::Before => vec![leaf(id), target_node],
        Side::After => vec![target_node, leaf(id)],
    };
    let wrapped = SavedNode::Split {
        axis,
        children,
        sizes: vec![50.0, 50.0],
    };
    replace_at(root, &path, Some(wrapped.clone())).unwrap_or(wrapped)
}

/// The kit's `sameMosaicStructure`: equal nesting, axes and leaf order, sizes ignored.
fn same_structure(a: &SavedNode, b: &SavedNode) -> bool {
    match (a, b) {
        (SavedNode::Leaf { .. }, SavedNode::Leaf { .. }) => leaf_id(a) == leaf_id(b),
        (
            SavedNode::Split {
                axis: ax,
                children: ac,
                ..
            },
            SavedNode::Split {
                axis: bx,
                children: bc,
                ..
            },
        ) => {
            ax == bx
                && ac.len() == bc.len()
                && Iterator::all(&mut ac.iter().zip(bc), |(x, y)| same_structure(x, y))
        }
        _ => false,
    }
}

/// The kit's `moveLeaf`.
fn move_leaf(root: SavedNode, id: &str, target: &Target) -> SavedNode {
    if id == target.leaf_id {
        return root;
    }
    let Some(pruned) = prune_leaf(root.clone(), id) else {
        return root;
    };
    if find_leaf_path(&pruned, &target.leaf_id).is_none() {
        return root;
    }
    let next = split_at(pruned, &target.leaf_id, target.axis, target.side, id);
    if same_structure(&next, &root) {
        root
    } else {
        next
    }
}

/// The kit's `setNodeSizes`.
fn set_node_sizes(root: SavedNode, path: &[usize], sizes: &[f64]) -> SavedNode {
    let Some(SavedNode::Split {
        axis,
        children,
        sizes: current,
    }) = node_at(&root, path)
    else {
        return root;
    };
    if sizes.len() != children.len() {
        return root;
    }
    let next = normalize_sizes(sizes);
    if same_sizes(&next, current) {
        return root;
    }
    let node = SavedNode::Split {
        axis: *axis,
        children: children.clone(),
        sizes: next,
    };
    with_node_at(root, path, node)
}

/// The kit's `swapLeaves`.
fn swap_leaves(root: SavedNode, a: &str, b: &str) -> SavedNode {
    if a == b {
        return root;
    }
    let (Some(path_a), Some(path_b)) = (find_leaf_path(&root, a), find_leaf_path(&root, b)) else {
        return root;
    };
    with_node_at(with_node_at(root, &path_a, leaf(b)), &path_b, leaf(a))
}

/// The kit's `evenSizes` with a path.
fn even_at(root: SavedNode, path: &[usize]) -> SavedNode {
    let Some(SavedNode::Split {
        axis,
        children,
        sizes,
    }) = node_at(&root, path)
    else {
        return root;
    };
    let even = even_split(children.len());
    if same_sizes(&even, sizes) {
        return root;
    }
    let node = SavedNode::Split {
        axis: *axis,
        children: children.clone(),
        sizes: even,
    };
    with_node_at(root, path, node)
}

/// The kit's `evenSizes` with no path: every split.
fn even_all(root: SavedNode) -> SavedNode {
    match root {
        SavedNode::Leaf { .. } => root,
        SavedNode::Split { axis, children, .. } => {
            let children: Vec<SavedNode> = children.into_iter().map(even_all).collect();
            let sizes = even_split(children.len());
            SavedNode::Split {
                axis,
                children,
                sizes,
            }
        }
    }
}

/// The kit's `replaceLeafWorkspaceId`.
fn replace_leaf(root: SavedNode, from: &str, to: &str) -> Option<SavedNode> {
    match find_leaf_path(&root, from) {
        None => Some(root),
        Some(path) => replace_at(root, &path, Some(leaf(to))),
    }
}

#[cfg(test)]
#[path = "ops_tests.rs"]
mod tests;
