// SPDX-License-Identifier: MIT
//! The home's own gateway where Unix process groups and `flock` exist: a live
//! `hermes_cli.main gateway run` born after the home, leading its own group and
//! holding the home's gateway lock.
use super::*;
use std::fs;
#[cfg(target_os = "macos")]
use std::process::Command;

fn owns_lock(pid: u32, home: &Path) -> bool {
    let path = home.join("gateway.lock");
    let Ok(bytes) = fs::read(&path) else {
        return false;
    };
    let Ok(record) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    if record.get("pid").unwrap_or(&record).as_u64() != Some(pid as u64) {
        return false;
    }
    let Ok(lock) = fs::OpenOptions::new().read(true).write(true).open(&path) else {
        return false;
    };
    // Held elsewhere, or not a lock this process can take at all.
    if !matches!(codesense_platform::fs::try_lock_exclusive(&lock), Ok(false)) {
        return false;
    }
    // The third fact: that process has the lock file open.
    let Ok(canonical) = fs::canonicalize(&path) else {
        return false;
    };
    has_open(pid, &path, &canonical)
}

/// Whether process `pid` has the lock file open, as lsof names it.
#[cfg(target_os = "macos")]
fn has_open(pid: u32, path: &Path, canonical: &Path) -> bool {
    // Darwin lsof does not expose flock's owner. Require all three facts: the live
    // gateway's lock record, a held kernel lock and that process's open file.
    let Ok(output) = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fpn"])
        .arg(path)
        .output()
    else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            line.strip_prefix('n')
                .is_some_and(|name| Path::new(name) == canonical)
        })
}

/// Whether process `pid` has the lock file open: one of its `/proc/<pid>/fd`
/// links names it. A descriptor table that can't be read is no.
#[cfg(target_os = "linux")]
fn has_open(pid: u32, _path: &Path, canonical: &Path) -> bool {
    let Ok(descriptors) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    descriptors
        .flatten()
        .any(|fd| fs::read_link(fd.path()).is_ok_and(|target| target == canonical))
}

/// No way to name another process's open files here: never the owner.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn has_open(_pid: u32, _path: &Path, _canonical: &Path) -> bool {
    false
}

pub(super) fn verified_gateway(home: &Path) -> Option<peer::PeerProcess> {
    let bytes = Result::ok(fs::read(home.join("gateway.pid")))?;
    let record: serde_json::Value = Result::ok(serde_json::from_slice(&bytes))?;
    let pid = record
        .get("pid")
        .unwrap_or(&record)
        .as_u64()
        .and_then(|n| Result::ok(u32::try_from(n)))?;
    let identity = peer::inspect(pid)?;
    let created = Result::ok(Result::ok(fs::metadata(home))?.created())?;
    if !identity.started_after(created) {
        return None;
    }
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let id = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[id]),
        true,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    );
    let process = system.process(id)?;
    let args: Vec<_> = process.cmd().iter().map(|s| s.to_string_lossy()).collect();
    if !args.iter().any(|arg| arg == "hermes_cli.main")
        || !args.windows(2).any(|args| args == ["gateway", "run"])
        || unsafe { libc::getpgid(pid as i32) } != pid as i32
        || !owns_lock(pid, home)
        || !peer::runs(identity)
    {
        return None;
    }
    Some(identity)
}

#[cfg(all(test, target_os = "linux"))]
mod owner_tests {
    use super::*;
    use std::io::BufRead;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    struct Running(Child);
    impl Running {
        /// Run `code` under python3 with `args` and wait for its `ready` line.
        fn start(code: &str, args: &[&str], own_group: bool) -> Self {
            let mut command = Command::new("python3");
            command
                .args(["-c", code])
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            if own_group {
                command.process_group(0);
            }
            let mut child = command.spawn().unwrap();
            let mut ready = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut ready)
                .unwrap();
            assert_eq!(ready.trim(), "ready");
            Self(child)
        }
    }
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A process named in the lock record, born after the home and leading its own
    /// group, is not the home's gateway when it doesn't have `gateway.lock` open,
    /// even while another process holds the lock: the teardown signals none of it.
    #[test]
    fn a_recorded_gateway_without_the_lock_file_open_is_never_signaled() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let mut gateway = Running::start(
            r#"import json,os,pathlib,signal,sys,time
h=pathlib.Path(sys.argv[1])
(h/'gateway.pid').write_text(json.dumps({'pid':os.getpid()}))
def stop(*args):
 (h/'signaled').write_text('1'); sys.exit(0)
signal.signal(signal.SIGTERM,stop)
print('ready',flush=True)
while True: time.sleep(.05)
"#,
            &[home.to_str().unwrap(), "hermes_cli.main", "gateway", "run"],
            true,
        );
        let pid = gateway.0.id();
        let _holder = Running::start(
            r#"import fcntl,json,pathlib,sys,time
f=open(pathlib.Path(sys.argv[1])/'gateway.lock','w+')
json.dump({'pid':int(sys.argv[2])},f); f.flush(); fcntl.flock(f,fcntl.LOCK_EX)
print('ready',flush=True)
while True: time.sleep(.05)
"#,
            &[home.to_str().unwrap(), &pid.to_string()],
            false,
        );
        assert!(
            !owns_lock(pid, home),
            "the recorded pid has no open lock file"
        );
        assert!(verified_gateway(home).is_none());
        super::super::teardown_home(home, false);
        assert!(gateway.0.try_wait().unwrap().is_none(), "never signaled");
        assert!(!home.join("signaled").exists());
    }
}
