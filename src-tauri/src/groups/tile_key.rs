// SPDX-License-Identifier: MIT
//! The keys a group file's arrangement is held by, the Rust twin of
//! `src/shared/tiling/tile-key.ts`.
//!
//! - [`tab_key`]: a viewer tab, the window registry's [`ItemKey`] of kind `tab` from the tab's
//!   path verbatim. A layout key only; it is not a tile ref.
//! - [`tile_key`]: a tile, the kit's opaque leaf id as it is, once the store's leaf-id grammar
//!   ([`leaf_ref_problem`]) admits it in `layer`. There is no second grammar here.
//!
//! Both sides read the same fixtures: `windows/fixtures/item-keys.json` for tab keys and the
//! `tiles` rows of `tests/fixtures/leaf-keys.json` for tile keys.

use super::leaf_id::{leaf_ref_problem, Layer};
use crate::windows::item_key::ItemKey;

/// The `kind` of a viewer tab's key, as `TAB_ITEM_KIND` in `src/shared/windows/item-key.ts`.
const TAB_ITEM_KIND: &str = "tab";

/// The key of the tab at `path` in `openTabs[team]`.
pub fn tab_key(team: &str, path: &str) -> ItemKey {
    ItemKey {
        kind: String::from(TAB_ITEM_KIND),
        team: String::from(team),
        id: String::from(path),
    }
}

/// The key of the tile whose leaf id is `leaf`, or why `leaf` can't be stored in `layer`.
pub fn tile_key(leaf: &str, layer: Layer) -> Result<String, String> {
    match leaf_ref_problem(leaf, layer) {
        Some(why) => Err(why),
        None => Ok(String::from(leaf)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::groups::shape::SavedNode;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct ItemKeyRow {
        name: String,
        key: ItemKey,
    }

    #[derive(Deserialize)]
    struct ItemKeys {
        keys: Vec<ItemKeyRow>,
    }

    #[derive(Deserialize)]
    struct RefRow {
        leaf: String,
        layer: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct TileRow {
        leaf: SavedNode,
        layer: String,
        key: String,
    }

    #[derive(Deserialize)]
    struct LeafKeys {
        refs: Vec<RefRow>,
        tiles: Vec<TileRow>,
    }

    fn item_keys() -> ItemKeys {
        serde_json::from_str(include_str!("../windows/fixtures/item-keys.json")).unwrap()
    }

    fn leaf_keys() -> LeafKeys {
        serde_json::from_str(include_str!("../../../tests/fixtures/leaf-keys.json")).unwrap()
    }

    fn layer(name: &str) -> Layer {
        match name {
            "private" => Layer::Private,
            "shared" => Layer::Shared,
            other => panic!("unknown layer {other}"),
        }
    }

    #[test]
    fn every_tab_row_of_the_item_key_fixture_is_its_tab_key() {
        let rows: Vec<_> = item_keys()
            .keys
            .into_iter()
            .filter(|r| r.key.kind == TAB_ITEM_KIND)
            .collect();
        for id in [
            "a.md?x=1&session=2",
            "a.md?session=2&x=1",
            "virtual://agents",
            "my%20notes.md",
        ] {
            assert!(rows.iter().any(|r| r.key.id == id), "no tab row for {id}");
        }
        for row in rows {
            assert_eq!(
                tab_key(&row.key.team, &row.key.id),
                row.key,
                "row {}",
                row.name
            );
        }
    }

    #[test]
    fn every_tile_row_reads_back_as_its_key() {
        let rows = leaf_keys().tiles;
        for prefix in ["agent:", "doc:", "generic:"] {
            assert!(
                rows.iter().any(|r| r.key.starts_with(prefix)),
                "no {prefix} row"
            );
        }
        assert!(rows.iter().any(|r| !r.key.contains(':')), "no local id row");
        for row in rows {
            let SavedNode::Leaf { id, workspace_id } = row.leaf else {
                panic!("{}: a tile row holds a leaf", row.key);
            };
            assert_eq!(id, workspace_id, "{}", row.key);
            assert_eq!(tile_key(&id, layer(&row.layer)), Ok(row.key));
        }
    }

    #[test]
    fn a_ref_the_grammar_refuses_has_no_tile_key() {
        for row in leaf_keys().refs {
            let key = tile_key(&row.leaf, layer(&row.layer));
            assert_eq!(
                key.is_ok(),
                row.valid,
                "{:?} in {}: {key:?}",
                row.leaf,
                row.layer
            );
            if let Ok(key) = key {
                assert_eq!(key, row.leaf);
            }
        }
    }
}
