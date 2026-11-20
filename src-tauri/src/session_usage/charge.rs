// SPDX-License-Identifier: MIT
//! Charges: a session's usage counted to a story from a moment on.
//!
//! A kept seat that starts another story, or a lead that moves on to its next one, is charged to
//! that story, so its cost splits between the stories it worked. A charge names the launch's
//! CodeSense session id (its tab) and the moment it starts: usage at or after `from_ms`, until the
//! tab's next charge, counts to its story, and usage before the first charge keeps the story it
//! resolves to. A second charge at the same moment replaces the story. The usage report splits a
//! charged session into one row per segment, the span between two charges.
//!
//! The table is additive (no schema version), like `session_story`.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use super::record::SessionRecord;
use super::{db_err, session_read, Filter, StoryResolver, UsageReport, UsageStore, UsageStory};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS session_story_charge (
    tab_session_id     TEXT NOT NULL,
    from_ms            INTEGER NOT NULL,
    story_id           TEXT NOT NULL,
    org                TEXT,
    team               TEXT,
    charged_by         TEXT,
    charged_by_session TEXT NOT NULL,
    charged_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (tab_session_id, from_ms)
);";

/// One charge of a tab: from `from_ms` on, its usage counts to `story_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Charge {
    pub story_id: String,
    pub from_ms: i64,
    /// The org and team of the charged session, which the story belongs to.
    pub org: Option<String>,
    pub team: Option<String>,
    /// The handle of the seat that charged it, when it has one.
    pub charged_by: Option<String>,
    /// The verified tab of the seat that charged it.
    pub charged_by_session: String,
    pub charged_at_ms: i64,
}

/// Every tab's charges, each tab's oldest first.
pub(crate) type Charges = HashMap<String, Vec<Charge>>;

const CHARGE_COLUMNS: &str =
    "tab_session_id, story_id, from_ms, org, team, charged_by, charged_by_session, charged_at_ms";

fn charge_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, Charge)> {
    Ok((
        r.get(0)?,
        Charge {
            story_id: r.get(1)?,
            from_ms: r.get(2)?,
            org: r.get(3)?,
            team: r.get(4)?,
            charged_by: r.get(5)?,
            charged_by_session: r.get(6)?,
            charged_at_ms: r.get(7)?,
        },
    ))
}

/// Where the segment that starts at `from` (`None`: before the first charge) ends: the next
/// charge's start, or `None` for the open last segment.
pub(super) fn segment_end(charges: &[Charge], from: Option<i64>) -> Option<i64> {
    charges
        .iter()
        .map(|c| c.from_ms)
        .find(|at| from.is_none_or(|from| *at > from))
}

/// The story a charge names, with its title, status and epic from the story file of its org.
/// `basis` is `charged`, which counts as exact.
pub(super) fn charged_story(stories: &mut StoryResolver, charge: &Charge) -> UsageStory {
    let source = stories.source_in_org(&charge.story_id, charge.org.as_deref());
    UsageStory {
        basis: Some("charged"),
        ..stories.story(&charge.story_id, source.as_deref())
    }
}

/// The story a session works now: its last charge's story (its open last segment), else the
/// story of its newest usage row.
pub(crate) fn current_story(
    report: &UsageReport,
    charges: &[Charge],
    stories: &mut StoryResolver,
) -> Option<UsageStory> {
    match charges.last() {
        Some(charge) => Some(charged_story(stories, charge)),
        None => report.latest_story().cloned(),
    }
}

impl UsageStore {
    /// Charge `tab` to the charge's story from its `from_ms` on. A charge at a moment the tab
    /// already has replaces that one.
    pub(crate) fn charge_story(&self, tab: &str, charge: &Charge) -> Result<(), String> {
        // An upsert, not `INSERT OR REPLACE`: a replaced row fires the update trigger with the old
        // story, so both stories' totals are marked (a REPLACE's delete would fire no trigger).
        self.conn
            .execute(
                "INSERT INTO session_story_charge (tab_session_id, from_ms, story_id, org, team, charged_by,
                    charged_by_session, charged_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (tab_session_id, from_ms) DO UPDATE SET
                    story_id = excluded.story_id, org = excluded.org, team = excluded.team,
                    charged_by = excluded.charged_by, charged_by_session = excluded.charged_by_session,
                    charged_at_ms = excluded.charged_at_ms",
                params![
                    tab,
                    charge.from_ms,
                    charge.story_id,
                    charge.org,
                    charge.team,
                    charge.charged_by,
                    charge.charged_by_session,
                    charge.charged_at_ms,
                ],
            )
            .map(|_| ())
            .map_err(db_err)
    }

