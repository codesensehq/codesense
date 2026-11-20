// SPDX-License-Identifier: MIT
//! The hook commands CodeSense writes into Claude's settings: `codesense-bridge hook <verb>`
//! from the tab's host root, in the form the **target** host runs. A writer passes the target
//! of the host that will run the hook (a remote host is POSIX), never its own OS.
//!
//! Each command is guarded: a tab outside any host, or a host whose root has no bridge, runs a
//! hook that does nothing and succeeds, so a missing bridge allows as a missing hook does.

/// A terminal's host activity root, exported to every shell it runs. The root holds the
/// bridge the hooks run.
pub const HOST_ENV: &str = "CODESENSE_ACTIVITY_HOST";

/// The bridge's file name in a host's activity root, before the OS's executable suffix.
pub const BRIDGE: &str = "codesense-bridge";

/// How long Claude lets a hook run, in seconds.
const TIMEOUT_SECS: u64 = 5;

/// The `codesense-bridge hook` subcommands Claude's hooks run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Verb {
    /// Post the lifecycle event to the app ([`super::notify`]).
    Notify,
    /// Deny a call that would read a credential file ([`super::secret_guard`]).
    SecretGuard,
}

impl Verb {
    pub const ALL: [Verb; 2] = [Verb::Notify, Verb::SecretGuard];

    /// The subcommand as the bridge reads it.
    pub fn as_str(self) -> &'static str {
        match self {
            Verb::Notify => "notify",
            Verb::SecretGuard => "secret-guard",
        }
    }
}

/// The OS of the host that runs a hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookTarget {
    /// Linux and macOS: Claude runs the command in a POSIX shell.
    Posix,
    /// Windows: the command names PowerShell as its shell, so it runs the same whether or not
    /// Git Bash is installed.
    Windows,
}

impl HookTarget {
    pub const ALL: [HookTarget; 2] = [HookTarget::Posix, HookTarget::Windows];

    /// The target for an OS named as `std::env::consts::OS` names it.
    pub fn for_os(os: &str) -> Self {
        if os == "windows" {
            HookTarget::Windows
        } else {
            HookTarget::Posix
        }
    }

    /// The target of the host this process runs on.
    pub fn local() -> Self {
        Self::for_os(std::env::consts::OS)
    }

    /// The bridge's file name in the target's activity root.
    pub fn bridge_file(self) -> String {
        match self {
            HookTarget::Posix => BRIDGE.to_string(),
            HookTarget::Windows => format!("{BRIDGE}.exe"),
        }
    }
}

/// One hook as a writer puts it into Claude's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookCommand {
    pub command: String,
    /// Claude's hook `shell`, when the target needs one named.
    pub shell: Option<&'static str>,
    /// Claude's hook `onFailure`, when the target needs a failure to allow.
    pub on_failure: Option<&'static str>,
    /// The part of `command` that tells this verb's hook from any other on the target: the
    /// bridge path's closing quote and the subcommand.
    pub marker: String,
}

impl HookCommand {
    /// The settings entry that runs this hook.
    pub fn entry(&self) -> serde_json::Value {
        let mut entry = serde_json::json!({
            "type": "command",
            "command": self.command,
            "timeout": TIMEOUT_SECS,
        });
        if let Some(shell) = self.shell {
            entry["shell"] = shell.into();
        }
        if let Some(on_failure) = self.on_failure {
            entry["onFailure"] = on_failure.into();
        }
        entry
    }
}

/// The hook command running `codesense-bridge hook <verb>` on `target`.
///
/// - **POSIX:** `[ -x … ] && … || true`; `[` reads no stdin, so the hook's JSON reaches the
///   bridge.
/// - **Windows:** a PowerShell command (Claude's `shell: "powershell"`). It checks the variable
///   is set first: unset, the path would be `\codesense-bridge.exe` at the drive's root. The
///   path is double-quoted, since PowerShell never expands `$env:` inside single quotes, and
///   the bridge is run with the hook's own stdin, never a PowerShell string, so the payload's
///   bytes reach it unchanged. `onFailure: "continue"`: a hook that fails on Windows would
///   otherwise block the tool call. The guard's deny is its printed decision, not a failure.
pub fn command(verb: Verb, target: HookTarget) -> HookCommand {
    let verb = verb.as_str();
    let bridge = target.bridge_file();
    match target {
        HookTarget::Posix => {
            let path = format!("\"${HOST_ENV}/{bridge}\"");
            HookCommand {
                command: format!("[ -x {path} ] && {path} hook {verb} || true"),
                shell: None,
                on_failure: None,
                marker: format!("{bridge}\" hook {verb}"),
            }
        }
        HookTarget::Windows => {
            let path = format!("\"$env:{HOST_ENV}\\{bridge}\"");
            HookCommand {
                command: format!(
                    "if ($env:{HOST_ENV} -and (Test-Path -LiteralPath {path})) {{ & {path} hook {verb} }}; exit 0"
                ),
                shell: Some("powershell"),
                on_failure: Some("continue"),
                marker: format!("{bridge}\" hook {verb}"),
            }
        }
    }
}

/// The hook commands an earlier CodeSense wrote, each with the verb that replaces it. A
/// settings entry whose command is exactly one of these (never a command that only contains
/// one) is rewritten in place with [`command`].
pub const LEGACY_COMMANDS: &[(Verb, &str)] = &[
    (
        Verb::Notify,
        r#"[ -x "$CODESENSE_ACTIVITY_HOST/codesense-notify.sh" ] && "$CODESENSE_ACTIVITY_HOST/codesense-notify.sh" || true"#,
    ),
    (
        Verb::SecretGuard,
        r#"[ -x "$CODESENSE_ACTIVITY_HOST/codesense-secret-guard.sh" ] && "$CODESENSE_ACTIVITY_HOST/codesense-secret-guard.sh" || true"#,
    ),
];

