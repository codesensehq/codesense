// SPDX-License-Identifier: MIT
//! A team's pause switch: the one reader of its `team-control` records.
//!
//! The records live at `<org root>/<team>/content/team-control/<id>.md`, one per
//! pause or resume, and the folder is append-only. A go record has `paused: true`;
//! a resume has `paused: false` and names the go record it ends in `resumes`. The
//! team is paused when the newest record, by `at` (epoch ms) and then id, is a go
//! record that no readable resume names. A resume ends the go record it names
//! whatever the two `at` values, so a Mac with a slow clock can't lose its resume.
//!
//! No folder, no records or an org root that doesn't resolve means running, so a
//! team that never paused (or a fresh clone) is never frozen. A newest record that
//! can't be read (an `at` that isn't an integer, a `paused` that isn't true or
//! false, frontmatter that doesn't parse) means paused: it fails closed.
//!
//! The folder is read fresh on every call, with no cache, so a resume counts from
//! the next launch. `src-tauri/tests/fixtures/team_pause/cases.json` holds the
//! shared cases this rule must agree with.

use std::path::Path;

use serde_json::Value;

use crate::domain::Principal;
use crate::records::{parse, Record};

/// The records folder under a team's content directory. No other module in the
/// app names it.
const COLLECTION: &str = "team-control";

/// A team's pause state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TeamPause {
    pub paused: bool,
    /// The newest record's id; `None` with no records.
    pub record: Option<String>,
    /// The go record in force; `None` when running or when a malformed newest
    /// record is what pauses the team.
    pub go: Option<String>,
    /// The newest record's `reason`, or why it couldn't be read.
    pub reason: Option<String>,
}

/// One record's fields, or why they couldn't be read.
struct Parsed {
    id: String,
    at: Option<i64>,
    reason: Option<String>,
    read: Result<Entry, String>,
}

struct Entry {
    paused: bool,
    resumes: String,
}

fn parse_record(record: &Record) -> Parsed {
    let field = |key: &str| record.fields.get(key);
    let at = field("at").and_then(epoch_ms);
    let reason = field("reason").and_then(|v| v.as_str()).map(str::to_owned);
    let read = match (at, field("paused").and_then(flag)) {
        (None, _) => Err(format!("at is {}, not epoch ms", shown(field("at")))),
        (Some(_), None) => Err(format!(
            "unrecognised paused value {}",
            shown(field("paused"))
        )),
        (Some(_), Some(paused)) => Ok(Entry {
            paused,
            resumes: field("resumes").map(text).unwrap_or_default(),
        }),
    };
    Parsed {
        id: record.id.clone(),
        at,
        reason,
        read,
    }
}

/// An integer, or a float with no fraction (a JSON number may come back as 100.0).
fn epoch_ms(value: &Value) -> Option<i64> {
    let Value::Number(n) = value else {
        return None;
    };
    n.as_i64().or_else(|| {
        n.as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < i64::MAX as f64)
            .map(|f| f as i64)
    })
}

/// `true`/`false`, as a boolean or as a string in any case.
fn flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// A string or number as trimmed text; anything else is empty.
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "missing".into(), Value::to_string)
}

/// Fold a team's records, in any order, into its pause state.
pub fn fold(records: &[Record]) -> TeamPause {
    let mut rows: Vec<Parsed> = records.iter().map(parse_record).collect();
    // Oldest first by (unreadable `at` last, `at`, id).
    rows.sort_by(|a, b| {
        (a.at.is_none(), a.at.unwrap_or(0), &a.id).cmp(&(b.at.is_none(), b.at.unwrap_or(0), &b.id))
    });
    let Some(newest) = rows.last() else {
        return TeamPause::default();
    };
    let mut state = TeamPause {
        paused: false,
        record: Some(newest.id.clone()),
        go: None,
        reason: newest.reason.clone(),
    };
    match &newest.read {
        Err(why) => {
            state.paused = true;
            state.reason = Some(format!("record {}: {why}", newest.id));
        }
        Ok(entry) if entry.paused => {
            let ended = rows
                .iter()
                .any(|row| matches!(&row.read, Ok(e) if !e.paused && e.resumes == newest.id));
            if !ended {
                state.paused = true;
                state.go = Some(newest.id.clone());
            }
        }
        Ok(_) => {}
    }
    state
}

/// The pause state of `team` in `org`, read fresh from its `team-control` folder.
pub fn team_pause(home: &Path, principal: &Principal, org: &str, team: &str) -> TeamPause {
    let Ok(org_root) = super::path_to_org_root(home, principal, org) else {
        return TeamPause::default();
    };
    let folder = super::path_to_team_content_dir(&org_root, team).join(COLLECTION);
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return TeamPause::default();
    };
    let records: Vec<Record> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name
                .strip_suffix(".md")
                .filter(|_| !name.starts_with('.'))?;
            // A file that can't be read parses as empty frontmatter: no `at`, so
            // it sorts newest and pauses the team.
            let raw = std::fs::read_to_string(entry.path()).unwrap_or_default();
            Some(parse(id, &raw))
        })
        .collect();
    fold(&records)
}
