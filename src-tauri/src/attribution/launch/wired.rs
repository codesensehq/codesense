// SPDX-License-Identifier: MIT
//! The git-ai half of a launch, the doctor and a config reapply: compiled only with the `git-ai`
//! capability. [`super`]'s entry points decide from the caps answer before they call in here.

use super::*;
use crate::attribution::detect::{detect, Detection};
use crate::attribution::facade::ReplacementNotice;
use crate::attribution::install;
use crate::attribution::managed::{self, ConfigError, Managed};

/// The plan for a launch whose repo captures with `notes`: install, configure and start
/// git-ai, then wire its trace and checkpoint hook.
pub(super) fn plan(
    request: &Request<'_>,
    path_var: Option<&OsStr>,
    notes: NotesMode,
    attribution_hook_trust: bool,
) -> Plan {
    if let Some(status) = install::platform_status(request.codesense_home) {
        return Plan::without(status, None);
    }
    if codesense_pty_core::agent_cli::descriptor(request.runtime).attribution_hook_trust
        && !attribution_hook_trust
    {
        return Plan::without(
            AttributionStatus::Error {
                message: "The terminal server is outdated; restart it to enable line attribution."
                    .into(),
            },
            None,
        );
    }
    let managed = Managed::for_codesense_home(request.codesense_home);
    let detection = detect(request.codesense_home, path_var, &managed.daemon_env());
    if install::needs_install(request.codesense_home, &detection) {
        install::ensure_installed(request.codesense_home, path_var, install::Trigger::Launch);
    }
    let unavailable = |fallback| install::status(request.codesense_home).unwrap_or(fallback);
    let (binary, version) = match detection {
        Detection::NotInstalled => {
            return Plan::without(unavailable(AttributionStatus::NotInstalled), None)
        }
        Detection::Broken { message, .. } => {
            return Plan::without(unavailable(AttributionStatus::Error { message }), None)
        }
        Detection::Found { path, raw, version } => {
            if let Some(status) = install::capture_status(request.codesense_home, &raw, version) {
                return Plan::without(status, Some(raw));
            }
            (path, raw)
        }
    };
    let configured = match managed.apply_config(&binary, &version, || {
        managed::lists(request.codesense_home)
    }) {
        // A binary that cannot keep notes local still captures a repo whose notes push.
        Err(ConfigError::LocalNotesUnsupported(_)) if notes == NotesMode::Push => Ok(()),
        Err(ConfigError::LocalNotesUnsupported(_)) => {
            return Plan::without(
                AttributionStatus::Off {
                    reason: OffReason::NotesWouldPush,
                },
                Some(version),
            )
        }
        Err(ConfigError::Failed(message)) => Err(message),
        // The daemon ignores a repo outside the roots just written (a worktree whose clone is
        // not attached), so wiring it would record nothing.
        Ok(lists) if !managed::RepoRoots::daemon_tracks(&lists.repo_roots, request.cwd) => {
            return Plan::without(
                AttributionStatus::Off {
                    reason: OffReason::RepoNotAttached,
                },
                Some(version),
            )
        }
        Ok(_) => Ok(()),
    };
    let ready = configured.and_then(|()| managed.ensure_daemon(&binary, &version));
    if let Err(message) = ready {
        let status = if managed.restart_pending(Some(&version)) {
            AttributionStatus::Off {
                reason: OffReason::NotesWouldPush,
            }
        } else {
            AttributionStatus::Error { message }
        };
        return Plan::without(status, Some(version));
    }
    Plan {
        status: AttributionStatus::Active,
        git_ai_version: Some(version),
        // Git's trace events go to the managed daemon only, and a user's own git-ai hook
        // cannot reach any daemon.
        env: vec![
            (
                "GIT_TRACE2_EVENT".into(),
                format!("af_unix:stream:{}", Path::display(&managed.trace_socket())),
            ),
            ("GIT_TRACE2_EVENT_NESTING".into(), "0".into()),
        ]
        .into_iter()
        .chain(USER_DAEMON_NEUTRALISED.map(|(key, value)| (key.to_owned(), value.to_owned())))
        .collect(),
        hook_command: Some(managed.checkpoint_command(&binary, AgentCli::as_str(request.runtime))),
    }
}

