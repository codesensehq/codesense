// SPDX-License-Identifier: MIT
//! Unix: `getrlimit`/`setrlimit` on `RLIMIT_NOFILE`, the soft limit handed to
//! children in `pre_exec` or through the [`EXEC_ARG`] shim's `exec`, and the
//! open count from `/dev/fd`.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use super::{warning, Alarm, Usage, EXEC_ARG};

/// The OS error for a process out of descriptors.
pub(super) const TOO_MANY_OPEN_FILES: i32 = libc::EMFILE;

/// The OS errors for an open that hit a limit on open files: this process's
/// (`EMFILE`) or the system's (`ENFILE`).
pub(super) const OPEN_FILE_LIMITS: [i32; 2] = [libc::EMFILE, libc::ENFILE];

/// The soft limit before this process raised it (0: never raised).
static ORIGINAL: AtomicU64 = AtomicU64::new(0);
/// This process's own executable, when its entry point serves [`EXEC_ARG`].
static SHIM: OnceLock<Shim> = OnceLock::new();
/// Whether a replaced shim was already reported (once per process).
static STALE_SHIM_REPORTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The executable PTY children launch through, and the file it was when this
/// host registered it (`(st_dev, st_ino)`; `None`: never changes, as
/// `/proc/self/exe` is always this very image).
struct Shim {
    path: PathBuf,
    identity: Option<(u64, u64)>,
}

impl Shim {
    /// Whether `path` is still the file registered: an update that replaced
    /// or removed it may hold a build without the shim, so it is never run.
    fn current(&self) -> bool {
        match self.identity {
            None => true,
            Some(registered) => file_identity(&self.path) == Some(registered),
        }
    }
}

fn file_identity(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some((MetadataExt::dev(&metadata), MetadataExt::ino(&metadata)))
}

fn soft() -> Option<libc::rlimit> {
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: writable storage for one rlimit.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: initialized by the successful call.
    Some(unsafe { limit.assume_init() })
}
fn set_soft(value: u64) -> bool {
    let Some(mut limit) = soft() else {
        return false;
    };
    limit.rlim_cur = value as libc::rlim_t;
    // SAFETY: a valid rlimit; the hard limit is unchanged.
    unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == 0 }
}

/// The soft limit [`raise`] ends on: `target` when it is accepted, else `original`.
#[cfg(not(target_os = "macos"))]
fn settle(original: u64, target: u64) -> u64 {
    if set_soft(target) {
        target
    } else {
        original
    }
}

/// The soft limit [`raise`] ends on: `target`, halved while it stays above `original` until one
/// is accepted, since some macOS configurations reject a value below the hard limit; else
/// `original`.
#[cfg(target_os = "macos")]
fn settle(original: u64, target: u64) -> u64 {
    let mut candidate = target;
    while candidate > original {
        if set_soft(candidate) {
            return candidate;
        }
        candidate /= 2;
    }
    original
}

/// Raise this process's soft limit toward `wanted` (capped by the hard limit
/// and, on macOS, by OPEN_MAX), remembering the original for children.
/// Returns `(original, now)`.
pub fn raise(wanted: u64) -> Option<(u64, u64)> {
    let limit = soft()?;
    #[allow(clippy::unnecessary_cast)]
    let (original, hard) = (limit.rlim_cur as u64, limit.rlim_max as u64);
    let target = wanted.min(hard);
    #[cfg(target_os = "macos")]
    let target = target.min(10_240);
    let now = if target <= original {
        original
    } else {
        let _ = ORIGINAL.compare_exchange(0, original, Ordering::AcqRel, Ordering::Acquire);
        settle(original, target)
    };
    // Startup callers run before logging is initialized; stderr is already open.
    use std::io::Write;
    let _ = writeln!(
        std::io::stderr(),
        "open-file limit: soft {original} -> {now}, hard {hard}"
    );
    Some((original, now))
}

