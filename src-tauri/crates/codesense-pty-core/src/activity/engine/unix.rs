// SPDX-License-Identifier: MIT
//! A CLI's engine on unix: the launch helper starts it under a keeper that execs, signals
//! and serves on Unix sockets. The named-pipe port replaces this file.
use super::*;
use crate::activity::ingress;
use crate::agent_cli::{EngineEndpoint, CHANNEL_ENDPOINT};
use std::io::{self, BufRead};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The launch helper's side of [`launch_argv`]: starts the CLI's engine and binds it to the
/// CLI's invocation, then becomes the CLI attached to it; should the engine not come up, it
/// becomes the CLI on its own.
pub(super) fn exec_on_engine(args: &[OsString]) -> io::Error {
    let Some(launch) = args
        .first()
        .and_then(|launch| launch.to_str())
        .and_then(|launch| serde_json::from_str::<EngineLaunch>(launch).ok())
    else {
        return io::Error::other("engine launch arguments missing");
    };
    let options = Binding::from_env()
        .and_then(|binding| start_engine(&launch, &binding))
        .unwrap_or(launch.standalone);
    Command::new(&launch.program)
        .args(options)
        .args(launch.operands)
        .exec()
}

/// Starts `launch`'s engine under this process (about to become its CLI), reporting for
/// `binding`, and binds it to that invocation: the CLI's options attached to it, or
/// `None` when the engine could not come up or be bound (it is then ended).
pub(super) fn start_engine(launch: &EngineLaunch, binding: &Binding) -> Option<Vec<String>> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    // Short, beside the host's own socket.
    let endpoint = binding
        .socket
        .parent()?
        .join(format!("{ENGINE_SOCKET_PREFIX}{}.sock", &id[..12]));
    let named = endpoint.to_str()?;
    if named.len() >= MAX_SOCKET_PATH {
        return None;
    }
    let fill = |arguments: &[String]| -> Vec<String> {
        arguments
            .iter()
            .map(|argument| argument.replace(CHANNEL_ENDPOINT, named))
            .collect()
    };
    let mut keeper = Command::new(std::env::current_exe().ok()?);
    keeper
        .arg(KEEPER_ARG)
        .arg(&endpoint)
        .arg(serde_json::to_string(launch).ok()?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The engine runs the CLI's hooks, so it reports for the CLI's invocation.
    Binding::apply(Some(binding), &mut keeper);
    let mut keeper = keeper.spawn().ok()?;
    let deadline = Instant::now() + ENGINE_START;
    let started = (|| {
        // The keeper names its engine on its first line, once it runs: read on a thread of
        // its own, so a keeper that never says stalls nothing past the deadline.
        let stdout = keeper.stdout.take()?;
        let (named, engine) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = io::BufReader::new(stdout).read_line(&mut line);
            let _ = named.send(line);
        });
        let line = engine
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .ok()?;
        let engine: u32 = line.trim().parse().ok()?;
        while !is_socket(&endpoint) {
            if Instant::now() >= deadline || keeper.try_wait().ok()?.is_some() {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        ingress::bind_engine(
            &binding.socket,
            &binding.token,
            engine,
            &endpoint,
            crate::agent_cli::adapter(launch.provider)
                .descriptor()
                .config_home(|key| std::env::var_os(key)),
        )
        .ok()
    })();
    if started.is_none() {
        // Asked to end, the keeper ends its engine first.
        stop(&mut keeper, KEEPER_STOP);
        return None;
    }
    Some(fill(&launch.attached))
}

