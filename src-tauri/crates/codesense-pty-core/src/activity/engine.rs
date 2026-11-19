// SPDX-License-Identifier: MIT
//! A CLI run on its engine ([`NativeChannel`]): the engine is started under the CLI's own
//! process by the launch helper, kept by a keeper that ends it with the CLI, and bound to
//! the CLI's invocation, so the host reaches the CLI through it
//! ([`Control::channel`](crate::agent_cli::Control::channel)) and never through its
//! terminal. Every hook the engine runs descends from the CLI's process, as a hook the CLI
//! itself runs does.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{SOCKET_ENV, TOKEN_ENV};
use crate::agent_cli::{operands_at, AgentCli};

#[cfg_attr(unix, path = "engine/unix.rs")]
#[cfg_attr(not(unix), path = "engine/off.rs")]
mod transport;

/// The helper option that runs a CLI on its engine (see [`launch_argv`]).
pub const ENGINE_ARG: &str = "--activity-engine";
/// The helper option a keeper runs under (see [`keep_engine`]).
pub(super) const KEEPER_ARG: &str = "--activity-keeper";

/// How long an engine has to open its socket before its CLI runs without it.
const ENGINE_START: Duration = Duration::from_secs(10);
/// How often a keeper looks whether its CLI or its engine is gone.
const KEEPER_POLL: Duration = Duration::from_millis(250);
/// How long an engine has to end once asked before it is killed.
const ENGINE_STOP: Duration = Duration::from_secs(2);
/// A Unix socket's path is bounded (`sun_path`, 104 bytes on macOS); one at it or past it
/// never listens.
const MAX_SOCKET_PATH: usize = 104;
/// The longest launch handed the helper as its one argument.
const MAX_LAUNCH: usize = 96 * 1024;
/// How long a keeper has to end its engine and itself once asked.
const KEEPER_STOP: Duration = Duration::from_secs(3);

/// What a host hands the launch helper: the CLI's program, its engine's arguments, its
/// options attached to that engine or standalone, and its operands.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EngineLaunch {
    pub provider: AgentCli,
    /// Resolve the adapter's own endpoint in the keeper instead of using argv alone.
    pub serves_at: bool,
    pub end_on_loss: bool,
    pub program: String,
    pub engine: Vec<String>,
    pub attached: Vec<String>,
    pub standalone: Vec<String>,
    pub operands: Vec<String>,
}

/// The launch an argv [`launch_argv`] gave hands the helper, if it runs on an engine: for
/// tests of what a host spawns.
#[cfg(any(test, feature = "test-support"))]
pub fn launch_of(argv: &[OsString]) -> Option<EngineLaunch> {
    match argv {
        [_, arg, launch] if arg == ENGINE_ARG => serde_json::from_str(launch.to_str()?).ok(),
        _ => None,
    }
}

/// The invocation a launch reports for: its host's activity socket (in the host's
/// private root, where the engine's socket goes too) and writer token, and whether its
/// release qualified.
pub(super) struct Binding {
    pub socket: PathBuf,
    pub token: String,
    pub qualified: bool,
}

impl Binding {
    /// Gives `command` the environment `binding` reports under, and nothing of the
    /// launch's own when there is none.
    pub(super) fn apply(binding: Option<&Self>, command: &mut Command) {
        command
            .env_remove(SOCKET_ENV)
            .env_remove(TOKEN_ENV)
            .env_remove(super::RELEASE_QUALIFIED_ENV);
        if let Some(binding) = binding {
            command
                .env(SOCKET_ENV, &binding.socket)
                .env(TOKEN_ENV, &binding.token);
            if binding.qualified {
                command.env(super::RELEASE_QUALIFIED_ENV, "1");
            }
        }
    }

    /// The binding a launch's environment carries, if any.
    pub(super) fn from_env() -> Option<Self> {
        Some(Self {
            socket: PathBuf::from(std::env::var_os(SOCKET_ENV)?),
            token: std::env::var(TOKEN_ENV).ok()?,
            qualified: std::env::var(super::RELEASE_QUALIFIED_ENV).is_ok_and(|q| q == "1"),
        })
    }
}

