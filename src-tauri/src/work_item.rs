// SPDX-License-Identifier: MIT
//! Work items: the one piece of work a lead launch starts, shared by every session below it.
//!
//! A work item is minted when an agent session or a routine run starts and its launcher has
//! none (a person, the Foreman, a routine, or an agent outside a work item). A launch by a session that has
//! one inherits it, a restore keeps the id it had and never mints, and a plain shell never
//! gets one. [`resolve_for_launch`] is the one place that rule lives, and
//! [`WorkItemId::mint`] is private to this module so no other code can make an id.

use serde::{Deserialize, Serialize};

/// The id prefix every work item carries.
const PREFIX: &str = "wi_";
/// Hex digits after the prefix.
const DIGITS: usize = 16;

/// A work item's id: `wi_` and 16 lowercase hex digits.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct WorkItemId(String);

impl WorkItemId {
    /// A new, random id. Only [`resolve_for_launch`] calls it.
    fn mint() -> Self {
        let bits: u64 = rand::random();
        WorkItemId(format!("{PREFIX}{bits:0width$x}", width = DIGITS))
    }

    /// The id a record or a caller wrote, when it is well formed.
    pub fn parse(raw: &str) -> Option<Self> {
        let digits = raw.strip_prefix(PREFIX)?;
        (digits.len() == DIGITS
            && str::bytes(digits).all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| WorkItemId(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for WorkItemId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for WorkItemId {
    type Error = String;
    fn try_from(raw: String) -> Result<Self, Self::Error> {
        WorkItemId::parse(&raw).ok_or_else(|| format!("not a work item id: {raw}"))
    }
}

impl From<WorkItemId> for String {
    fn from(id: WorkItemId) -> Self {
        id.0
    }
}

/// Read a record's optional work item, as none when it is malformed, so one bad id never
/// fails the whole record it sits in. For `#[serde(deserialize_with)]`, with `default`.
pub fn deserialize_lenient<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WorkItemId>, D::Error> {
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .and_then(WorkItemId::parse))
}

/// What a work item records: its team, the lead that started it, the sprint it belongs to
/// and the context worktree it works in. Written on the context worktree's record and on
/// the session record of every session in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: WorkItemId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// The lead's session: the one whose launch minted the work item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_session: Option<String>,
    /// The lead's named agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprint_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_worktree: Option<String>,
}

/// How a launch reaches the registry, for [`resolve_for_launch`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind<'a> {
    /// A new session.
    Fresh,
    /// A session coming back after a restart, with the work item it had (if any).
    Restoring(Option<&'a WorkItemId>),
}

/// The work item a launch records.
///
/// - A restore keeps the id it had, and never mints.
/// - A plain shell (`names_an_agent` false) never has one.
/// - An agent launched by a session that has a work item inherits it.
/// - Any other agent launch (a person, the Foreman, a routine, or an agent outside a
///   work item) mints a new one.
pub fn resolve_for_launch(
    launcher: Option<&WorkItemId>,
    names_an_agent: bool,
    kind: LaunchKind<'_>,
) -> Option<WorkItemId> {
    match kind {
        LaunchKind::Restoring(kept) => kept.cloned(),
        LaunchKind::Fresh if !names_an_agent => None,
        LaunchKind::Fresh => Some(launcher.cloned().unwrap_or_else(WorkItemId::mint)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(raw: &str) -> WorkItemId {
        WorkItemId::parse(raw).unwrap()
    }

    #[test]
    fn minted_ids_are_well_formed_and_distinct() {
        let a = WorkItemId::mint();
        let b = WorkItemId::mint();
        assert_eq!(WorkItemId::parse(a.as_str()), Some(a.clone()));
        assert_eq!(a.as_str().len(), PREFIX.len() + DIGITS);
        assert_ne!(a, b);
    }

    #[test]
    fn a_malformed_work_item_reads_as_none_and_keeps_its_record() {
        #[derive(Deserialize)]
        struct Record {
            #[serde(default, deserialize_with = "deserialize_lenient")]
            work_item: Option<WorkItemId>,
            name: String,
        }
        for (raw, expected) in [
            (
                serde_json::json!({"work_item": "wi_00000000000000a1", "name": "a"}),
                Some(id("wi_00000000000000a1")),
            ),
            (serde_json::json!({"work_item": "not-an-id", "name": "a"}), None),
            (serde_json::json!({"work_item": 7, "name": "a"}), None),
            (serde_json::json!({"work_item": null, "name": "a"}), None),
            (serde_json::json!({"name": "a"}), None),
        ] {
            let record: Record = serde_json::from_value(raw.clone()).unwrap();
            assert_eq!(record.work_item, expected, "{raw}");
            assert_eq!(record.name, "a");
        }
    }

    #[test]
    fn parse_refuses_anything_else() {
        for raw in [
            "",
            "wi_",
            "wi_00000000000000a",
            "wi_00000000000000a1f",
            "wi_00000000000000A1",
            "WI_00000000000000a1",
            "wx_00000000000000a1",
            "wi_00000000000000g1",
        ] {
            assert_eq!(WorkItemId::parse(raw), None, "{raw}");
        }
        assert!(WorkItemId::parse("wi_00000000000000a1").is_some());
    }

    #[test]
    fn serde_round_trips_and_refuses_a_bad_id() {
        let wi = id("wi_00000000000000a1");
        let json = serde_json::to_string(&wi).unwrap();
        assert_eq!(json, "\"wi_00000000000000a1\"");
        assert_eq!(serde_json::from_str::<WorkItemId>(&json).unwrap(), wi);
        assert!(serde_json::from_str::<WorkItemId>("\"nope\"").is_err());
    }

    /// The mint rule, one row per kind of launch.
    #[test]
    fn the_mint_rule() {
        let parent = id("wi_00000000000000a1");
        let kept = id("wi_00000000000000b2");
        enum Want {
            None,
            Mint,
            Is(WorkItemId),
        }
        let rows: Vec<(&str, Option<&WorkItemId>, bool, LaunchKind<'_>, Want)> = vec![
            (
                "plain shell by a person",
                None,
                false,
                LaunchKind::Fresh,
                Want::None,
            ),
            (
                "plain shell by an agent in a work item",
                Some(&parent),
                false,
                LaunchKind::Fresh,
                Want::None,
            ),
            (
                "agent by a person, the Foreman or a routine",
                None,
                true,
                LaunchKind::Fresh,
                Want::Mint,
            ),
            (
                "agent by an agent outside a work item",
                None,
                true,
                LaunchKind::Fresh,
                Want::Mint,
            ),
            (
                "agent by an agent in a work item",
                Some(&parent),
                true,
                LaunchKind::Fresh,
                Want::Is(parent.clone()),
            ),
            (
                "restore keeps its id",
                None,
                true,
                LaunchKind::Restoring(Some(&kept)),
                Want::Is(kept.clone()),
            ),
            (
                "restore under a launcher keeps its own id",
                Some(&parent),
                true,
                LaunchKind::Restoring(Some(&kept)),
                Want::Is(kept.clone()),
            ),
            (
                "restore of a session with none never mints",
                None,
                true,
                LaunchKind::Restoring(None),
                Want::None,
            ),
            (
                "restored shell keeps none",
                None,
                false,
                LaunchKind::Restoring(None),
                Want::None,
            ),
        ];
        for (name, launcher, agent, kind, want) in rows {
            let got = resolve_for_launch(launcher, agent, kind);
            match want {
                Want::None => assert_eq!(got, None, "{name}"),
                Want::Is(expected) => assert_eq!(got, Some(expected), "{name}"),
                Want::Mint => {
                    let got = got.unwrap_or_else(|| panic!("{name}: minted nothing"));
                    assert_ne!(Some(&got), launcher, "{name}");
                    assert_ne!(got, parent, "{name}");
                    assert_ne!(got, kept, "{name}");
                }
            }
        }
    }
}
