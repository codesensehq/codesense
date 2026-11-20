// SPDX-License-Identifier: MIT
//! One-shot managed-shell bootstrap. It execs the provider; no supervisor stays.
use super::{ActivityOwner, ShellLaunch, Writer};
use crate::agent_cli::{
    find_settings_flag, ActivityProbe, AgentCli, AgentCliAdapter, LaunchSettings, Prepare,
    SettingsFlagError, ARGV_SLOT,
};
use codesense_platform::fs::{
    create_dir_new_owner_only, create_new_owner_only, file_id, file_id_of, is_owner_only,
    open_nofollow, FileId,
};
use codesense_platform::process::Identity as Process;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

#[cfg_attr(unix, path = "launch/unix.rs")]
#[cfg_attr(not(unix), path = "launch/off.rs")]
mod transport;

pub use transport::{exec_claimed, exec_managed_shell};

pub(super) struct OwnedDirectory {
    path: PathBuf,
    id: FileId,
}

impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| metadata.is_dir())
            && file_id(&self.path).is_ok_and(|id| id == self.id)
        {
            // Fixed work and owned names only. Unexpected user-hook artifacts
            // are preserved rather than recursively swept with the directory.
            for name in ["bootstrap.json", "settings.json"] {
                let _ = std::fs::remove_file(self.path.join(name));
            }
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    writer: Writer,
    provider: AgentCli,
}

/// A private, owner-only directory for one invocation's launch files, removed
/// with the invocation.
pub(super) fn launch_directory(root: &Path) -> Result<(PathBuf, OwnedDirectory), String> {
    let directory = root.join(format!("activity-launch-{}", uuid::Uuid::new_v4()));
    create_dir_new_owner_only(&directory).map_err(|error| error.to_string())?;
    let id = file_id(&directory).map_err(|error| error.to_string())?;
    let owned = OwnedDirectory {
        path: directory.clone(),
        id,
    };
    Ok((directory, owned))
}

fn private_root(socket: &Path) -> Result<&Path, String> {
    let root = socket.parent().ok_or("activity root unavailable")?;
    let directory = open_nofollow(std::fs::OpenOptions::new().read(true), root)
        .map_err(|error| error.to_string())?;
    let metadata = directory.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_dir() || !is_owner_only(&directory).map_err(|error| error.to_string())? {
        return Err("activity root is not private".into());
    }
    Ok(root)
}

/// The host side of a hand-typed CLI's claim: a fresh invocation of the shell
/// `peer` runs under, and the private directory for its generated settings.
pub(super) fn claim_shell_launch(
    owner: &ActivityOwner,
    peer: Process,
    provider: AgentCli,
    batch: bool,
) -> Result<super::ingress::Claimed, String> {
    let root = owner.launch_root().ok_or("activity ingress unavailable")?;
    let socket = root.join("activity.sock");
    private_root(&socket)?;
    let (_, writer) = owner.claim_shell(
        peer,
        provider,
        socket.to_str().ok_or("activity socket is not UTF-8")?,
        batch,
    )?;
    let (directory, owned) = launch_directory(&root)?;
    owner.retain_artifacts(&writer.token, owned)?;
    Ok(super::ingress::Claimed {
        token: writer.token,
        directory,
    })
}

pub fn prepare_shell_launch(
    owner: &ActivityOwner,
    session: &str,
    provider: AgentCli,
    socket: &Path,
    helper: &Path,
) -> Result<ShellLaunch, String> {
    let helper = helper.to_str().ok_or("activity helper path is not UTF-8")?;
    let root = private_root(socket)?;
    let (directory, owned) = launch_directory(root)?;
    let path = directory.join("bootstrap.json");
    let writer = owner.prepare_shell(
        session,
        provider,
        socket.to_str().ok_or("activity socket is not UTF-8")?,
    )?;
    let bytes = serde_json::to_vec(&Bootstrap {
        writer: writer.clone(),
        provider,
    })
    .map_err(|error| error.to_string())?;
    create_new_owner_only(&path)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(|error| error.to_string())?;
    owner.retain_artifacts(&writer.token, owned)?;
    Ok(ShellLaunch {
        identity: writer.identity,
        helper: helper.into(),
        bootstrap: path.to_string_lossy().into_owned(),
    })
}

fn read_bootstrap(path: &Path) -> io::Result<Bootstrap> {
    let file = open_nofollow(std::fs::OpenOptions::new().read(true), path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || !is_owner_only(&file)? || metadata.len() > 4096 {
        return Err(io::Error::other("invalid activity bootstrap"));
    }
    let id = file_id_of(&file)?;
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    let bootstrap = serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::other("invalid activity bootstrap"))?;
    if file_id(path)? != id {
        return Err(io::Error::other("activity bootstrap replaced"));
    }
    std::fs::remove_file(path)?;
    Ok(bootstrap)
}

