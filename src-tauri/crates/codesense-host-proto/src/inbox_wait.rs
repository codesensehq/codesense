// SPDX-License-Identifier: MIT
//! What an agent's inbox waiter and its host share: the notice that wakes the agent,
//! how one wait ends, and the lines the two exchange. The waiter is the host's own
//! helper (`--inbox-wait`), run by an agent CLI's hook; every host (this Mac's and each
//! machine's) speaks these, so each exists once.

/// The "you have mail" notice for `session_id`: what its inbox waiter hands the agent,
/// which wakes it. It names the session, so the agent calls read_messages without first
/// running a shell command to learn its own `$CODESENSE_TAB_SESSION_ID`. Never carries a
/// message body.
pub fn mail_notice(count: u32, session_id: &str) -> String {
    let plural = if count == 1 { "" } else { "s" };
    format!(
        "You have {count} new message{plural}. Call read_messages with session_id {session_id}."
    )
}

/// The most roles one notice names; past them it points to `role_state`, so the notice
/// stays within [`MAX_LINE`].
const NOTICE_ROLES: usize = 5;

/// One notice for direct mail, shared workspace posts and the pending mail of the roles
/// the session holds (`(role, pending)`), copying none of them: each part names the call
/// that reads it.
pub fn inbox_notice(
    count: u32,
    session: &str,
    chat: Option<(&str, u32)>,
    roles: &[(&str, u32)],
) -> String {
    let plural = |n: u32| if n == 1 { "" } else { "s" };
    let mut parts = Vec::new();
    if count > 0 {
        parts.push(format!(
            "{count} new message{}. Call read_messages with session_id {session}.",
            plural(count)
        ));
    }
    if let Some((workspace, n)) = chat.filter(|(_, n)| *n > 0) {
        let workspace = workspace.strip_prefix("story:").unwrap_or(workspace);
        parts.push(format!(
            "{n} new group-chat message{} in {workspace}. Call workspace_chat_read with sessionId {session}.",
            plural(n)
        ));
    }
    for (role, n) in roles.iter().take(NOTICE_ROLES) {
        parts.push(format!(
            "{n} pending message{} for role {role}. Call claim_role_messages with role {role}.",
            plural(*n)
        ));
    }
    if roles.len() > NOTICE_ROLES {
        let more = roles.len() - NOTICE_ROLES;
        parts.push(format!("mail for {more} more roles: see role_state."));
    }
    if parts.is_empty() {
        return mail_notice(count, session);
    }
    format!("You have {}", parts.join(" You also have "))
}

/// One notice can point to direct mail and shared workspace posts without copying either.
pub fn mail_and_chat_notice(count: u32, session: &str, chat: Option<(&str, u32)>) -> String {
    inbox_notice(count, session, chat, &[])
}

/// How an inbox wait ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InboxWait {
    /// New mail: the notice the waiter hands the agent, which wakes it (or reaches its
    /// running turn at its next model request).
    Mail(String),
    /// Nothing within the hold: the waiter asks again.
    Quiet,
    /// The waiter ends without waking the agent: a newer waiter of the same session took
    /// over, one was already waiting, the session ended, or no one can wait for it.
    Replaced,
}

/// A notice token as it travels to a waiter: letters, digits and dashes only, so it fits
/// the waiter's one-line answers.
pub fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The host's answer to a waiter, as its line(s): `mail <token>` then the notice's line,
/// `quiet`, or `replaced`. A notice is kept to one line.
pub fn answer_lines(outcome: &InboxWait, token: &str) -> String {
    match outcome {
        InboxWait::Mail(notice) => format!("mail {token}\n{}\n", notice.replace('\n', " ")),
        InboxWait::Quiet => "quiet\n".into(),
        InboxWait::Replaced => "replaced\n".into(),
    }
}

/// The first line of a host's answer read back: `Some(Ok(token))` for mail (its notice is
/// the next line), `Some(Err(outcome))` for quiet or replaced, `None` for anything else.
pub fn parse_answer(line: &str) -> Option<Result<&str, InboxWait>> {
    match line.trim_end() {
        "quiet" => Some(Err(InboxWait::Quiet)),
        "replaced" => Some(Err(InboxWait::Replaced)),
        answer => answer
            .strip_prefix("mail ")
            .filter(|token| valid_token(token))
            .map(Ok),
    }
}

/// What a waiter answers once it printed the notice reserved under `token`.
pub fn printed_line(token: &str) -> String {
    format!("printed {token}\n")
}

/// The longest line of the inbox waiter protocol (read with
/// [`read_message`](crate::reverse_mcp::read_message)): a notice line, with room to spare.
pub const MAX_LINE: usize = 4096;

/// Writes `text` (whole lines of the waiter protocol) to `stream`.
pub fn send_lines(stream: &mut impl std::io::Write, text: &str) -> std::io::Result<()> {
    stream.write_all(text.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_waiter_and_its_host_read_back_what_the_other_wrote() {
        let mail = answer_lines(&InboxWait::Mail("You have\nmail.".into()), "t-1");
        assert_eq!(mail, "mail t-1\nYou have mail.\n");
        assert_eq!(parse_answer(mail.lines().next().unwrap()), Some(Ok("t-1")));
        for outcome in [InboxWait::Quiet, InboxWait::Replaced] {
            assert_eq!(
                parse_answer(&answer_lines(&outcome, "")),
                Some(Err(outcome))
            );
        }
        assert_eq!(parse_answer("mail bad token"), None);
        assert_eq!(parse_answer("what"), None);
        assert_eq!(printed_line("t-1"), "printed t-1\n");
        assert!(valid_token("0a-B") && !valid_token("") && !valid_token("a b"));
    }

    #[test]
    fn the_notice_counts_the_mail_and_names_the_session_to_read_it_with() {
        assert_eq!(
            mail_notice(1, "S1"),
            "You have 1 new message. Call read_messages with session_id S1."
        );
        assert_eq!(
            mail_notice(3, "S1"),
            "You have 3 new messages. Call read_messages with session_id S1."
        );
    }

    #[test]
    fn a_role_notice_names_each_role_to_claim_its_mail_from() {
        assert_eq!(
            inbox_notice(0, "S1", None, &[("reviewer", 1)]),
            "You have 1 pending message for role reviewer. \
             Call claim_role_messages with role reviewer."
        );
        assert_eq!(
            inbox_notice(2, "S1", Some(("story:demo", 1)), &[("a", 2), ("b", 1)]),
            "You have 2 new messages. Call read_messages with session_id S1. \
             You also have 1 new group-chat message in demo. Call workspace_chat_read with sessionId S1. \
             You also have 2 pending messages for role a. Call claim_role_messages with role a. \
             You also have 1 pending message for role b. Call claim_role_messages with role b."
        );
        let many: Vec<(String, u32)> = (0..40).map(|i| (format!("{i:0>90}"), 1)).collect();
        let many: Vec<(&str, u32)> = many.iter().map(|(r, n)| (r.as_str(), *n)).collect();
        let notice = inbox_notice(1, "S1", None, &many);
        assert!(notice.len() < MAX_LINE / 2, "{}", notice.len());
        assert!(notice.ends_with("You also have mail for 35 more roles: see role_state."));
        assert_eq!(inbox_notice(1, "S1", None, &[]), mail_notice(1, "S1"));
    }
}