/// Whether an engine serves at `path`: its socket, or (as Codex on Linux names it) a
/// link to its socket.
pub(super) fn is_socket(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

/// A keeper (`--activity-keeper <endpoint> <launch-json>`): runs the launch's engine,
/// names it on its first line, and ends it once the CLI that started the
/// keeper is gone, or itself is asked to end (terminated, hung up or interrupted, as its
/// terminal closing does); it ends with its engine. It removes the engine's socket at
/// `endpoint` as it goes.
pub(super) fn keep_engine(args: &[OsString]) -> i32 {
    keep_engine_with(args, crate::agent_cli::adapter)
}

fn keep_engine_with(
    args: &[OsString],
    adapters: fn(AgentCli) -> &'static dyn crate::agent_cli::AgentCliAdapter,
) -> i32 {
    let parent = std::os::unix::process::parent_id();
    let [endpoint, launch] = args else {
        return 2;
    };
    let Some(launch) = launch
        .to_str()
        .and_then(|raw| serde_json::from_str::<EngineLaunch>(raw).ok())
    else {
        return 2;
    };
    let adapter = adapters(launch.provider);
    let home = adapter
        .descriptor()
        .config_home(|key| std::env::var_os(key));
    let source = if launch.serves_at {
        let Some(source) = adapter
            .channel(&launch.standalone)
            .and_then(|c| c.serves_at)
        else {
            return 2;
        };
        Some(source)
    } else {
        None
    };
    static ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    extern "C" fn asked(_: libc::c_int) {
        ASKED.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    // Before its engine runs, so no signal can end the keeper and leave the engine behind.
    for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        // SAFETY: the handler only stores to an atomic.
        unsafe {
            libc::signal(signal, asked as *const () as libc::sighandler_t);
        }
    }
    let endpoint = Path::new(endpoint);
    let Some(named) = endpoint.to_str() else {
        return 2;
    };
    let Ok(mut engine) = Command::new(&launch.program)
        .args(
            launch
                .engine
                .iter()
                .map(|arg| arg.replace(CHANNEL_ENDPOINT, named)),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return 1;
    };
    let Ok(_publication) = publish_endpoint(endpoint, home.as_deref(), source) else {
        stop(&mut engine, ENGINE_STOP);
        return 1;
    };
    println!("{}", engine.id());
    // Its stdout was only for that line: closed, so a CLI that never reads it can't stall
    // the keeper.
    // SAFETY: closing this process's own standard output, which nothing uses again.
    unsafe {
        libc::close(libc::STDOUT_FILENO);
    }
    loop {
        if engine.try_wait().ok().flatten().is_some() {
            if launch.end_on_loss {
                if let Some(binding) = Binding::from_env() {
                    // The host clears readiness before ending the committed tree. Its
                    // captured child handle owns group teardown, not a rediscovered PID.
                    let _ = ingress::engine_lost(&binding.socket, &binding.token);
                }
            }
            break;
        }
        if std::os::unix::process::parent_id() != parent
            || ASKED.load(std::sync::atomic::Ordering::SeqCst)
        {
            stop(&mut engine, ENGINE_STOP);
            break;
        }
        std::thread::sleep(KEEPER_POLL);
    }
    0
}

/// Owns only the host-minted endpoint. Dropping the relay closes its listener and every
/// active forwarding task before removing the socket, without touching a Unix target.
struct Publication {
    endpoint: PathBuf,
    relay: Option<Relay>,
}

impl Drop for Publication {
    fn drop(&mut self) {
        drop(self.relay.take());
        remove_socket(&self.endpoint);
    }
}

fn publish_endpoint(
    endpoint: &Path,
    home: Option<&Path>,
    source: Option<EngineEndpoint>,
) -> io::Result<Publication> {
    let mut publication = Publication {
        endpoint: endpoint.to_owned(),
        relay: None,
    };
    match source {
        None => {}
        Some(source) => {
            let home = home.ok_or_else(|| io::Error::other("engine home unavailable"))?;
            match source {
                EngineEndpoint::Unix(resolve) => {
                    std::os::unix::fs::symlink(resolve(home), endpoint)?
                }
                EngineEndpoint::Tcp(resolve) => {
                    publication.relay = Some(Relay::start(endpoint, home.to_owned(), resolve)?);
                }
            }
        }
    }
    Ok(publication)
}

/// The existing Tokio runtime and duplex copier own forwarding lifetimes. A keeper
/// never blocks on a peer: shutting down this runtime cancels even half-open connections.
struct Relay {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Relay {
    fn start(
        endpoint: &Path,
        home: PathBuf,
        resolve: fn(&Path) -> io::Result<std::net::SocketAddr>,
    ) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()?;
        let listener = std::os::unix::net::UnixListener::bind(endpoint)?;
        listener.set_nonblocking(true)?;
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("engine-relay".into())
            .spawn(move || {
                runtime.block_on(async {
                    let Ok(listener) = tokio::net::UnixListener::from_std(listener) else {
                        return;
                    };
                    loop {
                        let (mut client, _) = tokio::select! {
                            _ = &mut stopped => break,
                            accepted = listener.accept() => match accepted {
                                Ok(accepted) => accepted,
                                Err(_) => break,
                            },
                        };
                        // Discovery belongs to this connection, not engine startup. An engine
                        // not ready yet refuses this peer; the listener stays available.
                        let address = resolve(&home);
                        tokio::spawn(async move {
                            let Ok(address) = address else {
                                return;
                            };
                            let Ok(mut engine) = tokio::net::TcpStream::connect(address).await
                            else {
                                return;
                            };
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut engine).await;
                        });
                    }
                });
            })?;
        Ok(Self {
            stop: Some(stop),
            thread: Some(thread),
        })
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Asks `child` to end, and kills it if it has not within `grace`.
fn stop(child: &mut std::process::Child, grace: Duration) {
    // SAFETY: signalling our own child, which we then reap.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests;
