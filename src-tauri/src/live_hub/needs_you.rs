// SPDX-License-Identifier: MIT
//! The one needs-you set: everything that waits on the person. It holds a question to
//! them, a permission ask, a merge card, and an agent that is capped (paused at a spend
//! cap) or failed. FYI items never count.
//!
//! [`needs_you`] is pure: the hub recomputes it from its sessions, Inbox and spend rows on
//! the same events that refresh them, and every surface that counts what needs the person
//! reads this set, narrowed by place, instead of a predicate of its own.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

pub const TOPIC: &str = "needsYou";

/// What an item asks of the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NeedsYouKind {
    /// A question to them: an Inbox card that is not a merge card, or an open question.
    Question,
    /// An agent waiting on a permission ask.
    Permission,
    /// An Inbox card that offers a PR to merge or send back.
    Merge,
    /// An agent paused at a spend cap.
    Capped,
    /// An agent that failed or crashed.
    Failed,
}

/// One thing that waits on the person. `org`, `team` and `work_item` place it, so a
/// place's view is the set narrowed by them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYouItem {
    pub id: String,
    pub kind: NeedsYouKind,
    /// The session it is about: a card's sender, or the agent itself.
    pub session: String,
    pub org: Option<String>,
    pub team: Option<String>,
    pub work_item: Option<String>,
    /// A question's text, as its Waiting line reads it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// The Inbox card, for a question or merge card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
}

/// A live session as the hub sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionInput {
    pub session: String,
    pub org: Option<String>,
    pub team: Option<String>,
    pub work_item: Option<String>,
    /// The session's `needsYouKind` from [`super::effective_status::select_live_signals`].
    pub needs_you_kind: Option<String>,
    /// The open question's text, when it waits on one.
    pub question: Option<String>,
    /// Whether its agent is paused at a spend cap.
    pub capped: bool,
}

/// An Inbox card to the person that still waits on them: a needs-you card, unread and
/// neither withdrawn nor archived. An FYI card is never an input.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardInput {
    pub message_id: i64,
    pub from: String,
    pub org: Option<String>,
    pub team: Option<String>,
    pub summary: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct NeedsYouInputs {
    pub sessions: Vec<SessionInput>,
    pub cards: Vec<CardInput>,
}

/// The set, one item per id, in id order.
pub fn needs_you(inputs: &NeedsYouInputs) -> Vec<NeedsYouItem> {
    let sessions: BTreeMap<&str, &SessionInput> = inputs
        .sessions
        .iter()
        .map(|s| (&*s.session, s))
        .collect();
    let mut items = BTreeMap::new();
    for card in &inputs.cards {
        let kind = card_kind(card.summary.as_deref(), &card.text);
        let item = NeedsYouItem {
            id: format!("inbox:{}", card.message_id),
            kind,
            session: card.from.clone(),
            org: card.org.clone(),
            team: card.team.clone(),
            work_item: sessions
                .get(&*card.from)
                .and_then(|s| s.work_item.clone()),
            question: (kind == NeedsYouKind::Question)
                .then(|| question_text(card.summary.as_deref(), &card.text)),
            message_id: Some(card.message_id),
        };
        items.insert(item.id.clone(), item);
    }
    for session in &inputs.sessions {
        let agent = |kind: NeedsYouKind, slug: &str, question: Option<String>| NeedsYouItem {
            id: format!("agent:{}:{slug}", session.session),
            kind,
            session: session.session.clone(),
            org: session.org.clone(),
            team: session.team.clone(),
            work_item: session.work_item.clone(),
            question,
            message_id: None,
        };
        let signal = match session.needs_you_kind.as_deref() {
            Some("question") => Some(agent(
                NeedsYouKind::Question,
                "question",
                session.question.clone(),
            )),
            Some("permission") => Some(agent(NeedsYouKind::Permission, "permission", None)),
            Some("failed" | "crashed") => Some(agent(NeedsYouKind::Failed, "failed", None)),
            // `blocked`, `attention` and `startup` are the agent's own state, not an ask.
            _ => None,
        };
        let capped = session
            .capped
            .then(|| agent(NeedsYouKind::Capped, "capped", None));
        for item in signal.into_iter().chain(capped) {
            items.insert(item.id.clone(), item);
        }
    }
    items.into_values().collect()
}

/// A PR link, in full or as `owner/repo#123`.
static PR_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"https://github\.com/[^/\s)]+/[^/\s)]+/pull/(\d+)|(?:^|[^A-Za-z0-9_./-])[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#(\d+)",
    )
    .unwrap()
});
/// An offer to merge: a `merge` reply, or "merge or send back".
static MERGE_VERB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)`merge`|\breply\s+[*"“`]*merge\b|\bmerge[`*"”]*\s+(?:or|/)\s+[`*"“]*send back"#,
    )
    .unwrap()
});
static SEND_BACK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsend back\b").unwrap());

/// Whether a card is a merge card or a question. A merge card names a PR and offers to
/// merge it or send it back; the Foreman story view's `kindOf` applies the same rule, and
/// both read the case table in `tests/fixtures/merge-card-cases.json`.
pub fn card_kind(summary: Option<&str>, text: &str) -> NeedsYouKind {
    let words = format!("{}\n{text}", summary.unwrap_or_default());
    if PR_LINK.is_match(&words) && MERGE_VERB.is_match(&words) && SEND_BACK.is_match(&words) {
        NeedsYouKind::Merge
    } else {
        NeedsYouKind::Question
    }
}

/// A question card's text: its summary, else its first non-blank line, on one line without
/// bold markers and at most 200 characters.
pub fn question_text(summary: Option<&str>, text: &str) -> String {
    let raw = summary
        .map(str::trim)
        .filter(|s| !str::is_empty(s))
        .or_else(|| Iterator::find(&mut text.lines(), |line| !str::is_empty(line.trim())))
        .unwrap_or_default();
    let line = str::replace(&str::replace(raw, "**", ""), "__", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.chars().count() > 200 {
        format!("{}…", line.chars().take(199).collect::<String>())
    } else {
        line
    }
}

#[cfg(test)]
#[path = "needs_you_tests.rs"]
mod tests;