/// [`super::reapply_config`] with git-ai compiled in.
pub(super) fn reapply(home: &Path) -> Reapplied {
    let managed = Managed::for_codesense_home(home);
    let Detection::Found { path, raw, .. } = detect(home, None, &managed.daemon_env()) else {
        return Reapplied::Pending;
    };
    match managed.apply_config(&path, &raw, || managed::lists(home)) {
        Ok(_) => Reapplied::Now,
        Err(ConfigError::LocalNotesUnsupported(message)) => Reapplied::Unsupported { message },
        Err(ConfigError::Failed(message)) => Reapplied::Failed { message },
    }
}

/// [`super::doctor_with`] with git-ai compiled in.
pub(super) fn doctor(
    codesense_home: &Path,
    path_var: Option<&OsStr>,
    notice: ReplacementNotice,
) -> Doctor {
    let managed = Managed::for_codesense_home(codesense_home);
    let daemon_reachable = managed.daemon_reachable();
    let done = |status, binary: Option<&Path>, version: Option<String>| {
        let warnings = install::warning(codesense_home, notice)
            .into_iter()
            .chain(
                managed
                    .restart_pending(version.as_deref())
                    .then(|| "git-ai daemon restart pending; the next launch restarts it".into()),
            )
            .chain(matches!(&status, AttributionStatus::Unsupported { reason } if reason == "user_pinned")
                .then(|| install::USER_PIN_RECOVERY.to_string()))
            .chain(crate::attribution::detect::user_copy_present(codesense_home, path_var)
                .then(|| "user_copy_present: a git-ai on PATH is left untouched and is never used for capture".into()))
            .chain(user_hooks_present(&HookSettings {
                user_home: &managed::UserGit::current().home,
                claude_config_dir: std::env::var_os("CLAUDE_CONFIG_DIR").as_deref().map(Path::new),
                codex_home: std::env::var_os("CODEX_HOME").as_deref().map(Path::new),
                projects: &prefs::all_attached_checkouts(codesense_home),
            })
            .then(|| "user_hooks_present: your own git-ai checkpoint hooks cannot reach a daemon in CodeSense sessions with capture on, so one checkpoint counts".into()))
            .collect();
        Doctor {
            status,
            binary: binary.map(|p| p.to_string_lossy().into_owned()),
            git_ai_version: version,
            daemon_reachable,
            warnings,
            previous_binary: install::previous_binary(codesense_home),
            supported_versions: install::expected_version(codesense_home),
            capture: crate::attribution::catch_up::capture(codesense_home),
            notes_ref: managed::NOTES_REF,
            notes_push_repos: prefs::push_repos(codesense_home),
            daemon_repo_roots: managed::RepoRoots::listed_count(&managed::repo_roots(
                codesense_home,
            )),
        }
    };
    if let Some(status) = install::platform_status(codesense_home) {
        return done(status, None, None);
    }
    match detect(codesense_home, path_var, &managed.daemon_env()) {
        Detection::NotInstalled => done(
            install::status(codesense_home).unwrap_or(AttributionStatus::NotInstalled),
            None,
            None,
        ),
        Detection::Broken { path, message } => done(
            install::status(codesense_home).unwrap_or(AttributionStatus::Error { message }),
            Some(&path),
            None,
        ),
        Detection::Found { path, raw, version } => {
            if let Some(status) = install::capture_status(codesense_home, &raw, version) {
                return done(status, Some(&path), Some(raw));
            }
            if managed.restart_pending(Some(&raw)) {
                return done(
                    AttributionStatus::Off {
                        reason: OffReason::NotesWouldPush,
                    },
                    Some(&path),
                    Some(raw),
                );
            }
            if daemon_reachable {
                done(AttributionStatus::Active, Some(&path), Some(raw))
            } else {
                done(
                    AttributionStatus::Error {
                        message: "git-ai daemon is not running; it starts with the next launch"
                            .into(),
                    },
                    Some(&path),
                    Some(raw),
                )
            }
        }
    }
}
