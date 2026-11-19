// SPDX-License-Identifier: MIT
//! Process identities: a pid alone is never an invocation identity; a process
//! is its pid plus its start time.
//!
//! The start is the OS's own measure, comparable only with another start read
//! on the same host: clock ticks since boot on Linux, microseconds since the
//! epoch on macOS, a creation FILETIME on Windows. A process that has exited
//! reads as gone even while it can still be named (an unreaped zombie on unix,
//! a process whose handle someone holds open on Windows).

use std::time::SystemTime;

use super::{is_alive, sys, Pid};

/// The most parents [`Identity::descends_from`] walks.
const MAX_DEPTH: usize = 128;

/// A live process: its pid, its start time and its parent when read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pub pid: u32,
    pub start: u64,
    pub parent: u32,
}

impl Identity {
    /// The live process `pid`: `None` when it has exited, is gone or cannot be
    /// read.
    pub fn inspect(pid: u32) -> Option<Self> {
        sys::inspect(pid)
    }

    /// Whether this is `other`, however either was re-parented since: its pid
    /// and start time.
    pub fn is(self, other: Identity) -> bool {
        self.pid == other.pid && self.start == other.start
    }

    /// Whether this process is `root` or runs under it, by its recorded
    /// parent and then each parent's fresh ancestry.
    pub fn descends_from(self, root: Identity) -> bool {
        descends_with(self, root, sys::PARENT_MAY_BE_STALE, Self::inspect)
    }

    /// The live process that is this one's parent: `None` when it records none, none
    /// reads, or (where a recorded parent may be stale) it started after this one.
    pub fn parent(self) -> Option<Self> {
        parent_of(self, sys::PARENT_MAY_BE_STALE, &Self::inspect)
    }

    /// Whether this process has certainly gone: its pid now names another
    /// start, or nothing reads and the pid no longer exists. Failure to read
    /// process metadata is unknown, not proof of death. On Windows an exited
    /// process reads as retired even while a handle to it is open.
    pub fn retired(self) -> bool {
        match Self::inspect(self.pid) {
            Some(current) => current.start != self.start,
            None => !is_alive(Pid::from_raw(self.pid)),
        }
    }

    /// Whether this process still runs: its pid reads as a live process with
    /// the same start time, whatever its parent is now.
    pub fn runs(self) -> bool {
        Self::inspect(self.pid).is_some_and(|now| now.start == self.start)
    }

    /// Whether this process started at or after `time` (wall clock).
    pub fn started_after(self, time: SystemTime) -> bool {
        let Ok(time) = time.duration_since(std::time::UNIX_EPOCH) else {
            return false;
        };
        sys::started_after(self.start, time)
    }

    /// The process on the other end of the Unix socket `stream`, when it runs
    /// as this user.
    #[cfg(unix)]
    pub fn of_unix_peer(stream: &impl std::os::fd::AsRawFd) -> Option<Self> {
        sys::peer(stream)
    }
}

/// The agent whose hook shell ran `helper`: the shell is `helper`'s parent as `inspect`
/// reads it, and the agent is the shell's. `None` when either does not read, or either
/// started after its child: the shell's pid, or the agent's, is a dead parent's since
/// reused (Windows never re-parents). The check holds on every OS, as this resolution is
/// for hooks run through a shell that does not `exec` the helper.
pub fn agent_of_shell(
    helper: Identity,
    inspect: impl Fn(u32) -> Option<Identity>,
) -> Option<Identity> {
    let shell = parent_of(helper, true, &inspect)?;
    parent_of(shell, true, &inspect)
}

/// Whether a waiter's `agent` and the `parent` that ran it both still run: each pid reads
/// through `inspect` with its captured start, so a reused pid is gone. Unlike
/// [`Identity::retired`], one that does not read counts as gone too: a waiter that cannot
/// see its agent stops waiting. Where the hook `exec`s the helper, the parent is the agent
/// and is passed as both.
pub fn still_attached(
    agent: &Identity,
    parent: &Identity,
    inspect: impl Fn(u32) -> Option<Identity>,
) -> bool {
    [agent, parent]
        .into_iter()
        .all(|process| inspect(process.pid).is_some_and(|now| now.is(*process)))
}