/// The verb whose hook an earlier CodeSense wrote as exactly `command`.
pub fn legacy_verb(command: &str) -> Option<Verb> {
    LEGACY_COMMANDS
        .iter()
        .find(|(_, legacy)| *legacy == command)
        .map(|(verb, _)| *verb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_target_writes_its_own_form() {
        let rows = [
            (
                Verb::Notify,
                HookTarget::Posix,
                r#"[ -x "$CODESENSE_ACTIVITY_HOST/codesense-bridge" ] && "$CODESENSE_ACTIVITY_HOST/codesense-bridge" hook notify || true"#,
                None,
                None,
            ),
            (
                Verb::SecretGuard,
                HookTarget::Posix,
                r#"[ -x "$CODESENSE_ACTIVITY_HOST/codesense-bridge" ] && "$CODESENSE_ACTIVITY_HOST/codesense-bridge" hook secret-guard || true"#,
                None,
                None,
            ),
            (
                Verb::Notify,
                HookTarget::Windows,
                r#"if ($env:CODESENSE_ACTIVITY_HOST -and (Test-Path -LiteralPath "$env:CODESENSE_ACTIVITY_HOST\codesense-bridge.exe")) { & "$env:CODESENSE_ACTIVITY_HOST\codesense-bridge.exe" hook notify }; exit 0"#,
                Some("powershell"),
                Some("continue"),
            ),
            (
                Verb::SecretGuard,
                HookTarget::Windows,
                r#"if ($env:CODESENSE_ACTIVITY_HOST -and (Test-Path -LiteralPath "$env:CODESENSE_ACTIVITY_HOST\codesense-bridge.exe")) { & "$env:CODESENSE_ACTIVITY_HOST\codesense-bridge.exe" hook secret-guard }; exit 0"#,
                Some("powershell"),
                Some("continue"),
            ),
        ];
        for (verb, target, written, shell, on_failure) in rows {
            let hook = command(verb, target);
            assert_eq!(hook.command, written, "{verb:?} {target:?}");
            assert_eq!(hook.shell, shell, "{verb:?} {target:?}");
            assert_eq!(hook.on_failure, on_failure, "{verb:?} {target:?}");
        }
    }

    #[test]
    fn markers_carry_the_subcommand() {
        let rows = [
            (
                Verb::Notify,
                HookTarget::Posix,
                r#"codesense-bridge" hook notify"#,
            ),
            (
                Verb::SecretGuard,
                HookTarget::Posix,
                r#"codesense-bridge" hook secret-guard"#,
            ),
            (
                Verb::Notify,
                HookTarget::Windows,
                r#"codesense-bridge.exe" hook notify"#,
            ),
            (
                Verb::SecretGuard,
                HookTarget::Windows,
                r#"codesense-bridge.exe" hook secret-guard"#,
            ),
        ];
        for (verb, target, marker) in rows {
            let hook = command(verb, target);
            assert_eq!(hook.marker, marker, "{verb:?} {target:?}");
            assert!(hook.command.contains(&hook.marker), "{verb:?} {target:?}");
        }
    }

    /// A status entry never passes for the guard, or the guard for a status entry, on either
    /// target.
    #[test]
    fn no_verbs_command_holds_another_verbs_marker() {
        for target in HookTarget::ALL {
            for other_target in HookTarget::ALL {
                for verb in Verb::ALL {
                    for other in Verb::ALL.into_iter().filter(|other| *other != verb) {
                        let hook = command(verb, target);
                        let marker = command(other, other_target).marker;
                        assert!(
                            !hook.command.contains(&marker),
                            "{verb:?} on {target:?} holds {other:?}'s marker on {other_target:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_entry_names_shell_and_on_failure_only_where_the_target_needs_them() {
        let posix = command(Verb::Notify, HookTarget::Posix);
        assert_eq!(
            posix.entry(),
            serde_json::json!({"type": "command", "command": posix.command, "timeout": 5})
        );
        let windows = command(Verb::SecretGuard, HookTarget::Windows);
        assert_eq!(
            windows.entry(),
            serde_json::json!({
                "type": "command",
                "command": windows.command,
                "timeout": 5,
                "shell": "powershell",
                "onFailure": "continue",
            })
        );
    }

    #[test]
    fn the_target_follows_the_os_name() {
        assert_eq!(HookTarget::for_os("windows"), HookTarget::Windows);
        assert_eq!(HookTarget::for_os("macos"), HookTarget::Posix);
        assert_eq!(HookTarget::for_os("linux"), HookTarget::Posix);
    }

    #[test]
    fn only_a_whole_legacy_command_is_legacy() {
        for (verb, legacy) in LEGACY_COMMANDS {
            assert_eq!(legacy_verb(legacy), Some(*verb));
            assert_eq!(legacy_verb(&format!("{legacy}; echo mine")), None);
            assert_eq!(legacy_verb(&format!(" {legacy}")), None);
        }
        assert_eq!(legacy_verb(".claude/hooks/codesense-notify.sh"), None);
        for target in HookTarget::ALL {
            for verb in Verb::ALL {
                assert_eq!(legacy_verb(&command(verb, target).command), None);
            }
        }
    }
}