/// Whether `program`, `adapter`'s CLI, runs observed, and if so whether its release
/// qualified (it is told so). A CLI recognised by a help flag is not probed here, so a
/// launch spends no time on `--help`; one recognised by its release runs observed only
/// once `--version` names a qualified one.
fn observed_release(
    adapter: &dyn crate::agent_cli::AgentCliAdapter,
    program: &std::ffi::OsStr,
    runtime: Option<&Path>,
) -> (Option<bool>, bool) {
    match adapter.probe().activity {
        ActivityProbe::HelpFlag(_) => (Some(false), false),
        ActivityProbe::Version => {
            let qualified = version_qualified(program, adapter, runtime);
            (
                qualified.filter(|qualified| *qualified),
                qualified == Some(false),
            )
        }
    }
}

/// A local launch its host spawns from its whole argv, `program` and `arguments`, with no
/// shell between (and no helper, but the one that starts its engine,
/// [`launch_argv`](super::launch_argv)): `arguments` prepared as `provider`'s activity and inbox hooks
/// need, run by `helper`, and whether its release qualified. A CLI whose launch settings
/// ride a file has the hooks folded into a private copy of the file its argv names (the
/// saved Agent's generated one), written in `directory`. `None`: it runs as given,
/// unobserved.
pub struct DirectPreparation {
    /// A managed home could not be folded; launching without its guards is refused.
    pub fatal_error: Option<String>,
    pub arguments: Option<(Vec<OsString>, bool)>,
    pub inbox_update_required: bool,
    pub unqualified_reason: Option<&'static str>,
}

pub fn prepare_direct(
    provider: AgentCli,
    program: &std::ffi::OsStr,
    arguments: &[OsString],
    helper: &str,
    home: Option<PathBuf>,
    directory: Option<&Path>,
) -> DirectPreparation {
    let adapter = crate::agent_cli::adapter(provider);
    let mut result = DirectPreparation {
        fatal_error: None,
        arguments: None,
        inbox_update_required: false,
        unqualified_reason: None,
    };
    // Without a directory to write a copy in, a settings-flag CLI runs as given.
    let settings_directory = match adapter.descriptor().launch_settings {
        LaunchSettings::Flag(_) => match directory {
            Some(directory) => Some(directory),
            None => return result,
        },
        _ => None,
    };
    let (qualified, update_required) = observed_release(adapter, program, home.as_deref());
    result.inbox_update_required = update_required;
    if qualified.is_none() {
        result.unqualified_reason = Some(if update_required {
            "unsupported CLI release"
        } else {
            "version probe failed or timed out"
        });
    }
    if let Some(qualified) = qualified {
        let requires_config = matches!(
            adapter.descriptor().launch_settings,
            LaunchSettings::HomeConfig { .. }
        );
        match prepared_arguments(adapter, arguments, settings_directory, helper, home) {
            Ok(prepared) => result.arguments = Some((prepared, qualified)),
            Err(error) if requires_config => {
                result.fatal_error = Some(format!(
                    "{} managed configuration could not be prepared: {error}",
                    adapter.descriptor().name
                ))
            }
            Err(_) => {}
        }
    }
    result
}

/// A headless run's `arguments`, prepared as [`prepare_direct`] does for a CLI whose launch
/// settings ride a home config: the managed hooks and observers are folded into the home
/// `env` names (its `home_env`, else the CLI's default) and an option that bypasses them is
/// refused. Any other CLI runs as given. Without the packaged `helper` or a release it
/// qualifies, a CLI that needs the fold does not run.
pub fn fold_launch_settings(
    provider: AgentCli,
    program: &Path,
    arguments: &[String],
    env: &[(String, String)],
    helper: Option<&str>,
) -> Result<Vec<String>, String> {
    let descriptor = crate::agent_cli::descriptor(provider);
    if !matches!(descriptor.launch_settings, LaunchSettings::HomeConfig { .. }) {
        return Ok(arguments.to_vec());
    }
    let name = &descriptor.name;
    let helper = helper.ok_or_else(|| {
        format!("{name} managed configuration could not be prepared: activity helper unavailable")
    })?;
    let home = descriptor.config_home(|key| {
        env.iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into())
    });
    let given: Vec<OsString> = arguments.iter().map(Into::into).collect();
    let prepared = prepare_direct(provider, program.as_os_str(), &given, helper, home, None);
    if let Some(error) = prepared.fatal_error {
        return Err(error);
    }
    let (prepared, _) = prepared.arguments.ok_or_else(|| {
        format!(
            "{name} managed configuration could not be prepared: {}",
            prepared.unqualified_reason.unwrap_or("unsupported CLI release")
        )
    })?;
    prepared
        .into_iter()
        .map(|argument| {
            argument
                .into_string()
                .map_err(|_| format!("{name} argument is not UTF-8"))
        })
        .collect()
}

/// Whether `program --version` answers within the adapter's budget and names a `release`.
fn version_qualified(
    program: &std::ffi::OsStr,
    adapter: &dyn AgentCliAdapter,
    runtime: Option<&Path>,
) -> Option<bool> {
    version_qualified_within(program, adapter, runtime, adapter.probe().version_budget)
}

