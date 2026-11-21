// SPDX-License-Identifier: MIT
//! The home's own gateway where Unix process groups and `flock` exist: a live
//! `hermes_cli.main gateway run` born after the home, leading its own group and
//! holding the home's gateway lock.
use super::*;
use std::fs;

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
    // Neither Darwin lsof nor Linux /proc exposes flock's owner. Require all three
    // facts: the live gateway's lock record, a held kernel lock and that process's
    // open file.
    codesense_platform::process::has_file_open(Pid::from_raw(pid), &path)
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

#[cfg(test)]
mod owner_tests {
    use super::super::Ready;
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    /// `code` under python3 with `args`.
    fn python(code: &str, args: &[&str]) -> Command {
        let mut command = Command::new("python3");
        command.args(["-c", code]).args(args);
        command
    }

    /// A process named in the lock record, born after the home and leading its own
    /// group, is not the home's gateway when it doesn't have `gateway.lock` open,
    /// even while another process holds the lock: the teardown signals none of it.
    #[test]
    fn a_recorded_gateway_without_the_lock_file_open_is_never_signaled() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let mut gateway = Ready::start(
            python(
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
            )
            .process_group(0),
        );
        let pid = gateway.0.id();
        let _holder = Ready::start(&mut python(
            r#"import fcntl,json,pathlib,sys,time
f=open(pathlib.Path(sys.argv[1])/'gateway.lock','w+')
json.dump({'pid':int(sys.argv[2])},f); f.flush(); fcntl.flock(f,fcntl.LOCK_EX)
print('ready',flush=True)
while True: time.sleep(.05)
"#,
            &[home.to_str().unwrap(), &pid.to_string()],
        ));
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
