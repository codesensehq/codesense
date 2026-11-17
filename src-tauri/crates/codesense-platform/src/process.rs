// SPDX-License-Identifier: MIT
//! Process trees: start a command as the root of a tree that is ended as a
//! whole, ask the tree to stop, kill it, and check whether a pid still runs.
//!
//! Unix: the root leads a fresh process group (its pgid is its pid) and the
//! tree is signalled through the group, SIGTERM to ask and SIGKILL to end, as
//! the pty runner and the capture runner do. Windows: the root is assigned to
//! a Job Object that kills every process in it when it closes. It starts
//! suspended and runs only once it is in the job, so nothing it starts escapes
//! (this replaces the command's creation flags). A process with no console has
//! no polite stop there, so [`terminate`] ends the job too.

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use self::unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as sys;

/// A process id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Pid(u32);

impl Pid {
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    pub const fn as_raw(self) -> u32 {
        self.0
    }
}

impl From<u32> for Pid {
    fn from(raw: u32) -> Self {
        Self(raw)
    }
}

impl std::fmt::Display for Pid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// A child process and everything it starts. Dropping the tree kills it
/// and reaps the root.
///
/// The tree lives as long as its root: once the root's exit is seen
/// ([`ProcessTree::try_wait`], [`ProcessTree::wait`]), whatever it left
/// running is killed then, so the group id is never signalled after it
/// could name someone else's processes.
pub struct ProcessTree {
    child: Child,
    group: sys::Group,
    /// Set once the tree was killed or its root's exit was seen.
    closed: AtomicBool,
}

impl ProcessTree {
    /// Spawn `command` as the root of a new tree.
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        sys::prepare(command);
        let mut child = command.spawn()?;
        match sys::Group::adopt(&child) {
            Ok(group) => Ok(Self {
                child,
                group,
                closed: AtomicBool::new(false),
            }),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }

    /// The root's pid.
    pub fn pid(&self) -> Pid {
        Pid(self.child.id())
    }

    /// The root, for its stdio. Waiting on it directly skips the tree's
    /// cleanup; use [`ProcessTree::try_wait`] and [`ProcessTree::wait`].
    pub fn child(&mut self) -> &mut Child {
        &mut self.child
    }

    /// The root's exit status if it has exited; then the rest of the tree is
    /// killed.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.close();
        }
        Ok(status)
    }

    /// Wait for the root to exit; then the rest of the tree is killed.
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.close();
        Ok(status)
    }

    fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            let _ = self.group.kill();
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.close();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Ask every process in `tree` to stop: SIGTERM to the group on unix, which
/// a process may ignore; on Windows the job is ended, as by [`kill_hard`].
pub fn terminate(tree: &ProcessTree) -> io::Result<()> {
    if tree.closed.load(Ordering::Acquire) {
        return Ok(());
    }
    tree.group.terminate()
}

/// Kill every process in `tree`: SIGKILL to the group on unix, the job ended
/// on Windows.
pub fn kill_hard(tree: &ProcessTree) -> io::Result<()> {
    if tree.closed.load(Ordering::Acquire) {
        return Ok(());
    }
    tree.group.kill()?;
    tree.closed.store(true, Ordering::Release);
    Ok(())
}

/// Whether `pid` names a running process. One this user may not inspect
/// counts as running, never as gone. Pid 0 never does.
pub fn is_alive(pid: Pid) -> bool {
    sys::is_alive(pid.0)
}