fn version_qualified_within(
    program: &std::ffi::OsStr,
    adapter: &dyn AgentCliAdapter,
    runtime: Option<&Path>,
    budget: std::time::Duration,
) -> Option<bool> {
    let release = &adapter.descriptor().release;
    let locked =
        crate::agent_cli::version_cache::LockedRuntime::for_probe(adapter.probe(), runtime);
    let identity = locked.as_ref().map(|runtime| runtime.identity());
    let runtime = locked.as_ref().map(|runtime| runtime.root());
    let program_path = Path::new(program);
    if let Some(version) =
        crate::agent_cli::version_cache::read(program_path, adapter.probe(), identity)
    {
        return Some(release.qualified(&version));
    }
    #[cfg(test)]
    if let Some(version) = probe_stub::answer(budget) {
        return Some(release.qualified(&version));
    }
    transport::version_probe(program, adapter, runtime, identity, budget)
}

/// `arguments` with the activity observer `adapter` prepares, which runs `helper`. Only
/// the options are rewritten: everything after a bare `--` is an operand (the starting
/// prompt), and anything added goes before it. A launch that passes its own settings
/// (a [`LaunchSettings::Flag`] CLI's flag, inline JSON or a file) has them folded into
/// the private copy written in `directory`, which the flag then names in their place;
/// with no `directory`, such a CLI is not prepared.
fn prepared_arguments(
    adapter: &dyn AgentCliAdapter,
    arguments: &[OsString],
    directory: Option<&Path>,
    helper: &str,
    home: Option<PathBuf>,
) -> io::Result<Vec<OsString>> {
    let (options, operands) = arguments.split_at(crate::agent_cli::operands_at(arguments));
    // An option that is not UTF-8 is held behind a token of its own, which preparing
    // keeps in place, and goes back in unchanged.
    let mut held = Vec::new();
    let mut options: Vec<String> = options
        .iter()
        .map(|option| match option.to_str() {
            Some(option) => option.to_owned(),
            None => {
                let token = format!("{ARGV_SLOT}{}", held.len());
                held.push((token.clone(), option.clone()));
                token
            }
        })
        .collect();
    let delivery = &adapter.descriptor().launch_settings;
    if let LaunchSettings::Flag(flag) = delivery {
        // A settings flag whose joined value is not UTF-8 cannot be folded in.
        let joined = format!("{flag}=");
        if held
            .iter()
            .any(|(_, option)| option.as_encoded_bytes().starts_with(joined.as_bytes()))
        {
            return Err(io::Error::other("invalid launch settings"));
        }
    }
    let given = match delivery {
        LaunchSettings::Flag(flag) => take_settings_flag(&mut options, flag)?,
        LaunchSettings::Overrides(_) => None,
        LaunchSettings::Env(_) | LaunchSettings::HomeConfig { .. } => None,
    };
    let settings = match &given {
        Some((_, value)) if value.trim_start().starts_with('{') => {
            serde_json::from_str(value).map_err(io::Error::other)?
        }
        Some((_, value)) => {
            let file = std::fs::File::open(value)?;
            if file.metadata()?.len() > 1024 * 1024 {
                return Err(io::Error::other("launch settings too large"));
            }
            serde_json::from_reader(file).map_err(io::Error::other)?
        }
        None => match delivery {
            LaunchSettings::HomeConfig { file } => {
                let home = home
                    .as_deref()
                    .ok_or_else(|| io::Error::other("CLI home unavailable"))?;
                match std::fs::read(home.join(file)) {
                    Ok(bytes) => serde_yaml::from_slice::<serde_json::Value>(&bytes)
                        .map_err(io::Error::other)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => serde_json::json!({}),
                    Err(error) => return Err(error),
                }
            }
            _ => serde_json::json!({}),
        },
    };
    let mut launch = Prepare::new(options, settings, helper);
    launch.home = home.clone();
    adapter.prepare(&mut launch).map_err(io::Error::other)?;
    let mut output = launch.arguments;
    match delivery {
        LaunchSettings::Flag(flag) => {
            let directory =
                directory.ok_or_else(|| io::Error::other("no directory for launch settings"))?;
            let path = directory.join("settings.json");
            let mut file = create_new_owner_only(&path)?;
            serde_json::to_writer(&mut file, &launch.settings).map_err(io::Error::other)?;
            let path = path
                .into_os_string()
                .into_string()
                .map_err(|_| io::Error::other("launch settings path is not UTF-8"))?;
            // In the place and form the launch gave its own, else after the options.
            let flag = match given {
                Some((true, _)) => vec![format!("{flag}={path}")],
                _ => vec![flag.clone(), path],
            };
            match output.iter().position(|option| option == ARGV_SLOT) {
                Some(at) => {
                    output.splice(at..=at, flag);
                }
                None => output.extend(flag),
            }
        }
        LaunchSettings::Overrides(_) => output.extend(
            delivery
                .overrides(&launch.settings)
                .ok_or_else(|| io::Error::other("launch settings cannot be overrides"))?,
        ),
        LaunchSettings::Env(_) => {}
        LaunchSettings::HomeConfig { file } => {
            write_home_config(
                home.as_deref()
                    .ok_or_else(|| io::Error::other("CLI home unavailable"))?,
                file,
                &launch.settings,
            )?;
        }
    }
    Ok(output
        .into_iter()
        .map(|option| {
            held.iter()
                .find(|(token, _)| *token == option)
                .map_or_else(|| OsString::from(option), |(_, original)| original.clone())
        })
        .chain(operands.iter().cloned())
        .collect())
}

