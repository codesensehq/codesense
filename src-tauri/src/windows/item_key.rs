// SPDX-License-Identifier: MIT
//! `ItemKey`: one key shape for "a thing a window shows".
//!
//! A key is `{kind, team, id}`. The only kind defined today is `tab`: a viewer tab in
//! `main`'s `openTabs`, where `team` is the `openTabs` bucket key and `id` is the tab's
//! path exactly as the store holds it. Rust never interprets `kind`; it is an opaque
//! namespace, so an unknown kind round-trips unchanged.
//!
//! The canonical string is the compact JSON array `["<kind>","<team>","<id>"]`, which
//! `serde_json` and the renderer's `JSON.stringify` write identically. Both sides read
//! the shared fixture `fixtures/item-keys.json` (`src/shared/windows/item-key.ts`).

use serde::{Deserialize, Serialize};

/// A thing a window shows. Two keys are the same item exactly when all three strings
/// are equal: no decoding, no query sorting, no case folding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ItemKey {
    pub kind: String,
    pub team: String,
    pub id: String,
}

impl ItemKey {
    /// The canonical string, `["<kind>","<team>","<id>"]`.
    pub fn canonical(&self) -> String {
        serde_json::to_string(&(&self.kind, &self.team, &self.id))
            .expect("a tuple of strings always serializes")
    }

    /// Parses a canonical string back into its key.
    #[cfg(test)]
    pub fn from_canonical(s: &str) -> Result<Self, serde_json::Error> {
        let (kind, team, id): (String, String, String) = serde_json::from_str(s)?;
        Ok(Self { kind, team, id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Row {
        name: String,
        key: ItemKey,
        canonical: String,
    }

    #[derive(Deserialize)]
    struct Fixture {
        keys: Vec<Row>,
        distinct: Vec<(String, String)>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("fixtures/item-keys.json")).expect("fixture parses")
    }

    #[test]
    fn every_fixture_row_writes_its_canonical_string() {
        for row in fixture().keys {
            assert_eq!(row.key.canonical(), row.canonical, "row {}", row.name);
        }
    }

    #[test]
    fn every_canonical_string_round_trips_to_its_key() {
        for row in fixture().keys {
            let parsed = ItemKey::from_canonical(&row.canonical).expect(&row.name);
            assert_eq!(parsed, row.key, "row {}", row.name);
        }
    }

    #[test]
    fn distinct_rows_never_share_a_key() {
        let f = fixture();
        let find = |name: &str| {
            f.keys
                .iter()
                .find(|r| r.name == name)
                .unwrap_or_else(|| panic!("no fixture row named {name}"))
        };
        for (a, b) in &f.distinct {
            let (a, b) = (find(a), find(b));
            assert_ne!(a.key, b.key, "{} vs {}", a.name, b.name);
            assert_ne!(a.canonical, b.canonical, "{} vs {}", a.name, b.name);
        }
    }

    #[test]
    fn an_unknown_kind_round_trips_unchanged_through_ipc_json() {
        let key = ItemKey {
            kind: "not-yet-defined".into(),
            team: "acme:docs".into(),
            id: "x".into(),
        };
        let wire = serde_json::to_string(&key).unwrap();
        assert_eq!(
            wire,
            r#"{"kind":"not-yet-defined","team":"acme:docs","id":"x"}"#
        );
        assert_eq!(serde_json::from_str::<ItemKey>(&wire).unwrap(), key);
    }
}