/// `cli`'s launch of `program` with `arguments` (its options, then its operands) on its
/// engine, if it runs on one. A launch whose argv is not UTF-8 runs on none.
fn engine_launch(
    adapter: &dyn crate::agent_cli::AgentCliAdapter,
    cli: AgentCli,
    program: &OsStr,
    arguments: &[OsString],
) -> Option<EngineLaunch> {
    let arguments: Vec<String> = arguments
        .iter()
        .map(|argument| argument.to_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    let (options, operands) = arguments.split_at(operands_at(&arguments));
    let channel = adapter.channel(options)?;
    Some(EngineLaunch {
        provider: cli,
        serves_at: channel.serves_at.is_some(),
        end_on_loss: adapter.end_on_engine_loss(),
        program: program.to_str()?.to_owned(),
        engine: channel.engine,
        attached: channel.attached,
        standalone: options.to_vec(),
        operands: operands.to_vec(),
    })
}

/// The argv a host spawns `cli`'s `program` with `arguments` as: through the launch
/// helper `helper` when the CLI runs on an engine (see [`exec_on_engine`]), else as given.
pub fn launch_argv(
    helper: &OsStr,
    cli: AgentCli,
    program: &OsStr,
    arguments: &[OsString],
) -> Vec<OsString> {
    // One argument holds the whole launch; past what an exec takes in one (128 KiB on
    // Linux), it runs as given.
    let launch = engine_launch(crate::agent_cli::adapter(cli), cli, program, arguments)
        .and_then(|launch| serde_json::to_string(&launch).ok())
        .filter(|launch| launch.len() < MAX_LAUNCH);
    match launch {
        Some(launch) => vec![helper.into(), ENGINE_ARG.into(), launch.into()],
        None => std::iter::once(program.to_os_string())
            .chain(arguments.iter().cloned())
            .collect(),
    }
}
/// The launch helper's side of [`launch_argv`]: starts the CLI's engine and binds it to the
/// CLI's invocation, then becomes the CLI attached to it; should the engine not come up, it
/// becomes the CLI on its own.
pub(super) fn exec_on_engine(args: &[OsString]) -> io::Error {
    transport::exec_on_engine(args)
}

/// `arguments` for `cli`'s `program`, about to run as this process under `binding`:
/// attached to its engine, started now, when it runs on one and the engine comes up; else
/// as given.
pub(super) fn attach(
    cli: AgentCli,
    program: &OsStr,
    arguments: Vec<OsString>,
    binding: &Binding,
) -> Vec<OsString> {
    let Some(launch) = engine_launch(crate::agent_cli::adapter(cli), cli, program, &arguments)
    else {
        return arguments;
    };
    match transport::start_engine(&launch, binding) {
        Some(attached) => attached
            .into_iter()
            .chain(launch.operands)
            .map(OsString::from)
            .collect(),
        None => arguments,
    }
}

/// How an engine's socket is named, in its host's private root.
const ENGINE_SOCKET_PREFIX: &str = "engine-";

/// Whether `path` is named as an engine's socket is.
pub(super) fn names_engine_socket(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(ENGINE_SOCKET_PREFIX) && name.ends_with(".sock"))
}

/// Removes the socket at `path`, or the link there an engine named its socket by (whatever
/// it now points to), if one is there; nothing else. The socket a link names is its
/// engine's own.
pub(super) fn remove_socket(path: &Path) {
    let link = std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_symlink());
    if link || transport::is_socket(path) {
        let _ = std::fs::remove_file(path);
    }
}

/// A keeper (`--activity-keeper <endpoint> <launch-json>`): runs the launch's engine,
/// names it on its first line, and ends it once the CLI that started the
/// keeper is gone, or itself is asked to end (terminated, hung up or interrupted, as its
/// terminal closing does); it ends with its engine. It removes the engine's socket at
/// `endpoint` as it goes.
pub(super) fn keep_engine(args: &[OsString]) -> i32 {
    transport::keep_engine(args)
}
