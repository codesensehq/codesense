// SPDX-License-Identifier: MIT
//! One verified gateway teardown for host engine loss and desktop home removal.
use crate::activity::peer;
use codesense_platform::process::{Pid, ProcessGroup};
#[cfg(test)]
use std::os::unix::process::CommandExt;
use std::{
    path::Path,
    time::{Duration, Instant},
};

/// Which gateway is the home's own: read from its Unix process group and lock, or
/// none where those are not available yet.
#[cfg_attr(unix, path = "lifecycle/unix.rs")]
#[cfg_attr(not(unix), path = "lifecycle/off.rs")]
mod transport;
use transport::verified_gateway;

pub(crate) fn teardown_home(home: &Path, wait_for_replacement: bool) {
    // A detached recovery may still be importing/bootstraping when the CLI tree ends.
    // Only engine-loss cleanup waits for its verified lock/pid publication. Normal
    // desktop teardown remains one-shot. Discovery and stop share the original budget.
    let deadline = Instant::now() + Duration::from_secs(3);
    let process = loop {
        if let Some(process) = verified_gateway(home) {
            break process;
        }
        if !wait_for_replacement || Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // The gateway owns this process group; never signal the caller's group or a recycled PID.
    let Ok(Some(group)) = ProcessGroup::adopt(Pid::from_raw(process.pid())) else {
        return;
    };
    // Gone since it was verified: its group id may already name someone else's.
    if !peer::runs(process) {
        return;
    }
    let _ = group.terminate();
    while peer::runs(process) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if peer::runs(process) {
        let _ = group.kill();
    }
}

#[cfg(test)]
mod gateway_tests {
    use super::*;
    use std::io::BufRead;
    use std::{fs, process::Command};
    struct Gateway(std::process::Child);
    impl Gateway {
        fn spawn(home: &Path, owns_lock: bool) -> Self {
            Self::spawn_with(home, owns_lock, &[])
        }

        /// With `stubborn-child` in `extra`, the gateway first starts a child in its
        /// group that ignores SIGTERM and writes the child's pid to `child.pid`.
        fn spawn_with(home: &Path, owns_lock: bool, extra: &[&str]) -> Self {
            let code = r#"import fcntl,json,os,pathlib,signal,subprocess,sys,time
h=pathlib.Path(sys.argv[1]); f=open(h/'gateway.lock','w+')
json.dump({'pid':os.getpid()},f); f.flush()
if sys.argv[2]=='lock': fcntl.flock(f,fcntl.LOCK_EX)
if 'stubborn-child' in sys.argv[3:]:
 c=subprocess.Popen([sys.executable,'-c','import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint(1,flush=True)\ntime.sleep(60)'],stdout=subprocess.PIPE)
 c.stdout.readline(); (h/'child.pid').write_text(str(c.pid))
(h/'gateway.pid').write_text(json.dumps({'pid':os.getpid()}))
def stop(*args):
 (h/'stopped').write_text('checkpointed'); sys.exit(0)
signal.signal(signal.SIGTERM,stop)
print('ready',flush=True)
while True: time.sleep(.05)
"#;
            let mut child = Command::new("python3")
                .args(["-c", code])
                .arg(home)
                .arg(if owns_lock { "lock" } else { "open" })
                .args(["hermes_cli.main", "gateway", "run"])
                .args(extra)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap();
            let mut ready = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut ready)
                .unwrap();
            assert_eq!(ready.trim(), "ready");
            Self(child)
        }
    }
    impl Drop for Gateway {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[test]
    fn teardown_stops_only_a_home_born_gateway_holding_its_own_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let mut gateway = Gateway::spawn(tmp.path(), true);
        assert!(
            verified_gateway(tmp.path()).is_some(),
            "real process, lock and creation verification"
        );
        teardown_home(tmp.path(), false);
        assert!(
            tmp.path().join("stopped").exists(),
            "TERM allows final checkpoint before returning"
        );
        assert!(gateway.0.wait().unwrap().success());
        teardown_home(tmp.path(), false);
        let mut unheld = Gateway::spawn(tmp.path(), false);
        teardown_home(tmp.path(), false);
        assert!(
            unheld.0.try_wait().unwrap().is_none(),
            "a matching command with an unheld lock is not signaled"
        );
        let _ = unheld.0.kill();
        unheld.0.wait().unwrap();
    }

    #[test]
    fn a_gateway_that_stops_on_terminate_gets_no_kill() {
        use codesense_platform::process::is_alive;
        let tmp = tempfile::tempdir().unwrap();
        let mut gateway = Gateway::spawn_with(tmp.path(), true, &["stubborn-child"]);
        assert!(
            verified_gateway(tmp.path()).is_some(),
            "the teardown has a gateway to stop"
        );
        let child: u32 = fs::read_to_string(tmp.path().join("child.pid"))
            .unwrap()
            .parse()
            .unwrap();
        // Waited for here, so it is reaped as it exits and the teardown sees it gone
        // rather than a zombie.
        let home = tmp.path().to_owned();
        let teardown = std::thread::spawn(move || teardown_home(&home, false));
        assert!(gateway.0.wait().unwrap().success(), "stopped on SIGTERM");
        teardown.join().unwrap();
        assert!(tmp.path().join("stopped").exists());
        std::thread::sleep(Duration::from_millis(200));
        let survived = is_alive(Pid::from_raw(child));
        // SAFETY: kill only sends a signal, to the test's own grandchild.
        unsafe { libc::kill(child as i32, libc::SIGKILL) };
        assert!(
            survived,
            "a group whose gateway stopped on SIGTERM gets no SIGKILL"
        );
    }

    #[test]
    fn engine_loss_teardown_waits_for_verified_replacement_publication() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_owned();
        let (ready, started) = std::sync::mpsc::channel();
        let replacement = std::thread::spawn(move || {
            // Recovery can detach before its bootstrap publishes the lock and PID.
            std::thread::sleep(Duration::from_millis(50));
            let mut gateway = Gateway::spawn(&home, true);
            ready.send(()).unwrap();
            assert!(gateway.0.wait().unwrap().success());
        });
        teardown_home(tmp.path(), true);
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        let stopped = tmp.path().join("stopped").exists();
        // Keep the negative control clean too: join only after stopping the test's
        // verified child, even when the missing discovery wait made the assertion red.
        if !stopped {
            teardown_home(tmp.path(), false);
        }
        replacement.join().unwrap();
        assert!(stopped, "replacement was swept after verification");
    }
}

#[cfg(test)]
use std::process::Stdio;
