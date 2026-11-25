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
    #[allow(dead_code)] // The routine gate reads it.
    pub record: Option<String>,
    /// The go record in force; `None` when running or when a malformed newest
    /// record is what pauses the team. Only the tests read it.
    #[allow(dead_code)]
    pub go: Option<String>,
    /// The newest record's `reason`, or why it couldn't be read.
    #[allow(dead_code)] // The routine gate reads it.
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
    let reason = field("reason").and_then(Value::as_str).map(str::to_owned);
    let read = match (at, field("paused").and_then(flag)) {
        (None, _) => Err(format!("at is {}, not epoch ms", shown(field("at")))),
        (Some(_), None) => Err(format!(
            "unrecognised paused value {}",
            shown(field("paused"))
        )),
        (Some(_), Some(paused)) => Ok(Entry {
            paused,
            resumes: field("resumes").and_then(text).unwrap_or_default(),
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
        Value::String(s) if s.trim().eq_ignore_ascii_case("true") => Some(true),
        Value::String(s) if s.trim().eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

/// A string or number as trimmed text; anything else is none.
fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
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
    // The newest is never its own resume, so the rest are all `ended` needs.
    let Some(newest) = rows.pop() else {
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
            let Ok(name) = std::ffi::OsString::into_string(entry.file_name()) else {
                return None;
            };
            let id = name
                .strip_suffix(".md")
                .filter(|_| !name.starts_with('.'))?;
            // A file that can't be read parses as empty frontmatter: no `at`, so
            // it sorts newest and pauses the team.
            let raw = std::fs::read_to_string(folder.join(&name)).unwrap_or_default();
            Some(parse(id, &raw))
        })
        .collect();
    fold(&records)
}

#[cfg(test)]
pub(crate) use fixtures::write_team_control;

// In a test module so the guard that counts direct team-folder reads sees only
// the reader's.
#[cfg(test)]
mod fixtures {
    use std::path::Path;

    use super::COLLECTION;
    use crate::domain::Principal;

    /// Write `records` (`(id, frontmatter)` pairs) into a team's `team-control`
    /// folder, as the pause writer would.
    pub(crate) fn write_team_control(
        home: &Path,
        principal: &Principal,
        org: &str,
        team: &str,
        records: &[(&str, &str)],
    ) -> std::path::PathBuf {
        let org_root =
            crate::context_repo::path_to_org_root(home, principal, org).expect("org root");
        let folder =
            crate::context_repo::path_to_team_content_dir(&org_root, team).join(COLLECTION);
        std::fs::create_dir_all(&folder).unwrap();
        for (id, frontmatter) in records {
            std::fs::write(
                folder.join(format!("{id}.md")),
                format!("---\n{frontmatter}\n---\n"),
            )
            .unwrap();
        }
        folder
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const CASES: &str = include_str!("../../tests/fixtures/team_pause/cases.json");

    #[derive(Deserialize)]
    struct Cases {
        source: Source,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Source {
        repo: String,
        path: String,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        records: Vec<CaseRecord>,
        expect: Expect,
    }

    #[derive(Deserialize)]
    struct CaseRecord {
        id: String,
        frontmatter: String,
    }

    #[derive(Deserialize, Debug, PartialEq)]
    struct Expect {
        paused: bool,
        go: Option<String>,
    }

    fn cases() -> Cases {
        serde_json::from_str(CASES).expect("cases.json parses")
    }

    fn file(frontmatter: &str) -> String {
        format!("---\n{frontmatter}\n---\n")
    }

    fn got(state: &TeamPause) -> Expect {
        Expect {
            paused: state.paused,
            go: state.go.clone(),
        }
    }

    fn principal() -> Principal {
        Principal::from(42u64)
    }

    fn pairs(case: &Case) -> Vec<(&str, &str)> {
        case.records
            .iter()
            .map(|r| (r.id.as_str(), r.frontmatter.as_str()))
            .collect()
    }

    const GO: (&str, &str) = ("go-1", "id: go-1\npaused: \"true\"\nat: 100");
    const RESUME: (&str, &str) = (
        "resume-1",
        "id: resume-1\npaused: \"false\"\nat: 200\nresumes: go-1",
    );

    #[test]
    fn every_shared_case_folds_as_expected() {
        let cases = cases().cases;
        assert!(cases.len() >= 12, "{} cases", cases.len());
        for case in &cases {
            let records: Vec<Record> = case
                .records
                .iter()
                .map(|r| parse(&r.id, &file(&r.frontmatter)))
                .collect();
            assert_eq!(got(&fold(&records)), case.expect, "case {}", case.name);
        }
    }

    #[test]
    fn io_half_matches_fold() {
        for case in &cases().cases {
            let home = tempfile::tempdir().unwrap();
            write_team_control(home.path(), &principal(), "acme", "crew", &pairs(case));
            let records: Vec<Record> = case
                .records
                .iter()
                .map(|r| parse(&r.id, &file(&r.frontmatter)))
                .collect();
            let read = team_pause(home.path(), &principal(), "acme", "crew");
            assert_eq!(read, fold(&records), "case {}", case.name);
            assert_eq!(got(&read), case.expect, "case {}", case.name);
        }
    }

    #[test]
    fn no_team_folder_is_running() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            team_pause(home.path(), &principal(), "acme", "crew"),
            TeamPause::default()
        );
        // Another team's pause doesn't reach this one.
        write_team_control(home.path(), &principal(), "acme", "other", &[GO]);
        assert!(!team_pause(home.path(), &principal(), "acme", "crew").paused);
        assert!(team_pause(home.path(), &principal(), "acme", "other").paused);
    }

    #[test]
    fn unresolvable_org_root_is_running() {
        let home = tempfile::tempdir().unwrap();
        write_team_control(home.path(), &principal(), "acme", "crew", &[GO]);
        // A registry that can't be read makes the org root unresolvable.
        let registry =
            crate::context_repo::context_attachments::registry_path(home.path(), &principal());
        std::fs::write(&registry, "attachments: [unclosed\n").unwrap();
        assert!(crate::context_repo::path_to_org_root(home.path(), &principal(), "acme").is_err());
        assert_eq!(
            team_pause(home.path(), &principal(), "acme", "crew"),
            TeamPause::default()
        );
    }

    #[test]
    fn non_md_files_ignored() {
        let home = tempfile::tempdir().unwrap();
        let folder = write_team_control(home.path(), &principal(), "acme", "crew", &[GO, RESUME]);
        let go_again = file("id: go-2\npaused: \"true\"\nat: 300");
        std::fs::write(folder.join("go-2.md.bak"), &go_again).unwrap();
        std::fs::write(folder.join("go-2.txt"), &go_again).unwrap();
        std::fs::write(folder.join(".go-2.md"), &go_again).unwrap();
        std::fs::write(folder.join("README"), "not a record").unwrap();
        let state = team_pause(home.path(), &principal(), "acme", "crew");
        assert!(!state.paused, "{state:?}");
        assert_eq!(state.record.as_deref(), Some("resume-1"));
    }

    #[test]
    fn reads_fresh_each_call() {
        let home = tempfile::tempdir().unwrap();
        write_team_control(home.path(), &principal(), "acme", "crew", &[GO]);
        let first = team_pause(home.path(), &principal(), "acme", "crew");
        assert!(first.paused);
        assert_eq!(first.go.as_deref(), Some("go-1"));
        write_team_control(home.path(), &principal(), "acme", "crew", &[RESUME]);
        let second = team_pause(home.path(), &principal(), "acme", "crew");
        assert!(!second.paused, "{second:?}");
        assert_eq!(second.record.as_deref(), Some("resume-1"));
    }

    #[test]
    fn cases_json_has_source_pin() {
        let source = cases().source;
        assert_eq!(source.repo, "codesensehq/codesense");
        assert_eq!(
            source.path,
            "src-tauri/tests/fixtures/team_pause/cases.json"
        );
        let here = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(&source.path);
        assert_eq!(std::fs::read_to_string(here).unwrap(), CASES);
    }

    #[test]
    fn reason_comes_from_the_newest_record() {
        let records = [parse(
            "go-1",
            &file("id: go-1\npaused: true\nat: 100\nreason: upgrade"),
        )];
        assert_eq!(fold(&records).reason.as_deref(), Some("upgrade"));
        let records = [parse("odd-1", &file("id: odd-1\npaused: maybe\nat: 100"))];
        let state = fold(&records);
        assert!(state.paused);
        assert!(state
            .reason
            .unwrap()
            .starts_with("record odd-1: unrecognised paused value"));
    }

    /// Only this file names the collection in the app's source.
    #[test]
    fn only_team_pause_reads_team_control() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let needle = format!("\"{COLLECTION}\"");
        let mut naming: Vec<String> = walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
            .filter(|e| std::fs::read_to_string(e.path()).is_ok_and(|text| text.contains(&needle)))
            .map(|e| {
                e.path()
                    .strip_prefix(&src)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        naming.sort();
        assert_eq!(naming, ["context_repo/team_pause.rs"]);
    }
}
