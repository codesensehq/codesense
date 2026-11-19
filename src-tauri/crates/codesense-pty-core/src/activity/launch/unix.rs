// SPDX-License-Identifier: MIT
//! The launch helper's exec verbs and the `--version` probe, on unix: each execs or
//! signals a process group. The Windows ports replace them.
use super::*;
use crate::activity::{engine, ingress, HELPER_NAME, HOST_ENV};
use crate::agent_cli::version_cache::RuntimeIdentity;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

/// Activity failure does not prevent the requested CLI from starting. The
/// bootstrap never changes provider permissions or returns hook control data.
pub fn exec_managed_shell(args: &[OsString]) -> io::Error {
    let Some((path, rest)) = args.split_first() else {
        return io::Error::other("activity launch arguments missing");
    };
    let rest = rest.strip_prefix(&[OsString::from("--")]).unwrap_or(rest);
    let Some((program, arguments)) = rest.split_first() else {
        return io::Error::other("activity launch program missing");
    };
    let observed = read_bootstrap(Path::new(path)).ok().and_then(|bootstrap| {
        ingress::bind_shell(
            Path::new(&bootstrap.writer.socket),
            &bootstrap.writer.token,
            crate::agent_cli::descriptor(bootstrap.provider).one_shot(arguments),
        )
        .ok()?;
        Some(Observed {
            provider: bootstrap.provider,
            socket: bootstrap.writer.socket,
            token: bootstrap.writer.token,
            directory: Path::new(path).parent()?.to_path_buf(),
            helper: std::env::current_exe().ok()?.to_str()?.to_owned(),
        })
    });
    exec_observed(program, arguments, observed)
}

/// A CLI typed by hand in a host's shell: `--activity-run <provider> --
/// <program> <args>`. The shell's host root (in [`HOST_ENV`]) names the
/// socket and the stable helper the generated hooks run, so a shell opened
/// before the app restarted still reports.
pub fn exec_claimed(args: &[OsString]) -> io::Error {
    let Some((provider, rest)) = args.split_first() else {
        return io::Error::other("activity run arguments missing");
    };
    let rest = rest.strip_prefix(&[OsString::from("--")]).unwrap_or(rest);
    let Some((program, arguments)) = rest.split_first() else {
        return io::Error::other("activity run program missing");
    };
    let provider = provider
        .to_str()
        .and_then(|cli| cli.parse::<AgentCli>().ok());
    let observed = provider
        .zip(std::env::var_os(HOST_ENV))
        .and_then(|(provider, root)| {
            let root = PathBuf::from(root);
            let socket = root.join("activity.sock");
            let claimed = ingress::claim_shell(
                &socket,
                provider,
                crate::agent_cli::descriptor(provider).one_shot(arguments),
            )
            .ok()?;
            Some(Observed {
                provider,
                socket: socket.to_str()?.to_owned(),
                token: claimed.token,
                directory: claimed.directory,
                helper: root.join(HELPER_NAME).to_str()?.to_owned(),
            })
        });
    exec_observed(program, arguments, observed)
}

/// An admitted invocation the CLI reports for.
struct Observed {
    provider: AgentCli,
    socket: String,
    token: String,
    /// Private, owner-only; generated settings go here.
    directory: PathBuf,
    /// What the generated hooks run.
    helper: String,
}

fn exec_observed(
    program: &OsString,
    arguments: &[OsString],
    observed: Option<Observed>,
) -> io::Error {
    let mut effective_arguments = arguments.to_vec();
    let mut binding = None;
    if let Some(observed) = observed {
        let adapter = crate::agent_cli::adapter(observed.provider);
        let mut bound = engine::Binding {
            socket: PathBuf::from(&observed.socket),
            token: observed.token,
            qualified: false,
        };
        let (qualified, update_required) = observed_release(adapter, program, None);
        if update_required {
            let _ = ingress::require_inbox_update(&bound.socket, &bound.token);
        }
        if let Some(qualified) = qualified {
            if let Ok(prepared) = prepared_arguments(
                adapter,
                arguments,
                Some(&observed.directory),
                &observed.helper,
                adapter
                    .descriptor()
                    .config_home(|key| std::env::var_os(key)),
            ) {
                bound.qualified = qualified;
                // On its engine, when it runs on one.
                effective_arguments = engine::attach(observed.provider, program, prepared, &bound);
            }
        }
        binding = Some(bound);
    }
    let mut command = std::process::Command::new(program);
    command.args(effective_arguments);
    engine::Binding::apply(binding.as_ref(), &mut command);
    command.exec()
}

/// Runs `program --version` in a process group of its own, reaped within `budget`:
/// whether it names `adapter`'s qualified release, recorded in the version cache. `None`
/// when it can't start, fails or overruns, said on stderr.
pub(super) fn version_probe(
    program: &std::ffi::OsStr,
    adapter: &dyn AgentCliAdapter,
    runtime: Option<&Path>,
    identity: Option<&RuntimeIdentity>,
    budget: std::time::Duration,
) -> Option<bool> {
    let release = &adapter.descriptor().release;
    let program_path = Path::new(program);
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let Ok(mut child) = std::process::Command::new(program)
        .arg("--version")
        .envs(crate::agent_cli::version_cache::resolve_env(
            adapter.probe().version_env,
            runtime,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
    else {
        eprintln!(
            "CodeSense: {} activity unqualified: version probe could not start",
            adapter.descriptor().name
        );
        return None;
    };
    let result = (|| -> io::Result<Option<String>> {
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("version stdout unavailable"))?;
        // SAFETY: this helper owns this live pipe descriptor.
        let flags = unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                < 0
        {
            return Ok(None);
        }
        let deadline = Instant::now() + budget;
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        bytes.extend_from_slice(&buffer[..length]);
                        if bytes.len() > 4096 {
                            return Ok(None);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // Observe without reaping, retaining ownership of this numeric PID
            // and process group until cleanup below has signalled it once.
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            } != 0
            {
                return Ok(None);
            }
            if unsafe { info.si_pid() } != 0 {
                // It may have written between the nonblocking read and waitid.
                let _ = stdout
                    .take(4097_u64.saturating_sub(bytes.len() as u64))
                    .read_to_end(&mut bytes);
                if bytes.len() > 4096 {
                    return Ok(None);
                }
                return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    // SAFETY: the probe remains our unreaped child in its own process group.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let successful = child.wait().is_ok_and(|status| status.success());
    if successful {
        let version = result.ok().flatten();
        if let Some(version) = version {
            let _ = crate::agent_cli::version_cache::write(
                program_path,
                &version,
                adapter.probe(),
                identity,
            );
            Some(release.qualified(&version))
        } else {
            eprintln!("CodeSense: {} activity unqualified: version probe timed out or returned invalid output", adapter.descriptor().name);
            None
        }
    } else {
        eprintln!(
            "CodeSense: {} activity unqualified: version probe failed or timed out",
            adapter.descriptor().name
        );
        None
    }
}