/// Merge only observer-owned keys into a CLI home, preserving its other configuration.
/// The completed owner-only file replaces the old file in one rename.
pub fn write_home_config(home: &Path, file: &str, settings: &serde_json::Value) -> io::Result<()> {
    let path = home.join(file);
    let mut document: serde_yaml::Mapping = match std::fs::read(&path) {
        Ok(bytes) => serde_yaml::from_slice::<Option<serde_yaml::Mapping>>(&bytes)
            .map_err(io::Error::other)?
            .unwrap_or_default(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => serde_yaml::Mapping::new(),
        Err(error) => return Err(error),
    };
    for key in ["hooks", "hooks_auto_accept"] {
        if let Some(value) = settings.get(key) {
            document.insert(
                serde_yaml::Value::String(key.into()),
                serde_yaml::to_value(value).map_err(io::Error::other)?,
            );
        }
    }
    let staged = home.join(format!(".{file}.{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = create_new_owner_only(&staged)?;
        serde_yaml::to_writer(&mut output, &document).map_err(io::Error::other)?;
        output.sync_all()?;
        std::fs::rename(&staged, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(staged);
    }
    result
}

/// Takes the launch's own `flag` out of `options`, leaving [`ARGV_SLOT`] in its place:
/// whether its value was joined by `=`, and the value.
fn take_settings_flag(options: &mut Vec<String>, flag: &str) -> io::Result<Option<(bool, String)>> {
    let Some(given) = find_settings_flag(options, flag).map_err(|error| match error {
        SettingsFlagError::NoValue => io::Error::other("invalid launch settings"),
        SettingsFlagError::Repeated => io::Error::other("ambiguous launch settings"),
    })?
    else {
        return Ok(None);
    };
    options.splice(given.range, [ARGV_SLOT.to_owned()]);
    Ok(Some((given.joined, given.value)))
}

/// Lets a test answer this thread's `--version` probes without starting a process, and
/// read the budget each was given.
#[cfg(test)]
mod probe_stub {
    use std::{cell::RefCell, time::Duration};

    thread_local! {
        static STUB: RefCell<Option<(String, Vec<Duration>)>> = const { RefCell::new(None) };
    }

    /// Answer the calling thread's probes with `version` from now on.
    pub(super) fn install(version: &str) {
        STUB.with(|stub| *stub.borrow_mut() = Some((version.to_owned(), Vec::new())));
    }

    /// The budget of every probe answered since [`install`].
    pub(super) fn budgets() -> Vec<Duration> {
        STUB.with(|stub| {
            stub.borrow_mut()
                .take()
                .map(|(_, log)| log)
                .unwrap_or_default()
        })
    }

    pub(super) fn answer(budget: Duration) -> Option<String> {
        STUB.with(|stub| {
            let mut stub = stub.borrow_mut();
            let (version, log) = stub.as_mut()?;
            log.push(budget);
            Some(version.clone())
        })
    }
}

/// The transport used where the unix one isn't, compiled into the tests too so its
/// outcomes are pinned on every runner.
#[cfg(test)]
#[path = "launch/off.rs"]
#[allow(dead_code)]
mod off_transport;

#[cfg(test)]
mod tests {
    use super::*;
    // Unix only, as the tests that read unix modes are.
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn non_home_config_preparation_keeps_its_existing_fallback_contract() {
        let directory = tempfile::tempdir().unwrap();
        for provider in [
            crate::agent_cli::AgentCli::Claude,
            crate::agent_cli::AgentCli::Codex,
            crate::agent_cli::AgentCli::OpenCode,
        ] {
            let result = prepare_direct(
                provider,
                std::ffi::OsStr::new("/missing/cli"),
                &["--settings".into(), "/missing/settings".into()],
                "/helper",
                None,
                Some(directory.path()),
            );
            assert!(result.fatal_error.is_none());
        }
    }

    #[test]
    fn home_config_fold_preserves_scoped_block_and_unrelated_key_on_relaunch() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.yaml");
        std::fs::write(&path, "unrelated: {keep: true}\nhooks:\n  pre_tool_call:\n    - {matcher: '^write_file$', command: '--hook-block hermes', fail_closed: true}\n").unwrap();
        let adapter = crate::agent_cli::adapter(crate::agent_cli::AgentCli::Hermes);
        for _ in 0..2 {
            prepared_arguments(adapter, &[], None, "/helper", Some(home.path().into())).unwrap();
            let settings: serde_json::Value =
                serde_yaml::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(settings["unrelated"]["keep"], true);
            let blocks = settings["hooks"]["pre_tool_call"].as_array().unwrap();
            assert_eq!(blocks.len(), 2);
            assert_eq!(
                blocks[0]["command"],
                format!("{} --hook-block hermes", crate::shell_quote("/helper"))
            );
        }
    }

    // Unix only: it reads a unix mode.
    #[cfg(unix)]
    #[test]
    fn home_config_merge_preserves_other_fields_and_replaces_observer_keys_once() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.yaml");
        std::fs::write(
            &path,
            "model: chosen\napi_key: preserved\nhooks:\n  old: obsolete\n",
        )
        .unwrap();
        let settings = serde_json::json!({"hooks":{"agent:start":["helper"]}, "hooks_auto_accept":true, "model":"ignored"});
        for _ in 0..2 {
            write_home_config(home.path(), "config.yaml", &settings).unwrap();
        }
        let config: serde_yaml::Value =
            serde_yaml::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["model"].as_str(), Some("chosen"));
        assert_eq!(config["api_key"].as_str(), Some("preserved"));
        assert_eq!(config["hooks"].as_mapping().unwrap().len(), 1);
        assert_eq!(config["hooks_auto_accept"].as_bool(), Some(true));
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
    }

    // Unix only: the stub CLIs are made executable with a unix mode.
    #[cfg(unix)]
    #[test]
    fn non_cached_adapters_run_the_live_version_probe() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        for cli in AgentCli::ALL {
            let adapter = crate::agent_cli::adapter(cli);
            if adapter.probe().cache_version {
                continue;
            }
            let program = root.path().join(cli.as_str());
            std::fs::write(
                &program,
                "#!/bin/sh\nprintf 'live-version\\n'\nprintf live > \"$0.ran\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
            crate::agent_cli::version_cache::seed_for_test(&program, "cached-version").unwrap();
            // A generous budget: under full-suite load the 1 s production budget
            // can kill the shim before it writes its marker.
            let _ = version_qualified_within(
                program.as_os_str(),
                adapter,
                None,
                std::time::Duration::from_secs(10),
            );
            assert!(
                program.with_extension("ran").is_file(),
                "{cli}: the live probe must run"
            );
        }
    }

    // Unix only: the stub CLIs are made executable with a unix mode.
    #[cfg(unix)]
    #[test]
    fn hand_typed_release_probes_ignore_poisoned_cache_without_a_managed_identity() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let shims = root.path().join("shims");
        std::fs::create_dir(&shims).unwrap();
        for (cli, program, cached, live) in [
            (
                AgentCli::Codex,
                root.path().join("codex"),
                "codex-cli 0.162.1",
                "codex-cli 0.158.0",
            ),
            (
                AgentCli::Hermes,
                shims.join("hermes"),
                "Hermes Agent v0.22.5",
                "Hermes Agent v0.22.6",
            ),
        ] {
            std::fs::write(
                &program,
                format!("#!/bin/sh\nprintf '%s\\n' '{live}'\nprintf live > \"$0.ran\"\n"),
            )
            .unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
            crate::agent_cli::version_cache::seed_for_test(&program, cached).unwrap();
            assert_eq!(
                crate::agent_cli::version_cache::peek_for_test(&program).as_deref(),
                Some(cached)
            );
            assert_eq!(
                observed_release(crate::agent_cli::adapter(cli), program.as_os_str(), None),
                (None, true)
            );
            assert!(
                program.with_extension("ran").exists(),
                "the live script must run"
            );
        }
    }

    // Unix only: the stub CLI is made executable with a unix mode.
    #[cfg(unix)]
    #[test]
    fn a_failed_release_probe_does_not_claim_codex_needs_an_update() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("codex");
        for body in ["exit 1", "sleep 2; echo codex-cli 0.162.1"] {
            std::fs::write(&program, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
            let prepared = prepare_direct(
                AgentCli::Codex,
                program.as_os_str(),
                &[],
                "/app/helper",
                None,
                None,
            );
            assert!(prepared.arguments.is_none());
            assert!(!prepared.inbox_update_required);
            assert_eq!(
                prepared.unqualified_reason,
                Some("version probe failed or timed out")
            );
        }
    }

    /// An executable `cli` in `directory` that runs the shell `body`.
    // Unix only: the stub CLI is made executable with a unix mode.
    #[cfg(unix)]
    fn fixture_cli(directory: &Path, cli: AgentCli, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let program = directory.join(cli.as_str());
        std::fs::write(&program, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        program
    }

    /// CLIs whose release is read from `--version`.
    fn version_probed() -> impl Iterator<Item = AgentCli> {
        AgentCli::every_cli().filter(|cli| {
            matches!(
                crate::agent_cli::adapter(*cli).probe().activity,
                ActivityProbe::Version
            )
        })
    }

    /// `prepare_direct` hands each CLI's own budget to its `--version` probe (Hermes 5 s,
    /// Codex 1 s), and qualifies exactly the release its range names. The probe is
    /// answered by the test, so no process or clock decides the result.
    #[test]
    fn prepare_direct_gives_each_cli_its_own_version_budget() {
        for cli in version_probed() {
            let adapter = crate::agent_cli::adapter(cli);
            for (output, qualifies) in [
                (cli_release_output(cli), true),
                ("nonsense 0.0.0".to_owned(), false),
            ] {
                let directory = tempfile::tempdir().unwrap();
                let home = directory.path().join("home");
                std::fs::create_dir(&home).unwrap();
                probe_stub::install(&output);
                let prepared = prepare_direct(
                    cli,
                    std::ffi::OsStr::new("/fixture/cli"),
                    &[],
                    "/app/helper",
                    Some(home),
                    Some(directory.path()),
                );
                assert_eq!(
                    probe_stub::budgets(),
                    [adapter.probe().version_budget],
                    "{cli}"
                );
                assert_eq!(prepared.arguments.is_some(), qualifies, "{cli}: {output}");
            }
        }
        let budget = |cli| crate::agent_cli::adapter(cli).probe().version_budget;
        assert_eq!(budget(AgentCli::Hermes), std::time::Duration::from_secs(5));
        assert_eq!(
            budget(AgentCli::Codex),
            crate::agent_cli::DEFAULT_VERSION_BUDGET
        );
    }

    fn cli_release_output(cli: AgentCli) -> String {
        crate::agent_cli::descriptor(cli).release.minimum_output()
    }

    /// A real probe process that is slow to answer still qualifies, however slow: the
    /// fixture answers once this test releases it (after it has demonstrably started), and
    /// the budget is far longer than any machine load, so no clock races.
    // Unix only: its stub CLI comes from the unix-only `fixture_cli`.
    #[cfg(unix)]
    #[test]
    fn a_slow_version_probe_qualifies_when_it_answers_within_its_budget() {
        let root = tempfile::tempdir().unwrap();
        for cli in version_probed() {
            let adapter = crate::agent_cli::adapter(cli);
            for (output, qualifies) in [
                (cli_release_output(cli), true),
                ("nonsense 0.0.0".into(), false),
            ] {
                let directory = tempfile::tempdir_in(root.path()).unwrap();
                let program = fixture_cli(
                    directory.path(),
                    cli,
                    &format!(
                        "d=$(dirname \"$0\"); : > \"$d/started\"; while [ ! -e \"$d/go\" ]; do sleep 0.02; done; printf '%s\\n' '{output}'"
                    ),
                );
                let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let releaser = std::thread::spawn({
                    let (dir, finished) = (directory.path().to_owned(), finished.clone());
                    move || {
                        while !finished.load(std::sync::atomic::Ordering::Acquire) {
                            if dir.join("started").exists() {
                                let _ = std::fs::File::create(dir.join("go"));
                                return;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                    }
                });
                let qualified = version_qualified_within(
                    program.as_os_str(),
                    adapter,
                    None,
                    std::time::Duration::from_secs(120),
                );
                finished.store(true, std::sync::atomic::Ordering::Release);
                releaser.join().unwrap();
                assert_eq!(qualified, Some(qualifies), "{cli}: {output}");
            }
        }
    }

    /// A probe that does not answer within its budget is unqualified once the budget has
    /// passed, and leaves no child behind.
    // Unix only: its stub CLI comes from `fixture_cli`, and it probes the child with `libc::kill`.
    #[cfg(unix)]
    #[test]
    fn version_probe_past_its_budget_is_unqualified_and_reaped() {
        let budget = std::time::Duration::from_millis(1500);
        let root = tempfile::tempdir().unwrap();
        for cli in version_probed() {
            let adapter = crate::agent_cli::adapter(cli);
            let directory = tempfile::tempdir_in(root.path()).unwrap();
            let pid = directory.path().join("pid");
            let program = fixture_cli(
                directory.path(),
                cli,
                &format!(
                    "printf '%s' $$ > '{}'; sleep 600; printf '%s\\n' '{}'",
                    pid.display(),
                    cli_release_output(cli)
                ),
            );
            let started = std::time::Instant::now();
            assert_eq!(
                version_qualified_within(program.as_os_str(), adapter, None, budget),
                None,
                "{cli}"
            );
            assert!(started.elapsed() >= budget, "{cli}: gave up early");
            assert!(
                started.elapsed() < std::time::Duration::from_secs(30),
                "{cli}"
            );
            // A fixture killed before its shell wrote its pid has left nothing to reap.
            if let Some(pid) = std::fs::read_to_string(pid)
                .ok()
                .and_then(|pid| pid.parse::<i32>().ok())
            {
                // SAFETY: signal 0 only checks that the pid names a live process.
                assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "{cli}: child left");
            }
        }
    }

    fn claude_arguments(arguments: &[OsString], directory: &Path) -> io::Result<Vec<OsString>> {
        prepared_arguments(
            crate::agent_cli::adapter(AgentCli::Claude),
            arguments,
            Some(directory),
            "/app/helper",
            None,
        )
    }

    #[test]
    fn one_shot_runs_are_recognised_before_the_prompt() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        let one_shot = |cli: AgentCli, arguments: &[OsString]| {
            crate::agent_cli::descriptor(cli).one_shot(arguments)
        };
        assert!(one_shot(AgentCli::Claude, &args(&["-p", "hi"])));
        assert!(one_shot(
            AgentCli::Claude,
            &args(&["--model", "x", "--print"])
        ));
        assert!(!one_shot(AgentCli::Claude, &args(&["fix it"])));
        assert!(!one_shot(AgentCli::Claude, &args(&["--", "-p"])));
        assert!(one_shot(
            AgentCli::Codex,
            &args(&["-c", "k=v", "exec", "go"])
        ));
        assert!(!one_shot(AgentCli::Codex, &args(&["resume"])));
    }

    #[test]
    fn inline_and_equals_settings_are_merged_not_skipped() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("user.json");
        std::fs::write(&source, r#"{"permissions":{"allow":["Read"]}}"#).unwrap();
        for (index, flag) in [
            format!("--settings={}", source.display()),
            r#"--settings={"permissions":{"allow":["Read"]}}"#.to_owned(),
        ]
        .into_iter()
        .enumerate()
        {
            let generated = directory.path().join(format!("private-{index}"));
            std::fs::create_dir(&generated).unwrap();
            let arguments = vec![OsString::from(&flag), OsString::from("--verbose")];
            let composed = claude_arguments(&arguments, &generated).unwrap();
            assert_eq!(composed.len(), 2, "{flag}");
            let path = composed[0]
                .to_str()
                .unwrap()
                .strip_prefix("--settings=")
                .unwrap()
                .to_owned();
            let settings: serde_json::Value =
                serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
            assert_eq!(settings["permissions"]["allow"][0], "Read");
            assert!(settings["hooks"]["Notification"].is_array());
        }
        // Our flag goes first, so a prompt after `--` stays the prompt.
        let generated = directory.path().join("private-prompt");
        std::fs::create_dir(&generated).unwrap();
        let arguments = vec![OsString::from("--"), OsString::from("--settings")];
        let composed = claude_arguments(&arguments, &generated).unwrap();
        assert_eq!(composed[0], "--settings");
        assert_eq!(&composed[2..], &arguments[..]);
    }

    // Unix only: it reads a unix mode.
    #[cfg(unix)]
    #[test]
    fn private_launch_settings_preserve_existing_handlers_and_source_file() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("user.json");
        let original = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]},"permissions":{"allow":["Read"]}}"#;
        std::fs::write(&source, original).unwrap();
        let generated = directory.path().join("private");
        std::fs::create_dir(&generated).unwrap();
        let arguments = vec![
            OsString::from("--settings"),
            source.clone().into_os_string(),
            OsString::from("--verbose"),
        ];
        let composed = claude_arguments(&arguments, &generated).unwrap();
        assert_eq!(std::fs::read_to_string(source).unwrap(), original);
        assert_eq!(composed[0], "--settings");
        assert_eq!(composed[2], "--verbose");
        let settings: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(&composed[1]).unwrap()).unwrap();
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "user-hook"
        );
        // The user's handler, then the observer and the inbox waiter.
        let stop = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 3);
        assert!(stop[2]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(crate::agent_cli::INBOX_WAIT_ARG));
        assert_eq!(settings["permissions"]["allow"][0], "Read");
        assert_eq!(
            std::fs::metadata(&composed[1]).unwrap().mode() & 0o777,
            0o600
        );
    }

    /// A page launch types `--settings <file>` with the status hooks in that file. Run under
    /// the activity wrapper, the file's status hooks survive and the observer (which sees the
    /// session start, the signal that the CLI is input-ready) is folded in beside them.
    #[test]
    fn a_page_launch_settings_file_keeps_its_status_hooks_and_gains_the_observer() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("page.json");
        let status = r#"[ -x "$HOST/notify" ] && "$HOST/notify" || true"#;
        let hooks: serde_json::Value = ["Stop", "UserPromptSubmit", "PreToolUse"]
            .iter()
            .map(|event| {
                (
                    (*event).to_owned(),
                    serde_json::json!([{"hooks": [{"type": "command", "command": status}]}]),
                )
            })
            .collect::<serde_json::Map<_, _>>()
            .into();
        std::fs::write(&source, serde_json::json!({"hooks": hooks}).to_string()).unwrap();
        let generated = directory.path().join("private");
        std::fs::create_dir(&generated).unwrap();
        let arguments = vec![
            OsString::from("--model"),
            OsString::from("m"),
            OsString::from("--settings"),
            source.clone().into_os_string(),
        ];
        let composed = claude_arguments(&arguments, &generated).unwrap();
        let at = composed.iter().position(|a| a == "--settings").unwrap();
        let settings: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(&composed[at + 1]).unwrap()).unwrap();
        for event in ["Stop", "UserPromptSubmit", "PreToolUse"] {
            assert_eq!(
                settings["hooks"][event][0]["hooks"][0]["command"], status,
                "{event}: the page's status hook is kept first"
            );
        }
        assert!(
            settings["hooks"]["SessionStart"].is_array(),
            "the observer hears the session start"
        );
    }

    /// A starting prompt after `--` is an operand: an added `--settings` goes before the
    /// separator, and a prompt that reads `--settings` is never taken for the flag.
    #[test]
    fn launch_settings_are_added_before_the_prompt_operand() {
        let directory = tempfile::tempdir().unwrap();
        let arguments = vec![
            OsString::from("--strict-mcp-config"),
            OsString::from("--"),
            OsString::from("--settings"),
        ];
        let composed = claude_arguments(&arguments, directory.path()).unwrap();
        assert_eq!(composed.len(), 5);
        assert_eq!(composed[0], "--strict-mcp-config");
        assert_eq!(composed[1], "--settings");
        assert_eq!(composed[3], "--");
        assert_eq!(composed[4], "--settings");
    }

    /// A CLI that takes its observer as argv keeps its options' order and its operands, and
    /// gets the observer ahead of the prompt.
    #[test]
    fn an_override_cli_gets_its_observer_before_the_prompt() {
        let directory = tempfile::tempdir().unwrap();
        let arguments = vec![
            OsString::from("--model"),
            OsString::from("m"),
            OsString::from("--"),
            OsString::from("hello"),
        ];
        let composed = prepared_arguments(
            crate::agent_cli::adapter(AgentCli::Codex),
            &arguments,
            Some(directory.path()),
            "/app/helper",
            None,
        )
        .unwrap();
        assert_eq!(composed[0], "--no-daemon");
        assert_eq!(&composed[1..3], &arguments[..2]);
        assert_eq!(&composed[composed.len() - 2..], &arguments[2..]);
        assert!(composed
            .iter()
            .any(|a| a.to_string_lossy().starts_with("hooks.SessionStart=")));
        // Nothing is written for it.
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    /// An option that is not UTF-8 goes through unchanged, and the run is still observed.
    // Unix only: non-UTF-8 arguments are built with `OsStringExt`.
    #[cfg(unix)]
    #[test]
    fn a_non_utf8_option_keeps_its_place_and_the_observer() {
        use std::os::unix::ffi::OsStringExt;
        let directory = tempfile::tempdir().unwrap();
        let odd = OsString::from_vec(vec![b'/', 0xff, b'x']);
        let arguments = vec![
            OsString::from("--add-dir"),
            odd.clone(),
            OsString::from("--"),
            OsString::from("hi"),
        ];
        let composed = claude_arguments(&arguments, directory.path()).unwrap();
        assert_eq!(&composed[..2], &arguments[..2]);
        assert_eq!(composed[2], "--settings");
        assert_eq!(&composed[4..], &arguments[2..]);
    }

    /// A launch's own settings flag joined to a value that is not UTF-8 cannot be folded
    /// in, so the run is not given a second one.
    // Unix only: non-UTF-8 arguments are built with `OsStringExt`.
    #[cfg(unix)]
    #[test]
    fn a_non_utf8_joined_settings_flag_is_refused() {
        use std::os::unix::ffi::OsStringExt;
        let directory = tempfile::tempdir().unwrap();
        let mut flag = b"--settings=/".to_vec();
        flag.push(0xff);
        let arguments = vec![OsString::from_vec(flag)];
        assert!(claude_arguments(&arguments, directory.path()).is_err());
    }

    /// Where the probe isn't ported it qualifies nothing, so the CLI runs unqualified; it
    /// starts no process and prints nothing. The exec verbs fail as capability-off.
    #[test]
    fn the_off_unix_probe_is_unqualified_and_the_exec_verbs_are_capability_off() {
        for cli in version_probed() {
            let adapter = crate::agent_cli::adapter(cli);
            let budget = adapter.probe().version_budget;
            let program = std::ffi::OsStr::new("/missing/cli");
            let qualified = off_transport::version_probe(program, adapter, None, None, budget);
            assert_eq!(qualified, None, "{cli}");
        }
        let arguments = [OsString::from("--"), OsString::from("/missing/cli")];
        for error in [
            off_transport::exec_managed_shell(&arguments),
            off_transport::exec_claimed(&arguments),
        ] {
            assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        }
    }

    /// The managed-shell helper's first steps: it takes the bootstrap its host wrote, once,
    /// and binds the invocation through the host's socket. A bootstrap replaced by a link
    /// or opened to others is refused.
    // Unix only: it sets unix modes and makes a symlink.
    #[cfg(unix)]
    #[test]
    fn a_managed_shell_bootstrap_is_taken_once_and_a_replaced_or_shared_one_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = std::sync::Arc::new(ActivityOwner::new());
        let service = crate::activity::ActivityService::start(root.path(), &owner, None).unwrap();
        // This test process is the CLI; its parent stands in for the shell the host spawned.
        owner.register("shell", Some(std::os::unix::process::parent_id()));
        let launch = || {
            let launch = prepare_shell_launch(
                &owner,
                "shell",
                AgentCli::Claude,
                service.path(),
                Path::new("/helper"),
            )
            .unwrap();
            PathBuf::from(launch.bootstrap)
        };

        let replaced = launch();
        let elsewhere = root.path().join("elsewhere.json");
        std::fs::rename(&replaced, &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &replaced).unwrap();
        assert!(read_bootstrap(&replaced).is_err());
        assert!(elsewhere.exists(), "the file a link names is not taken");

        let shared = launch();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_bootstrap(&shared).is_err());
        assert!(shared.exists());

        let path = launch();
        let bootstrap = read_bootstrap(&path).unwrap();
        assert_eq!(bootstrap.provider, AgentCli::Claude);
        assert_eq!(Path::new(&bootstrap.writer.socket), service.path());
        assert!(!path.exists(), "taken once");
        assert!(read_bootstrap(&path).is_err());
        let socket = Path::new(&bootstrap.writer.socket);
        super::super::ingress::bind_shell(socket, &bootstrap.writer.token, false).unwrap();
        // Committed: a second bind of the same invocation is refused.
        assert!(super::super::ingress::bind_shell(socket, &bootstrap.writer.token, false).is_err());
    }
}