    /// The charges of `tab`, oldest first.
    pub fn charges_for(&self, tab: &str) -> Result<Vec<Charge>, String> {
        let mut stmt = self
            .conn
            .prepare_cached(&format!(
                "SELECT {CHARGE_COLUMNS} FROM session_story_charge WHERE tab_session_id = ?1 ORDER BY from_ms"
            ))
            .map_err(db_err)?;
        let rows = stmt.query_map(params![tab], charge_of).map_err(db_err)?;
        rows.map(|row| row.map(|(_, charge)| charge).map_err(db_err)).collect()
    }

    /// Every tab's charges, for a report.
    pub(super) fn all_charges(&self) -> Result<Charges, String> {
        let mut stmt = self
            .conn
            .prepare_cached(&format!(
                "SELECT {CHARGE_COLUMNS} FROM session_story_charge ORDER BY tab_session_id, from_ms"
            ))
            .map_err(db_err)?;
        let rows = stmt.query_map([], charge_of).map_err(db_err)?;
        let mut charges = Charges::new();
        for row in rows {
            let (tab, charge) = row.map_err(db_err)?;
            charges.entry(tab).or_default().push(charge);
        }
        Ok(charges)
    }

    /// The session that held `handle` at `at_ms`: of the records that had taken that handle by
    /// then (when the record was first written, or when its handle last changed), the latest. A
    /// handle is reused, so a later holder never stands for an earlier one.
    pub(crate) fn handle_holder(&self, handle: &str, at_ms: i64) -> Result<Option<SessionRecord>, String> {
        let id: Option<String> = self
            .conn
            .query_row(
                "SELECT session_id FROM session_record
                 WHERE handle = ?1 AND COALESCE(handle_at_ms, recorded_at_ms) <= ?2
                 ORDER BY COALESCE(handle_at_ms, recorded_at_ms) DESC, session_id DESC LIMIT 1",
                params![handle, at_ms],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        match id {
            Some(id) => self.read_session_record(&id),
            None => Ok(None),
        }
    }

    /// When `session`'s usage starts: its earliest usage event under any of its ids.
    pub(crate) fn first_usage_ms(&self, session: &str) -> Result<Option<i64>, String> {
        let ids = serde_json::to_string(&self.event_session_ids(session)?).map_err(|e| e.to_string())?;
        self.conn
            .query_row(
                "SELECT MIN(at_ms) FROM usage_event WHERE session_id IN (SELECT value FROM json_each(?1))",
                params![ids],
                |r| r.get(0),
            )
            .map_err(db_err)
    }

    /// The story id `session` worked at each of `times`: the charge in force then, else the story
    /// its usage before its first charge resolves to, else its launch record's story. Its charges
    /// and that earlier story are each read once.
    pub(crate) fn story_ids_at(
        &self,
        session: &str,
        times: &[i64],
        stories: &mut StoryResolver,
    ) -> Result<Vec<Option<String>>, String> {
        let identity = session_read::resolve_session(self, None, session)?;
        let charges = self.charges_for(&identity.session_id)?;
        let mut before_charges: Option<Option<String>> = None;
        let mut found = Vec::with_capacity(times.len());
        for &at_ms in times {
            if let Some(charge) = charges.iter().rev().find(|c| c.from_ms <= at_ms) {
                found.push(Some(charge.story_id.clone()));
                continue;
            }
            if before_charges.is_none() {
                let report = self.report_with(
                    &Filter {
                        session_id: Some(identity.session_id.clone()),
                        ..Default::default()
                    },
                    stories,
                )?;
                let story = report
                    .sessions
                    .iter()
                    .filter(|s| s.segment.is_none_or(|segment| segment.from_ms.is_none()))
                    .find_map(|s| s.story.as_ref().map(|story| story.id.clone()))
                    .or_else(|| identity.record.as_ref().and_then(|r| r.story_id.clone()));
                before_charges = Some(story);
            }
            found.push(before_charges.clone().flatten());
        }
        Ok(found)
    }
}
