// SPDX-License-Identifier: MIT
//! A waiter's hand-over on unix: the host serves its helper on the Unix socket the
//! activity ingress accepted. The named-pipe port replaces this file.
use super::*;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Instant;

use codesense_host_proto::inbox_wait::{self as wire, InboxWait};

use crate::inbox_waiters::{Owner, WaitArm, INBOX_WAIT_HOLD};

impl HostInbox {
    /// Hands the taken notice to the helper on `socket`: told once it says it printed it,
    /// else held again for the next waiter.
    fn hand(
        &self,
        outlet: &dyn InboxOutlet,
        session: &str,
        socket: &UnixStream,
        notice: String,
        token: String,
    ) -> Option<InboxWait> {
        let sent = self.while_wake_allowed(session, || {
            let answer = wire::answer_lines(&InboxWait::Mail(notice.clone()), &token);
            wire::send_lines(&mut &*socket, &answer).map_err(|_| ())
        });
        if sent != Some(Ok(())) {
            self.untake(session, &token, None);
            return None;
        }
        match await_printed(socket, &token) {
            Ok(()) => {
                self.untake(session, &token, Some(&self.handed));
                outlet.fate(session, &token, Fate::Told);
                Some(InboxWait::Mail(notice))
            }
            Err(()) => {
                self.untake(session, &token, None);
                None
            }
        }
    }

    /// Serves the waiter whose helper holds `socket`: armed at `arm` by `owner`, the
    /// session's agent process as its host named it. A `check` looks once and never waits
    /// or takes a place: it is handed what is held now; its `prompt` (the hook's own, when
    /// it has one) settles uncertain submits. Blocks until the wait ends; run it on its own
    /// thread.
    #[allow(clippy::too_many_arguments)]
    pub fn serve(
        &self,
        outlet: &dyn InboxOutlet,
        session: &str,
        arm: WaitArm,
        owner: Owner,
        check: bool,
        prompt: Option<&str>,
        socket: UnixStream,
    ) {
        if let Some(prompt) = prompt {
            self.confirm_prompt(outlet, session, prompt);
        }
        let end = if check {
            // An agent known to lack its tools is not told now; any other is.
            // Nothing to hand over ends it: a look never asks again.
            match self.take(session, |_| outlet.has_tools(session) != Some(false)) {
                Some((notice, token)) => self.hand(outlet, session, &socket, notice, token),
                None => Some(InboxWait::Replaced),
            }
        } else {
            self.wait(outlet, session, arm, owner, &socket)
        };
        match end {
            Some(outcome @ (InboxWait::Quiet | InboxWait::Replaced)) => {
                let _ = wire::send_lines(&mut &socket, &wire::answer_lines(&outcome, ""));
            }
            // Handed over already, or the helper went away.
            Some(InboxWait::Mail(_)) | None => {}
        }
    }

    fn wait(
        &self,
        outlet: &dyn InboxOutlet,
        session: &str,
        arm: WaitArm,
        owner: Owner,
        socket: &UnixStream,
    ) -> Option<InboxWait> {
        let signal = Arc::new(Signal::default());
        // A re-arm of the process already waiting (one after each tool call) defers.
        let Some(mut waiter) = self.waiters.register(session, arm, owner, signal.clone()) else {
            outlet.waiter_lifecycle(session, "exit", "replaced");
            return Some(InboxWait::Replaced);
        };
        outlet.waiter_lifecycle(session, "start", "armed");
        self.report(outlet, session);
        let deadline = Instant::now() + INBOX_WAIT_HOLD;
        let mut no_stream: Option<(String, Instant)> = None;
        let cycle = lock(&self.cycle).0;
        // The gate holding the waiting notice back, since when, and whether it was logged.
        let mut gated: Option<(String, Instant, bool)> = None;
        let (end, reason) = loop {
            if !crate::activity::peer::runs(owner) {
                break (Some(InboxWait::Replaced), "parent-gone");
            }
            match self.held_gate(outlet, session) {
                None => gated = None,
                Some(gate) => match &mut gated {
                    Some((held, since, logged)) if *held == gate => {
                        if !*logged && since.elapsed() >= cycle {
                            outlet.waiter_lifecycle(session, "held", &gate);
                            *logged = true;
                        }
                    }
                    _ => gated = Some((gate, Instant::now(), false)),
                },
            }
            let taken = self.take(session, |token| match outlet.has_tools(session) {
                Some(tools) => {
                    no_stream = None;
                    tools
                }
                // The grace runs from when this waiter first saw this notice.
                None => match &no_stream {
                    Some((seen, since)) if seen == token => since.elapsed() >= NO_STREAM_GRACE,
                    _ => {
                        no_stream = Some((token.to_string(), Instant::now()));
                        false
                    }
                },
            });
            if let Some((notice, token)) = taken {
                let handed = self.hand(outlet, session, socket, notice, token);
                let reason = if matches!(handed, Some(InboxWait::Mail(_))) {
                    "mail-delivered"
                } else {
                    "delivery-error"
                };
                break (handed, reason);
            }
            if hung_up(socket) {
                break (None, "helper-disconnected (timeout/killed or renewal)");
            }
            let now = Instant::now();
            if now >= deadline {
                break (Some(InboxWait::Quiet), "quiet-reask");
            }
            if signal.wait(LIVENESS_POLL.min(deadline - now)) {
                break (Some(InboxWait::Replaced), "replaced");
            }
        };
        outlet.waiter_lifecycle(session, "exit", reason);
        waiter.woke = matches!(end, Some(InboxWait::Mail(_)));
        drop(waiter);
        self.report(outlet, session);
        end
    }
}

/// Hands the helper on `socket` the notice reserved under `token`, and waits for it to
/// say it printed it.
fn await_printed(socket: &UnixStream, token: &str) -> Result<(), ()> {
    socket
        .set_read_timeout(Some(PRINT_DEADLINE))
        .map_err(|_| ())?;
    let printed =
        codesense_host_proto::reverse_mcp::read_message(&mut &*socket, wire::MAX_LINE, |_| Ok(()))
            .map_err(|_| ())?;
    (printed == wire::printed_line(token))
        .then_some(())
        .ok_or(())
}

/// Whether the helper on `socket` closed its end.
pub(crate) fn hung_up(socket: &UnixStream) -> bool {
    let mut byte = 0u8;
    // SAFETY: a one-byte peek into a local buffer on a socket this thread owns.
    let read = unsafe {
        libc::recv(
            socket.as_raw_fd(),
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    let would_block = || {
        matches!(
            std::io::Error::last_os_error().kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        )
    };
    // Closed, or failed (reset): either way no helper listens.
    read == 0 || read < 0 && !would_block()
}
