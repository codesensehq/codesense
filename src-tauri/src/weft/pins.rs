// SPDX-License-Identifier: MIT
//! The pin list of an agent thread. A thread is keyed by the saved agent and the story
//! its session was launched with, so every session of that agent on that story names
//! the same list. A pin is a message of this store; message ids are per store, so the
//! store a pin lives in is the team half of its key. A pin whose message is archived or
//! withdrawn stays in the table but drops out of [`pins_list`], and returns if the
//! message is restored.

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::sqlite::{write_audit_public, WvValidation, WvWriteResult};
use super::store::WeftStore;

const PINS: &str = "wv_pins";

/// The thread a pin list belongs to: the saved agent id and the story id (empty when the
/// session was launched with no story).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadKey {
    pub agent_id: String,
    pub story_id: String,
}

impl ThreadKey {
    pub fn new(agent_id: &str, story_id: Option<&str>) -> WvWriteResult<Self> {
        let agent_id = agent_id.trim();
        if agent_id.is_empty() {
            return Err(invalid("a pin thread needs a saved agent id"));
        }
        Ok(Self {
            agent_id: agent_id.to_owned(),
            story_id: story_id.map(str::trim).unwrap_or_default().to_owned(),
        })
    }
}

/// One live pin of a thread, in its place in the list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub message_id: i64,
    pub position: u32,
    pub pinned_by: String,
    pub pinned_at_ms: i64,
}

/// What a pin or unpin call did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PinOutcome {
    Pinned,
    Unpinned,
    /// The pin was already there (a pin) or already gone (an unpin).
    Unchanged,
}

fn invalid(msg: &str) -> super::sqlite::WvWriteError {
    WvValidation(msg.to_string()).into()
}

const LIVE: &str = "EXISTS (SELECT 1 FROM wv_inbox m WHERE m.id = p.message_id \
                    AND m.archived_at IS NULL AND m.withdrawn_at IS NULL)";

