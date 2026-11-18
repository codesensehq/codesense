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

/// Walk from `peer` up through the parents `inspect` reads until `root`.
/// Where a recorded parent `may_be_stale` (Windows never re-parents, so it can
/// be a dead pid since reused), a parent that started after its child stops
/// the walk. Unix skips the check: a live process's parent is live or it was
/// re-parented, and the macOS start is wall clock, which can step backwards.
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
        if peer.parent <= 1 || peer.parent == peer.pid {
            return false;
        }
        let Some(parent) = inspect(peer.parent) else {
            return false;
        };
        if may_be_stale && parent.start > peer.start {
            return false;
        }
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
        for may_be_stale in [true, false] {
            assert!(!walk(process(30, 300, 1), root, may_be_stale, &[]));
            assert!(!walk(process(30, 300, 0), root, may_be_stale, &[]));
            assert!(!walk(process(30, 300, 20), root, may_be_stale, &[]));
            assert!(!walk(process(30, 300, 30), root, may_be_stale, &[]));
            let ring = [process(40, 0, 41), process(41, 0, 40)];
            assert!(!walk(ring[0], root, may_be_stale, &ring));
        }
    }
}
