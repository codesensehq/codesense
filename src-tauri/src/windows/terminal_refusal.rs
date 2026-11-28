// SPDX-License-Identifier: MIT
//! Whether a terminal may move to another window, and the text a refusal shows.
//!
//! Only terminals on this Mac's server move, and only when that server can forget a
//! closed window's viewer. A terminal on another Machine is refused whether or not it has
//! a live session: a window closed while that Machine is offline would leave its viewer
//! behind, and a stale viewer could own the PTY's size. A refused move touches no viewer.
//!
//! [`check`] reads facts gathered before the registry lock and does no I/O. The up-front
//! move check calls it for each terminal tile, and a group is refused when any of its
//! terminals is. The texts live here and nowhere else; `move-commands.ts` shows them as
//! they come.

use serde::Serialize;

/// Refusal reasons, sent to callers as written.
pub mod reason {
    /// The terminal runs on another Machine.
    pub const OTHER_MACHINE: &str = "other_machine";
    /// The terminal's local server cannot forget a viewer.
    pub const OLD_SERVER: &str = "old_server";
}

/// The text for [`reason::OLD_SERVER`].
pub const OLD_SERVER_TEXT: &str = "Update the terminal server to move terminals between windows";

/// What the check reads about one terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalFacts {
    /// The Machine the terminal runs on, by its name; `None` for this Mac.
    pub machine: Option<String>,
    /// The terminal's local server can forget a closed window's viewer (the cached
    /// capability, read when the server connected).
    pub can_move_terminals: bool,
}

/// A refused move: its reason code and the text the person sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub reason: &'static str,
    pub text: String,
}

/// The text for [`reason::OTHER_MACHINE`], naming the Machine.
pub fn other_machine_text(machine: &str) -> String {
    format!("Terminals on other Machines can’t move to another window yet. {machine} has terminals here.")
}

/// Whether the terminal described by `facts` may move to another window.
pub fn check(facts: &TerminalFacts) -> Result<(), Refusal> {
    if let Some(machine) = &facts.machine {
        return Err(Refusal {
            reason: reason::OTHER_MACHINE,
            text: other_machine_text(machine),
        });
    }
    if !facts.can_move_terminals {
        return Err(Refusal {
            reason: reason::OLD_SERVER,
            text: OLD_SERVER_TEXT.to_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(machine: Option<&str>, can_move_terminals: bool) -> TerminalFacts {
        TerminalFacts {
            machine: machine.map(str::to_owned),
            can_move_terminals,
        }
    }

    #[test]
    fn a_local_terminal_on_a_current_server_passes() {
        assert_eq!(check(&facts(None, true)), Ok(()));
    }

    #[test]
    fn a_local_terminal_on_an_old_server_is_refused_with_the_update_text() {
        assert_eq!(
            check(&facts(None, false)),
            Err(Refusal {
                reason: reason::OLD_SERVER,
                text: "Update the terminal server to move terminals between windows".to_owned(),
            })
        );
    }

    #[test]
    fn a_terminal_on_another_machine_is_refused_with_the_machine_named() {
        let refusal = check(&facts(Some("devbox"), true)).unwrap_err();
        assert_eq!(refusal.reason, reason::OTHER_MACHINE);
        assert_eq!(
            refusal.text,
            "Terminals on other Machines can’t move to another window yet. devbox has terminals here."
        );
    }

    #[test]
    fn another_machine_is_refused_whatever_its_server_can_do() {
        let refusal = check(&facts(Some("devbox"), false)).unwrap_err();
        assert_eq!(refusal.reason, reason::OTHER_MACHINE);
        assert!(refusal.text.contains("devbox has terminals here."));
    }

    #[test]
    fn a_refusal_serializes_its_reason_and_text() {
        let refusal = check(&facts(None, false)).unwrap_err();
        assert_eq!(
            serde_json::to_value(&refusal).unwrap(),
            serde_json::json!({"reason": "old_server", "text": OLD_SERVER_TEXT})
        );
    }
}
