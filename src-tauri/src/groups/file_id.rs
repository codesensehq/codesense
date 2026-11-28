// SPDX-License-Identifier: MIT
//! The group file a window layout lives in: the twin of `layoutFileRef` in
//! `src/shared/stores/layout-store-client.ts`. Both read `tests/fixtures/group-file-ids.json`, so
//! a window and a writer here name the same file.

use sha2::{Digest, Sha256};

/// Hex digits of the sha-256 kept in a file id.
const ID_HEX: usize = 32;

fn digest(text: &str) -> String {
    let hex = format!("{:x}", Sha256::digest(text.as_bytes()));
    hex[..ID_HEX].to_string()
}

/// The id of the file holding `team_key`'s foreground: flat when `rail_key` is `None`, else that
/// rail's (the ungrouped rail is `Some("")`).
pub fn foreground_file_id(team_key: &str, rail_key: Option<&str>) -> String {
    let text = match rail_key {
        None => team_key.to_string(),
        Some(rail) => format!("{team_key}\n{rail}"),
    };
    format!("fg-{}", digest(&text))
}

/// The id of the file holding the tab grid of the workspace with store key `workspace_key`.
pub fn tab_grid_file_id(workspace_key: &str) -> String {
    format!("ws-{}", digest(workspace_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn every_row_names_the_file_the_window_names() {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("../../../tests/fixtures/group-file-ids.json"))
                .unwrap();
        assert!(rows.len() >= 4);
        for row in rows {
            let target = &row["target"];
            let (owner, id) = match Value::as_str(&target["kind"]) {
                Some("foreground") => (
                    "group",
                    foreground_file_id(
                        Value::as_str(&target["teamKey"]).unwrap(),
                        Value::as_str(&target["railKey"]),
                    ),
                ),
                Some("tabGrid") => (
                    "workspace",
                    tab_grid_file_id(Value::as_str(&target["workspaceKey"]).unwrap()),
                ),
                other => panic!("no target kind {other:?}"),
            };
            assert_eq!(row["file"]["owner"], owner, "{target}");
            assert_eq!(row["file"]["id"], id, "{target}");
        }
    }

    #[test]
    fn a_flat_foreground_and_the_ungrouped_rail_are_two_files() {
        assert_ne!(
            foreground_file_id("acme:app", None),
            foreground_file_id("acme:app", Some(""))
        );
    }
}