/// Carry the parent host's pre-raise limit to a child host.
pub fn inherit_original_limit(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    let original = ORIGINAL.load(Ordering::Acquire);
    if original == 0 {
        return;
    }
    // SAFETY: only rlimit syscalls run after fork; no allocation or locks.
    // The live host keeps its raised budget while the child starts with the
    // original limit, which its own startup raise remembers for PTYs.
    unsafe {
        command.pre_exec(move || {
            if set_soft(original) {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

/// Declare that this process's own executable serves [`EXEC_ARG`]: its entry
/// point calls [`exec_with_limit`] before anything else. Only such a host
/// wraps its PTY children ([`child_argv`]); one that never declares it (a test
/// harness that raised its limit) launches them as given, with its raised
/// limit, which is harmless.
pub fn serve_child_limit() {
    // Linux: the running image itself, even after `replace` swapped the file
    // on disk (the child resolves it before exec, while still this image).
    #[cfg(target_os = "linux")]
    let shim = Some(Shim {
        path: PathBuf::from("/proc/self/exe"),
        identity: None,
    });
    // Elsewhere: the file at this executable's path, as it is now. A host
    // outlives app updates, so wrapping stops once that file is replaced.
    #[cfg(not(target_os = "linux"))]
    let shim = std::env::current_exe().ok().and_then(|path| {
        let identity = Some(file_identity(&path)?);
        Some(Shim { path, identity })
    });
    if let Some(shim) = shim {
        let _ = SHIM.set(shim);
    }
}

/// The argv that runs `argv` (its `program` resolved to an absolute path)
/// with this host's original soft limit, through this host's own executable;
/// `None` to run `argv` as given: the host never raised its limit, does not
/// serve the shim, or its executable was replaced or removed since it
/// registered (an update), which is reported once on stderr.
pub fn child_argv(program: &OsStr, argv: &[OsString]) -> Option<Vec<OsString>> {
    let original = ORIGINAL.load(Ordering::Acquire);
    #[allow(clippy::unnecessary_cast)]
    let raised = soft().is_some_and(|limit| limit.rlim_cur as u64 > original);
    if original == 0 || !raised || <[OsString]>::is_empty(argv) {
        return None;
    }
    let shim = SHIM.get()?;
    if !shim.current() {
        if !STALE_SHIM_REPORTED.swap(true, Ordering::AcqRel) {
            use std::io::Write;
            let _ = writeln!(
                std::io::stderr(),
                "open-file limit: {} was replaced or removed since this process started; \
                 new terminals keep its raised limit until it restarts",
                std::path::Path::display(&shim.path)
            );
        }
        return None;
    }
    let mut wrapped = vec![
        PathBuf::clone(&shim.path).into_os_string(),
        EXEC_ARG.into(),
        original.to_string().into(),
        program.to_owned(),
        "--".into(),
    ];
    wrapped.extend(argv.iter().cloned());
    Some(wrapped)
}

/// The shim: `args` (after [`EXEC_ARG`]) are `<soft> <program> -- <argv0>
/// [args…]`. Lowers this process's soft limit to `<soft>` and execs `program`
/// with that argv, keeping the pid, environment, working directory, session
/// and descriptors. Returns only on failure. It can only lower a limit, never
/// raise one, so running it by hand grants nothing `exec` itself does not.
pub fn exec_with_limit(args: &[OsString]) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    let usage = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "usage: --nofile-exec <soft> <program> -- <argv0> [args…]",
        )
    };
    let [limit, program, separator, argv0, rest @ ..] = args else {
        return usage();
    };
    let Some(limit) = limit
        .to_str()
        .and_then(|limit| limit.parse::<u64>().ok())
        .filter(|_| separator == "--")
    else {
        return usage();
    };
    #[allow(clippy::unnecessary_cast)]
    let current = soft().map(|current| current.rlim_cur as u64);
    if current.is_some_and(|current| current > limit) {
        // A failure leaves the command the raised limit: harmless, so it
        // still starts.
        set_soft(limit);
    }
    let error = std::process::Command::new(program)
        .arg0(argv0)
        .args(rest)
        .exec();
    std::io::Error::new(
        error.kind(),
        format!(
            "{}: {error}",
            std::path::Path::display(std::path::Path::new(program))
        ),
    )
}

/// This process's [`Usage`]: `getrlimit` plus a count of its descriptors.
pub fn usage() -> Option<Usage> {
    let limit = soft()?;
    #[allow(clippy::unnecessary_cast)]
    let (soft, hard) = (limit.rlim_cur as u64, limit.rlim_max as u64);
    Some(Usage {
        soft,
        hard: (limit.rlim_max != libc::RLIM_INFINITY).then_some(hard),
        open: open_count(soft),
    })
}

/// The descriptors this process holds: the entries of `/dev/fd`, less the one
/// the listing itself opens (closed again before this returns). At the limit,
/// when that listing cannot open, each descriptor below `soft` is probed.
fn open_count(soft: u64) -> Option<u64> {
    if let Ok(entries) = std::fs::read_dir("/dev/fd") {
        let listed = entries.filter(Result::is_ok).count() as u64;
        return Some(listed.saturating_sub(1));
    }
    let probed = (0..soft.min(1 << 16) as libc::c_int)
        // SAFETY: F_GETFD only reads a descriptor's flags; -1 means not open.
        .filter(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } != -1)
        .count();
    Some(probed as u64)
}

/// How often [`watch`] samples.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

/// Sample this long-lived process's [`Usage`] every 15 s on a background
/// thread, handing [`warning`] to `warn` when its [`Alarm`] raises it. No
/// descriptor is held across the sleep. Call it after any daemonizing fork.
pub fn watch(process: &'static str, warn: fn(&str)) {
    let _ = std::thread::Builder::new()
        .name("nofile-watch".into())
        .spawn(move || {
            let mut alarm = Alarm::default();
            loop {
                std::thread::sleep(WATCH_EVERY);
                if let Some(usage) = usage().filter(|usage| alarm.observe(*usage)) {
                    warn(&warning(process, usage));
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::Alarm;
    use std::ffi::OsString;

    /// Re-run test `name` alone in its own process (the limit is process-wide),
    /// returning true in that process.
    fn isolated(name: &str) -> bool {
        const CHILD: &str = "CODESENSE_NOFILE_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            return true;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        // libtest exits 0 when `--exact` matches nothing, so also require
        // "1 passed": a renamed test can't pass vacuously.
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && str::contains(&stdout, "1 passed"),
            "{name} failed in its own process: {}\nstdout:\n{stdout}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        false
    }

    #[test]
    fn the_alarm_follows_real_descriptors_under_a_lowered_limit() {
        if !isolated(
            "limits::unix::tests::the_alarm_follows_real_descriptors_under_a_lowered_limit",
        ) {
            return;
        }
        assert!(super::set_soft(100));
        let open = || super::usage().unwrap().open.unwrap();
        let mut held = Vec::new();
        let mut alarm = Alarm::default();
        assert!(
            open() < 70,
            "a test process starts well below 70 descriptors"
        );
        assert!(!alarm.observe(super::usage().unwrap()));
        while open() < 80 {
            held.push(std::fs::File::open("/dev/null").unwrap());
        }
        let usage = super::usage().unwrap();
        assert_eq!(usage.soft, 100);
        assert!(alarm.observe(usage), "80 of 100 warns");
        held.push(std::fs::File::open("/dev/null").unwrap());
        assert!(
            !alarm.observe(super::usage().unwrap()),
            "no repeat above 70%"
        );
        while open() >= 70 {
            held.pop();
        }
        assert!(!alarm.observe(super::usage().unwrap()), "re-arms quietly");
        while open() < 80 {
            held.push(std::fs::File::open("/dev/null").unwrap());
        }
        assert!(alarm.observe(super::usage().unwrap()), "warns again");
        let warning = super::warning("test", super::usage().unwrap());
        assert!(
            str::contains(&warning, "of its soft limit 100"),
            "{warning}"
        );
    }

    #[test]
    fn only_a_raised_host_that_serves_the_shim_wraps_its_children() {
        if !isolated(
            "limits::unix::tests::only_a_raised_host_that_serves_the_shim_wraps_its_children",
        ) {
            return;
        }
        let argv: Vec<OsString> = vec!["sh".into(), "-c".into(), "ulimit -Sn".into()];
        assert!(super::set_soft(256));
        assert_eq!(
            super::child_argv("/bin/sh".as_ref(), &argv),
            None,
            "never raised"
        );
        super::raise(10_240).unwrap();
        assert_eq!(
            super::child_argv("/bin/sh".as_ref(), &argv),
            None,
            "serves no shim"
        );
        super::serve_child_limit();
        let wrapped = super::child_argv("/bin/sh".as_ref(), &argv).unwrap();
        let mut expected: Vec<OsString> = vec![
            std::path::PathBuf::clone(&super::SHIM.get().unwrap().path).into_os_string(),
            "--nofile-exec".into(),
            "256".into(),
            "/bin/sh".into(),
            "--".into(),
        ];
        expected.extend(argv.iter().cloned());
        assert_eq!(wrapped, expected);
        assert_eq!(super::child_argv("/bin/sh".as_ref(), &[]), None);
        #[allow(clippy::unnecessary_cast)]
        let soft = super::soft().unwrap().rlim_cur as u64;
        assert!(soft > 256, "wrapping never lowers the host's own limit");
    }

    /// A host whose executable file was replaced (an update, perhaps a
    /// build without the shim) or removed stops wrapping, rather than launch
    /// every new terminal through it.
    #[test]
    fn a_replaced_or_removed_shim_is_never_launched_through() {
        if !isolated("limits::unix::tests::a_replaced_or_removed_shim_is_never_launched_through") {
            return;
        }
        // Its own process: nothing else uses this directory.
        let dir = std::path::Path::join(
            &std::env::temp_dir(),
            format!("codesense-limits-shim-{}", std::process::id()),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let path = std::path::Path::join(&dir, "host");
        std::fs::write(&path, "registered").unwrap();
        assert!(super::set_soft(256));
        super::raise(10_240).unwrap();
        let identity = super::file_identity(&path);
        assert!(identity.is_some());
        assert!(super::SHIM
            .set(super::Shim {
                path: std::path::PathBuf::clone(&path),
                identity,
            })
            .is_ok());
        let argv: Vec<OsString> = vec!["sh".into()];
        let wrapped = super::child_argv("/bin/sh".as_ref(), &argv).expect("the registered file");
        assert_eq!(wrapped[0].as_os_str(), path.as_os_str());

        let update = std::path::Path::join(&dir, "host.new");
        std::fs::write(&update, "replaced").unwrap();
        std::fs::rename(&update, &path).unwrap();
        assert_eq!(
            super::child_argv("/bin/sh".as_ref(), &argv),
            None,
            "replaced"
        );
        assert!(super::STALE_SHIM_REPORTED.load(std::sync::atomic::Ordering::Acquire));

        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            super::child_argv("/bin/sh".as_ref(), &argv),
            None,
            "removed"
        );
        std::fs::remove_dir(&dir).unwrap();
    }

    /// An exec failure names the program, with its errno.
    #[test]
    fn a_failed_exec_names_the_program() {
        // std's failed `exec` has already reset SIGPIPE to SIG_DFL in this
        // process, so run it alone rather than leave that in the shared binary.
        if !isolated("limits::unix::tests::a_failed_exec_names_the_program") {
            return;
        }
        // `u64::MAX` is above any soft limit, so this process keeps its own.
        let args: Vec<OsString> = vec![
            u64::MAX.to_string().into(),
            "/nonexistent/codesense-limits-program".into(),
            "--".into(),
            "codesense-limits-program".into(),
        ];
        let error = super::exec_with_limit(&args);
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        let text = error.to_string();
        assert!(
            str::starts_with(&text, "/nonexistent/codesense-limits-program: "),
            "{text}"
        );
        assert!(str::contains(&text, "(os error 2)"), "{text}");
    }

    #[test]
    fn the_shim_refuses_a_malformed_command_before_touching_the_limit() {
        for args in [
            vec![],
            vec!["256", "/bin/sh", "--"],
            vec!["many", "/bin/sh", "--", "sh"],
            vec!["256", "/bin/sh", "-x", "sh"],
        ] {
            let args: Vec<OsString> = args.into_iter().map(Into::into).collect();
            assert_eq!(
                super::exec_with_limit(&args).kind(),
                std::io::ErrorKind::InvalidInput,
                "{args:?}"
            );
        }
    }

    #[test]
    fn raises_a_low_soft_limit_in_an_isolated_process() {
        if !isolated("limits::unix::tests::raises_a_low_soft_limit_in_an_isolated_process") {
            return;
        }
        let before = super::soft().unwrap();
        assert!(super::set_soft(256));
        let (old, new) = super::raise(10_240).unwrap();
        assert_eq!(old, 256);
        assert!(new > old);
        assert!(new <= 10_240);
        assert_eq!(super::soft().unwrap().rlim_cur as u64, new);
        assert_eq!(super::soft().unwrap().rlim_max, before.rlim_max);
        assert_eq!(
            super::raise(512).unwrap(),
            (new, new),
            "never lower a raised limit"
        );
    }
}
