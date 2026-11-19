// SPDX-License-Identifier: MIT
//! What `peer` answers: descent through a re-parented chain, runs after exit
//! (reaped and not) and start order against wall time.

use super::peer;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// Poll `done` every 20 ms until it holds or five seconds pass.
fn eventually(mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    done()
}

fn me() -> peer::PeerProcess {
    peer::inspect(std::process::id()).unwrap()
}

/// A shell that starts `sleep` in the background, names it, and exits once its
/// stdin closes, leaving the sleep to be re-parented.
struct Chain {
    shell: std::process::Child,
    sleep: u32,
}

impl Chain {
    fn start() -> Self {
        let mut shell = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & echo $!; read _"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(shell.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let sleep = line.trim().parse().expect("the shell names its sleep");
        Self { shell, sleep }
    }

    /// Let the shell exit and reap it.
    fn end_shell(&mut self) {
        let mut stdin = self.shell.stdin.take().unwrap();
        let _ = writeln!(stdin);
        drop(stdin);
        self.shell.wait().unwrap();
    }

    fn kill_sleep(&self) {
        let _ = Command::new("kill").arg(self.sleep.to_string()).status();
    }
}

impl Drop for Chain {
    fn drop(&mut self) {
        self.kill_sleep();
        let _ = self.shell.kill();
        let _ = self.shell.wait();
    }
}

#[test]
fn descends_from_follows_fresh_ancestry_through_a_re_parented_chain() {
    let mut chain = Chain::start();
    let sleep = peer::inspect(chain.sleep).unwrap();
    let shell = peer::inspect(chain.shell.id()).unwrap();
    assert!(peer::descends_from(sleep, me()));
    assert!(peer::descends_from(sleep, shell));
    assert!(peer::descends_from(me(), me()));
    assert!(!peer::descends_from(me(), sleep));

    chain.end_shell();
    assert!(
        eventually(|| !peer::descends_from(sleep, me())),
        "a re-parented process still descends from its old ancestor"
    );
    assert!(peer::runs(sleep), "re-parenting is not exit");
    assert!(!peer::runs(shell));
}

#[test]
fn runs_is_false_once_the_process_exits() {
    let mut child = Command::new("sleep").arg("30").spawn().unwrap();
    let process = peer::inspect(child.id()).unwrap();
    assert_eq!(process.pid(), child.id());
    assert!(peer::runs(process));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(!peer::runs(process));
    assert!(peer::inspect(child.id()).is_none_or(|now| now != process));
    assert!(!peer::descends_from(process, me()));
}

#[test]
fn runs_is_false_for_an_unreaped_exited_child() {
    let mut child = Command::new("sleep").arg("30").spawn().unwrap();
    let process = peer::inspect(child.id()).unwrap();
    let _ = Command::new("kill").arg(child.id().to_string()).status();
    assert!(eventually(|| !peer::runs(process)));
    child.wait().unwrap();
}

#[test]
fn started_after_orders_a_process_start_against_wall_time() {
    let before = SystemTime::now() - Duration::from_secs(5);
    let child = Chain::start();
    let sleep = peer::inspect(child.sleep).unwrap();
    let later = SystemTime::now() + Duration::from_secs(60);
    assert!(sleep.started_after(before));
    assert!(!sleep.started_after(later));
    assert!(me().started_after(SystemTime::UNIX_EPOCH));
    assert!(!me().started_after(later));
}