/// The thread's pinned message ids in list order: live ones first, then those whose
/// message is archived or withdrawn (kept so a restore brings them back in place).
fn ordered(tx: &Transaction, thread: &ThreadKey) -> WvWriteResult<(Vec<i64>, Vec<i64>)> {
    let mut stmt = tx.prepare_cached(&format!(
        "SELECT p.message_id, {LIVE} FROM wv_pins p \
         WHERE p.agent_id = ?1 AND p.story_id = ?2 ORDER BY p.position, p.id"
    ))?;
    let rows = stmt
        .query_map(params![thread.agent_id, thread.story_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let (live, gone): (Vec<_>, Vec<_>) = rows.into_iter().partition(|(_, live)| *live);
    Ok((
        live.into_iter().map(|(id, _)| id).collect(),
        gone.into_iter().map(|(id, _)| id).collect(),
    ))
}

/// Number the thread's pins 0.. in `order`, auditing each row whose place moved.
fn renumber(tx: &Transaction, thread: &ThreadKey, order: &[i64]) -> WvWriteResult<()> {
    for (position, message_id) in order.iter().enumerate() {
        let row: Option<(i64, i64)> = tx
            .query_row(
                "SELECT id, position FROM wv_pins \
                 WHERE agent_id = ?1 AND story_id = ?2 AND message_id = ?3",
                params![thread.agent_id, thread.story_id, message_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, old)) = row {
            if old != position as i64 {
                tx.execute(
                    "UPDATE wv_pins SET position = ?2 WHERE id = ?1",
                    params![id, position as i64],
                )?;
                write_audit_public(tx, PINS, "mutate", id)?;
            }
        }
    }
    Ok(())
}

/// Pin message `message_id` into `thread` at `position` among its live pins (the end
/// when omitted or past it). Refuses a message this store does not hold or that is
/// archived or withdrawn. Pinning a message already pinned leaves it where it is.
pub fn pin_add(
    store: &WeftStore,
    thread: &ThreadKey,
    message_id: i64,
    pinned_by: &str,
    position: Option<u32>,
) -> WvWriteResult<PinOutcome> {
    let pinned_by = pinned_by.trim();
    if pinned_by.is_empty() {
        return Err(invalid("pinned_by is blank"));
    }
    let mut conn = store.conn()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let live = tx
        .query_row(
            "SELECT 1 FROM wv_inbox WHERE id = ?1 AND archived_at IS NULL AND withdrawn_at IS NULL",
            params![message_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !live {
        return Err(invalid(&format!("no message {message_id}")));
    }
    let (mut order, gone) = ordered(&tx, thread)?;
    if order.contains(&message_id) {
        return Ok(PinOutcome::Unchanged);
    }
    tx.execute(
        "INSERT INTO wv_pins (agent_id, story_id, message_id, position, pinned_by, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            thread.agent_id,
            thread.story_id,
            message_id,
            -1,
            pinned_by,
            chrono::Utc::now().timestamp_millis()
        ],
    )?;
    write_audit_public(&tx, PINS, "append", tx.last_insert_rowid())?;
    let at = position.map_or(order.len(), |p| (p as usize).min(order.len()));
    order.insert(at, message_id);
    order.extend(gone);
    renumber(&tx, thread, &order)?;
    tx.commit()?;
    Ok(PinOutcome::Pinned)
}

/// Unpin message `message_id` from `thread`; the pins after it move up.
pub fn pin_remove(
    store: &WeftStore,
    thread: &ThreadKey,
    message_id: i64,
) -> WvWriteResult<PinOutcome> {
    let mut conn = store.conn()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM wv_pins WHERE agent_id = ?1 AND story_id = ?2 AND message_id = ?3",
            params![thread.agent_id, thread.story_id, message_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(PinOutcome::Unchanged);
    };
    tx.execute("DELETE FROM wv_pins WHERE id = ?1", params![id])?;
    write_audit_public(&tx, PINS, "delete", id)?;
    let (mut order, gone) = ordered(&tx, thread)?;
    order.extend(gone);
    renumber(&tx, thread, &order)?;
    tx.commit()?;
    Ok(PinOutcome::Unpinned)
}

/// Put `thread`'s live pins in `message_ids` order. The ids must be exactly the live
/// pins [`pins_list`] returns, each once.
pub fn pins_reorder(
    store: &WeftStore,
    thread: &ThreadKey,
    message_ids: &[i64],
) -> WvWriteResult<()> {
    let mut conn = store.conn()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (live, gone) = ordered(&tx, thread)?;
    let mut asked = message_ids.to_vec();
    asked.sort_unstable();
    let mut held = live.clone();
    held.sort_unstable();
    if asked != held {
        return Err(invalid(
            "messageIds must list every pinned message of the thread exactly once",
        ));
    }
    let mut order = message_ids.to_vec();
    order.extend(gone);
    renumber(&tx, thread, &order)?;
    tx.commit()?;
    Ok(())
}

/// `thread`'s live pins in list order, numbered from 0.
pub fn pins_list(store: &WeftStore, thread: &ThreadKey) -> WvWriteResult<Vec<Pin>> {
    let conn = store.conn()?;
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT p.message_id, p.pinned_by, p.created_at FROM wv_pins p \
         WHERE p.agent_id = ?1 AND p.story_id = ?2 AND {LIVE} ORDER BY p.position, p.id"
    ))?;
    let rows = stmt
        .query_map(params![thread.agent_id, thread.story_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(position, (message_id, pinned_by, pinned_at_ms))| Pin {
            message_id,
            position: position as u32,
            pinned_by,
            pinned_at_ms,
        })
        .collect())
}

/// The threads that pin any of `message_ids`, so a change to those messages can
/// refresh their lists.
pub fn pin_threads_for(store: &WeftStore, message_ids: &[i64]) -> WvWriteResult<Vec<ThreadKey>> {
    const CHUNK: usize = 500;
    let conn = store.conn()?;
    let mut found = std::collections::BTreeSet::new();
    for ids in message_ids.chunks(CHUNK) {
        let marks = vec!["?"; ids.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT agent_id, story_id FROM wv_pins WHERE message_id IN ({marks})"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
            Ok(ThreadKey {
                agent_id: r.get(0)?,
                story_id: r.get(1)?,
            })
        })?;
        for row in rows {
            found.insert(row?);
        }
    }
    Ok(found.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weft::inbox::{inbox_insert, inbox_mark_archived_many, inbox_unarchive_many};

    fn open_temp() -> (tempfile::TempDir, WeftStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = WeftStore::open(dir.path().join("weft.sqlite3")).unwrap();
        (dir, store)
    }

    fn message(store: &WeftStore) -> i64 {
        inbox_insert(
            store, "agent-a", "human", "a view", None, None, None, None, None,
        )
        .unwrap()
    }

    fn thread(story: Option<&str>) -> ThreadKey {
        ThreadKey::new("team/claude-dev", story).unwrap()
    }

    fn ids(store: &WeftStore, thread: &ThreadKey) -> Vec<i64> {
        pins_list(store, thread)
            .unwrap()
            .iter()
            .map(|p| p.message_id)
            .collect()
    }

    #[test]
    fn a_thread_needs_an_agent_and_defaults_its_story_to_empty() {
        assert!(ThreadKey::new(" ", Some("DEMO-1")).is_err());
        assert_eq!(ThreadKey::new("a", None).unwrap().story_id, "");
        assert_eq!(
            ThreadKey::new(" a ", Some(" DEMO-1 ")).unwrap().story_id,
            "DEMO-1"
        );
    }

    #[test]
    fn pins_append_insert_at_a_position_and_number_from_zero() {
        let (_d, store) = open_temp();
        let t = thread(Some("DEMO-1"));
        let (a, b, c) = (message(&store), message(&store), message(&store));
        assert_eq!(
            pin_add(&store, &t, a, "human", None).unwrap(),
            PinOutcome::Pinned
        );
        pin_add(&store, &t, b, "human", None).unwrap();
        pin_add(&store, &t, c, "human", Some(0)).unwrap();
        assert_eq!(ids(&store, &t), vec![c, a, b]);
        let positions: Vec<u32> = pins_list(&store, &t)
            .unwrap()
            .iter()
            .map(|p| p.position)
            .collect();
        assert_eq!(positions, vec![0, 1, 2]);
        let d = message(&store);
        pin_add(&store, &t, d, "human", Some(99)).unwrap();
        assert_eq!(ids(&store, &t), vec![c, a, b, d]);
    }

    #[test]
    fn pinning_twice_is_unchanged_and_keeps_its_place() {
        let (_d, store) = open_temp();
        let t = thread(None);
        let (a, b) = (message(&store), message(&store));
        pin_add(&store, &t, a, "human", None).unwrap();
        pin_add(&store, &t, b, "human", None).unwrap();
        assert_eq!(
            pin_add(&store, &t, a, "human", Some(5)).unwrap(),
            PinOutcome::Unchanged
        );
        assert_eq!(ids(&store, &t), vec![a, b]);
    }

    #[test]
    fn unpin_closes_the_gap_and_a_second_unpin_is_unchanged() {
        let (_d, store) = open_temp();
        let t = thread(None);
        let (a, b, c) = (message(&store), message(&store), message(&store));
        for id in [a, b, c] {
            pin_add(&store, &t, id, "human", None).unwrap();
        }
        assert_eq!(pin_remove(&store, &t, b).unwrap(), PinOutcome::Unpinned);
        assert_eq!(pin_remove(&store, &t, b).unwrap(), PinOutcome::Unchanged);
        let pins = pins_list(&store, &t).unwrap();
        assert_eq!(
            pins.iter()
                .map(|p| (p.message_id, p.position))
                .collect::<Vec<_>>(),
            vec![(a, 0), (c, 1)]
        );
    }

    #[test]
    fn reorder_takes_exactly_the_live_pins() {
        let (_d, store) = open_temp();
        let t = thread(None);
        let (a, b, c) = (message(&store), message(&store), message(&store));
        for id in [a, b, c] {
            pin_add(&store, &t, id, "human", None).unwrap();
        }
        pins_reorder(&store, &t, &[c, a, b]).unwrap();
        assert_eq!(ids(&store, &t), vec![c, a, b]);
        for bad in [vec![c, a], vec![c, a, b, b], vec![c, a, 999], vec![]] {
            assert!(pins_reorder(&store, &t, &bad).is_err(), "{bad:?}");
        }
        assert_eq!(ids(&store, &t), vec![c, a, b]);
    }

    #[test]
    fn threads_are_separate_by_agent_and_by_story() {
        let (_d, store) = open_temp();
        let a = message(&store);
        let story_one = thread(Some("DEMO-1"));
        let story_two = thread(Some("DEMO-2"));
        let other_agent = ThreadKey::new("team/codex-dev", Some("DEMO-1")).unwrap();
        pin_add(&store, &story_one, a, "human", None).unwrap();
        assert_eq!(ids(&store, &story_one), vec![a]);
        assert!(ids(&store, &story_two).is_empty());
        assert!(ids(&store, &other_agent).is_empty());
        pin_add(&store, &other_agent, a, "agent-b", None).unwrap();
        assert_eq!(pin_threads_for(&store, &[a]).unwrap(), {
            let mut both = vec![story_one, other_agent];
            both.sort();
            both
        });
    }

    #[test]
    fn unknown_archived_and_withdrawn_messages_are_refused() {
        let (_d, store) = open_temp();
        let t = thread(None);
        assert!(pin_add(&store, &t, 999, "human", None).is_err());
        let a = message(&store);
        assert!(pin_add(&store, &t, a, " ", None).is_err());
        inbox_mark_archived_many(&store, &[a]).unwrap();
        assert!(pin_add(&store, &t, a, "human", None).is_err());
        let to_agent = inbox_insert(
            &store, "human", "agent-a", "hi", None, None, None, None, None,
        )
        .unwrap();
        crate::weft::role_inbox::withdraw_message(&store, to_agent, 1).unwrap();
        assert!(pin_add(&store, &t, to_agent, "human", None).is_err());
    }

    #[test]
    fn an_archived_or_withdrawn_pin_drops_out_and_a_restore_brings_it_back_in_place() {
        let (_d, store) = open_temp();
        let t = thread(None);
        let (a, b, c) = (message(&store), message(&store), message(&store));
        for id in [a, b, c] {
            pin_add(&store, &t, id, "human", None).unwrap();
        }
        inbox_mark_archived_many(&store, &[b]).unwrap();
        assert_eq!(ids(&store, &t), vec![a, c]);
        let positions: Vec<u32> = pins_list(&store, &t)
            .unwrap()
            .iter()
            .map(|p| p.position)
            .collect();
        assert_eq!(positions, vec![0, 1]);
        // A reorder names only the live pins; the archived one keeps its row.
        pins_reorder(&store, &t, &[c, a]).unwrap();
        inbox_unarchive_many(&store, &[b], &[]).unwrap();
        assert_eq!(ids(&store, &t), vec![c, a, b]);

        let to_agent = inbox_insert(
            &store, "human", "agent-a", "hi", None, None, None, None, None,
        )
        .unwrap();
        pin_add(&store, &t, to_agent, "human", Some(0)).unwrap();
        crate::weft::role_inbox::withdraw_message(&store, to_agent, 1).unwrap();
        assert_eq!(ids(&store, &t), vec![c, a, b]);
    }

    #[test]
    fn pins_survive_a_restart_of_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weft.sqlite3");
        let t = thread(Some("DEMO-1"));
        let (a, b) = {
            let store = WeftStore::open(&path).unwrap();
            let (a, b) = (message(&store), message(&store));
            pin_add(&store, &t, a, "human", None).unwrap();
            pin_add(&store, &t, b, "agent-a", Some(0)).unwrap();
            (a, b)
        };
        let reopened = WeftStore::open(&path).unwrap();
        let pins = pins_list(&reopened, &t).unwrap();
        assert_eq!(
            pins.iter()
                .map(|p| (p.message_id, p.position, p.pinned_by.as_str()))
                .collect::<Vec<_>>(),
            vec![(b, 0, "agent-a"), (a, 1, "human")]
        );
    }
}
