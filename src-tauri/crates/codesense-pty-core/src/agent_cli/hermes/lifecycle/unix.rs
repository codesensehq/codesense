// SPDX-License-Identifier: MIT
//! The home's own gateway where Unix process groups and `flock` exist: a live
//! `hermes_cli.main gateway run` born after the home, leading its own group and
//! holding the home's gateway lock.
use super::*;
use std::{fs, process::Command};

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
    // Darwin lsof does not expose flock's owner. Require all three facts: the live
    // gateway's lock record, a held kernel lock and that process's open file.
    let Ok(output) = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fpn"])
        .arg(&path)
        .output()
    else {
        return false;
    };
    let Ok(canonical) = fs::canonicalize(path) else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            line.strip_prefix('n')
                .is_some_and(|name| Path::new(name) == canonical)
        })
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
