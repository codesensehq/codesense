// SPDX-License-Identifier: MIT
//! The messages from the person each agent session took and hasn't answered: what the reply
//! reminder's route (`/api/v1/terminal/reply-check`) reads at a Claude `Stop`.
//!
//! `read_messages` records the person's messages it hands a session, under that session's tab
//! id (a handle can outlive one session, so a relaunch never inherits what its predecessor
//! took). Any answer to the person from the session's handle (`reply`, `send_message` to the
//! human, `workspace_chat_send`) clears them. The route names each message once.
//!
//! It lives in memory only: an app restart forgets it, and a forgotten message is never named,
//! so the reminder fails open.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use crate::weft::inbox::HUMAN;

/// The most messages kept per session; the oldest go first.
const MAX_OWED: usize = 64;

/// One session's unanswered messages from the person.
#[derive(Debug, Default)]
struct Owed {
    /// The handle the session answers as.
    handle: String,
    /// The messages' ids, oldest first, each with whether the reminder named it.
    messages: Vec<(i64, bool)>,
}

/// Each session's unanswered messages from the person, by tab session id.
#[derive(Debug, Default)]
pub(crate) struct RepliesOwed {
    sessions: Mutex<HashMap<String, Owed>>,
}

impl RepliesOwed {
    fn sessions(&self) -> MutexGuard<'_, HashMap<String, Owed>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `tab_session`, running as `handle`, took `messages` (`(id, from)`): the person's are
    /// owed an answer, and mail from agents is not.
    pub(crate) fn took<'a>(
        &self,
        tab_session: &str,
        handle: &str,
        messages: impl IntoIterator<Item = (i64, &'a str)>,
    ) {
        let mut person = messages
            .into_iter()
            .filter(|(_, from)| *from == HUMAN)
            .map(|(id, _)| id)
            .peekable();
        if person.peek().is_none() {
            return;
        }
        let mut sessions = self.sessions();
        let owed = sessions.entry(tab_session.to_string()).or_default();
        if owed.handle != handle {
            owed.handle = handle.to_string();
            owed.messages.clear();
        }
        for id in person {
            if !owed.messages.iter().any(|(taken, _)| *taken == id) {
                owed.messages.push((id, false));
            }
        }
        let excess = owed.messages.len().saturating_sub(MAX_OWED);
        owed.messages.drain(..excess);
    }

    /// `handle` answered the person: nothing its sessions took is owed any more.
    pub(crate) fn answered(&self, handle: &str) {
        if handle == HUMAN {
            return;
        }
        self.sessions().retain(|_, owed| owed.handle != handle);
    }

    /// Whether `tab_session` owes the person a message the reminder hasn't named.
    pub(crate) fn owes(&self, tab_session: &str) -> bool {
        self.sessions()
            .get(tab_session)
            .is_some_and(|owed| owed.messages.iter().any(|(_, reminded)| !reminded))
    }

    /// The oldest message `tab_session` owes the person that the reminder hasn't named yet,
    /// now marked named, so the next `Stop` lets the turn end.
    pub(crate) fn remind(&self, tab_session: &str) -> Option<i64> {
        let mut sessions = self.sessions();
        let owed = sessions.get_mut(tab_session)?;
        let (id, reminded) = owed.messages.iter_mut().find(|(_, reminded)| !*reminded)?;
        *reminded = true;
        let id = *id;
        // A session with nothing left to name keeps no entry: a turn that ends without an answer
        // is named once, then forgotten.
        if owed.messages.iter().all(|(_, reminded)| *reminded) {
            sessions.remove(tab_session);
        }
        Some(id)
    }
}

/// The app's one record.
pub(crate) fn replies_owed() -> &'static RepliesOwed {
    static OWED: LazyLock<RepliesOwed> = LazyLock::new(RepliesOwed::default);
    &OWED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_message_is_named_once() {
        let owed = RepliesOwed::default();
        owed.took("tab-1", "lead", [(7, HUMAN)]);
        assert!(owed.owes("tab-1"));
        assert_eq!(owed.remind("tab-1"), Some(7));
        assert!(!owed.owes("tab-1"));
        assert_eq!(owed.remind("tab-1"), None, "never twice");
        assert!(
            owed.sessions().is_empty(),
            "a session with nothing to name is dropped"
        );
    }

    #[test]
    fn the_oldest_unnamed_message_comes_first() {
        let owed = RepliesOwed::default();
        owed.took("tab-1", "lead", [(7, HUMAN), (9, HUMAN)]);
        owed.took("tab-1", "lead", [(7, HUMAN), (11, HUMAN)]);
        assert_eq!(owed.remind("tab-1"), Some(7));
        assert_eq!(owed.remind("tab-1"), Some(9));
        assert_eq!(owed.remind("tab-1"), Some(11));
        assert_eq!(owed.remind("tab-1"), None);
    }

    #[test]
    fn an_answer_clears_what_the_handle_owes() {
        let owed = RepliesOwed::default();
        owed.took("tab-1", "lead", [(7, HUMAN)]);
        owed.took("tab-2", "dev", [(8, HUMAN)]);
        owed.answered("lead");
        assert_eq!(owed.remind("tab-1"), None);
        assert_eq!(owed.remind("tab-2"), Some(8), "another handle still owes");
        owed.took("tab-3", "qa", [(9, HUMAN)]);
        owed.answered(HUMAN);
        assert!(owed.owes("tab-3"), "the person's own post answers nothing");
    }

    #[test]
    fn mail_from_agents_is_not_owed() {
        let owed = RepliesOwed::default();
        owed.took("tab-1", "lead", [(7, "coordinator"), (8, "story-1#dev")]);
        assert!(!owed.owes("tab-1"));
        assert_eq!(owed.remind("tab-1"), None);
    }

    /// A relaunch under the same handle is another tab session: it never inherits what its
    /// predecessor took.
    #[test]
    fn another_session_of_the_handle_owes_nothing() {
        let owed = RepliesOwed::default();
        owed.took("tab-old", "foreman", [(7, HUMAN)]);
        assert_eq!(owed.remind("tab-new"), None);
        assert!(!owed.owes("tab-new"));
    }

    #[test]
    fn a_session_keeps_only_its_newest_messages() {
        let owed = RepliesOwed::default();
        let many: Vec<(i64, &str)> = (0..(MAX_OWED as i64 + 5)).map(|id| (id, HUMAN)).collect();
        owed.took("tab-1", "lead", many);
        assert_eq!(owed.remind("tab-1"), Some(5));
    }
}