/// `child`'s parent as `inspect` reads it: `None` when it records none (pid 0, itself) or
/// none reads, or, where its recorded parent `may_be_stale`, one that started after it (an
/// equal start is accepted). Windows never re-parents, so a dead parent's pid can name a
/// newer process. Unix skips the check: a live process's parent is live or it was
/// re-parented, and the macOS start is wall clock, which can step backwards.
fn parent_of(
    child: Identity,
    may_be_stale: bool,
    inspect: &impl Fn(u32) -> Option<Identity>,
) -> Option<Identity> {
    if child.parent == 0 || child.parent == child.pid {
        return None;
    }
    inspect(child.parent).filter(|parent| !may_be_stale || parent.start <= child.start)
}

/// Walk from `peer` up through the parents `inspect` reads until `root`, each read as
/// [`parent_of`] says; it stops at init.
fn descends_with(
    mut peer: Identity,
    root: Identity,
    may_be_stale: bool,
    inspect: impl Fn(u32) -> Option<Identity>,
) -> bool {
    for _ in 0..MAX_DEPTH {
        if peer.pid == root.pid {
            return peer.is(root);
        }
        if peer.parent == 1 {
            return false;
        }
        let Some(parent) = parent_of(peer, may_be_stale, &inspect) else {
            return false;
        };
        peer = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, start: u64, parent: u32) -> Identity {
        Identity { pid, start, parent }
    }

    fn walk(peer: Identity, root: Identity, may_be_stale: bool, table: &[Identity]) -> bool {
        descends_with(peer, root, may_be_stale, |pid| {
            table.iter().copied().find(|entry| entry.pid == pid)
        })
    }

    #[test]
    fn a_chain_of_older_parents_reaches_its_root() {
        let root = process(10, 100, 1);
        let middle = process(20, 200, 10);
        let leaf = process(30, 300, 20);
        for may_be_stale in [true, false] {
            assert!(walk(leaf, root, may_be_stale, &[root, middle, leaf]));
            assert!(walk(root, root, may_be_stale, &[root]));
        }
    }

    #[test]
    fn a_parent_that_started_after_its_child_is_stale_where_parents_may_be() {
        let root = process(10, 100, 1);
        let leaf = process(30, 300, 20);
        let reused = process(20, 400, 10);
        assert!(!walk(leaf, root, true, &[root, reused, leaf]));
    }

    #[test]
    fn a_parent_that_started_after_its_child_is_followed_where_parents_are_live() {
        let root = process(10, 100, 1);
        let leaf = process(30, 300, 20);
        let later = process(20, 400, 10);
        assert!(walk(leaf, root, false, &[root, later, leaf]));
    }

    #[test]
    fn a_parent_that_started_with_its_child_is_not_stale() {
        let root = process(10, 100, 1);
        let middle = process(20, 300, 10);
        let leaf = process(30, 300, 20);
        for may_be_stale in [true, false] {
            assert!(walk(leaf, root, may_be_stale, &[root, middle, leaf]));
        }
    }

    #[test]
    fn the_roots_pid_with_another_start_is_not_the_root() {
        let root = process(10, 100, 1);
        let reused_root = process(10, 50, 1);
        let leaf = process(30, 300, 10);
        for may_be_stale in [true, false] {
            assert!(!walk(leaf, root, may_be_stale, &[reused_root, leaf]));
        }
    }

    #[test]
    fn the_walk_stops_at_init_a_gone_parent_a_self_parent_and_its_depth() {
        let root = process(10, 100, 1);
        let unread = |_: u32| -> Option<Identity> { unreachable!("the walk stops before reading") };
        for may_be_stale in [true, false] {
            for parent in [1, 0, 30] {
                let peer = process(30, 300, parent);
                assert!(!descends_with(peer, root, may_be_stale, unread));
            }
            assert!(!walk(process(30, 300, 20), root, may_be_stale, &[]));
            let ring = [process(40, 0, 41), process(41, 0, 40)];
            assert!(!walk(ring[0], root, may_be_stale, &ring));
        }
    }

    fn reads(table: &[Identity]) -> impl Fn(u32) -> Option<Identity> + '_ {
        move |pid| table.iter().copied().find(|entry| entry.pid == pid)
    }

    #[test]
    fn the_agent_of_a_hook_shell_is_the_shells_parent() {
        let agent = process(10, 100, 1);
        let shell = process(20, 200, 10);
        let helper = process(30, 300, 20);
        assert_eq!(
            agent_of_shell(helper, reads(&[agent, shell, helper])),
            Some(agent)
        );
        // Started together is not stale.
        let shell = process(20, 100, 10);
        let helper = process(30, 100, 20);
        assert_eq!(
            agent_of_shell(helper, reads(&[agent, shell, helper])),
            Some(agent)
        );
    }

    #[test]
    fn a_hook_shell_with_no_parent_reading_names_no_agent() {
        let shell = process(20, 200, 10);
        let helper = process(30, 300, 20);
        assert_eq!(agent_of_shell(helper, reads(&[shell, helper])), None);
        assert_eq!(agent_of_shell(helper, reads(&[helper])), None);
    }

    #[test]
    fn a_hook_shells_parent_that_started_after_it_is_a_reused_pid_not_the_agent() {
        let reused = process(10, 250, 1);
        let shell = process(20, 200, 10);
        let helper = process(30, 300, 20);
        assert_eq!(
            agent_of_shell(helper, reads(&[reused, shell, helper])),
            None
        );
    }

    #[test]
    fn a_shell_that_started_after_the_helper_is_not_its_shell() {
        let agent = process(10, 100, 1);
        let shell = process(20, 400, 10);
        let helper = process(30, 300, 20);
        assert_eq!(agent_of_shell(helper, reads(&[agent, shell, helper])), None);
    }

    #[test]
    fn a_parent_reads_unless_it_is_none_itself_or_newer_where_parents_may_be_stale() {
        let init = process(1, 0, 0);
        let child = process(30, 300, 1);
        let newer = process(1, 400, 0);
        for may_be_stale in [true, false] {
            assert_eq!(parent_of(child, may_be_stale, &reads(&[init])), Some(init));
            for orphan in [process(30, 300, 0), process(30, 300, 30)] {
                assert_eq!(
                    parent_of(orphan, may_be_stale, &reads(&[init, orphan])),
                    None
                );
            }
        }
        assert_eq!(parent_of(child, true, &reads(&[newer])), None);
        assert_eq!(parent_of(child, false, &reads(&[newer])), Some(newer));
    }

    #[test]
    fn a_waiter_is_attached_only_while_its_agent_and_parent_both_run() {
        let agent = process(10, 100, 1);
        let shell = process(20, 200, 10);
        let attached = |table: &[Identity]| still_attached(&agent, &shell, reads(table));
        assert!(attached(&[agent, shell]));
        // The CLI killed the hook's shell but not the helper.
        assert!(!attached(&[agent]));
        assert!(!attached(&[shell]));
        // Either pid now names a newer process.
        assert!(!attached(&[process(10, 500, 1), shell]));
        assert!(!attached(&[agent, process(20, 500, 10)]));
        // Metadata that cannot be read is gone, not unknown.
        assert!(!still_attached(&agent, &shell, |_| None));
    }

    #[test]
    fn a_waiter_whose_parent_is_its_agent_is_attached_while_that_one_runs() {
        let agent = process(10, 100, 1);
        assert!(still_attached(&agent, &agent, reads(&[agent])));
        assert!(!still_attached(&agent, &agent, reads(&[])));
        assert!(!still_attached(
            &agent,
            &agent,
            reads(&[process(10, 500, 1)])
        ));
    }

    /// Where the hook `exec`s, the parent is the agent: attached exactly while the unix
    /// parent pid is still the one captured.
    #[cfg(unix)]
    #[test]
    fn attached_to_this_processs_parent_agrees_with_the_unix_parent_pid() {
        let me = Identity::inspect(std::process::id()).expect("this process reads");
        let parent = me.parent().expect("its parent reads");
        assert_eq!(parent.pid, std::os::unix::process::parent_id());
        assert_eq!(
            still_attached(&parent, &parent, Identity::inspect),
            std::os::unix::process::parent_id() == parent.pid
        );
        let gone = Identity {
            start: parent.start.wrapping_add(1),
            ..parent
        };
        assert!(!still_attached(&gone, &gone, Identity::inspect));
    }
}
