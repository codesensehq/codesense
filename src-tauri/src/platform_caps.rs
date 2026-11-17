// SPDX-License-Identifier: MIT
//! Which optional features exist on this OS and architecture.
//!
//! One static table holds a row per capability. `caps()` resolves it once for the running
//! platform; every consumer (the startup log line, the attribution installer, the
//! `get_platform_caps` command) reads only that resolved list.

use serde::Serialize;
use std::sync::OnceLock;

/// Whether a capability exists on one OS.
#[derive(Clone, Copy)]
enum Support {
    On,
    Off,
    /// On only for the listed architectures (`std::env::consts::ARCH` values).
    OnFor(&'static [&'static str]),
}

struct Row {
    key: &'static str,
    macos: Support,
    linux: Support,
    /// Why the capability is off; shown wherever it is reported unavailable.
    reason: &'static str,
}

const TABLE: &[Row] = &[
    Row {
        key: "git-ai",
        macos: Support::OnFor(&["aarch64"]),
        linux: Support::Off,
        reason: "the bundled git-ai binary is only shipped for macOS on Apple silicon",
    },
    Row {
        key: "starship",
        macos: Support::On,
        linux: Support::Off,
        reason: "the starship prompt binary is not bundled on this OS yet",
    },
];

/// One resolved capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Cap {
    pub key: &'static str,
    pub on: bool,
    pub reason: Option<&'static str>,
}

fn resolve(table: &[Row], os: &str, arch: &str) -> Vec<Cap> {
    table
        .iter()
        .map(|row| {
            let support = match os {
                "macos" => row.macos,
                "linux" => row.linux,
                _ => Support::Off,
            };
            let on = match support {
                Support::On => true,
                Support::Off => false,
                Support::OnFor(archs) => archs.contains(&arch),
            };
            Cap {
                key: row.key,
                on,
                reason: (!on).then_some(row.reason),
            }
        })
        .collect()
}

/// The capabilities of the running platform, resolved once.
pub fn caps() -> &'static [Cap] {
    static CAPS: OnceLock<Vec<Cap>> = OnceLock::new();
    CAPS.get_or_init(|| resolve(TABLE, std::env::consts::OS, std::env::consts::ARCH))
}

/// Whether the named capability is on; an unknown key is off.
pub fn enabled(key: &str) -> bool {
    caps().iter().any(|cap| cap.key == key && cap.on)
}

fn log_line(caps: &[Cap]) -> String {
    let mut line = String::from("caps:");
    for cap in caps {
        line.push_str(&format!(
            " {}={}",
            cap.key,
            if cap.on { "on" } else { "off" }
        ));
    }
    line
}

/// Logs the one startup line, `caps: <key>=<on|off> …`.
pub fn log_startup() {
    log::info!(target: "system", "{}", log_line(caps()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(os: &str, arch: &str) -> String {
        log_line(&resolve(TABLE, os, arch))
    }

    #[test]
    fn macos_apple_silicon_has_everything_on() {
        assert_eq!(line("macos", "aarch64"), "caps: git-ai=on starship=on");
    }

    #[test]
    fn macos_intel_has_no_git_ai() {
        assert_eq!(line("macos", "x86_64"), "caps: git-ai=off starship=on");
    }

    #[test]
    fn linux_has_no_git_ai_or_starship() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(line("linux", arch), "caps: git-ai=off starship=off");
        }
    }

    #[test]
    fn an_off_row_carries_its_reason_and_an_on_row_does_not() {
        let caps = resolve(TABLE, "macos", "x86_64");
        assert!(caps[0].reason.is_some_and(|r| !r.is_empty()));
        assert_eq!(caps[1].reason, None);
    }

    #[test]
    fn an_unlisted_os_is_off() {
        assert_eq!(line("windows", "x86_64"), "caps: git-ai=off starship=off");
    }

    #[test]
    fn the_table_keys_are_unique() {
        let mut keys: Vec<_> = TABLE.iter().map(|row| row.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), TABLE.len());
    }

    #[test]
    fn serializes_as_key_on_reason() {
        let json = serde_json::to_value(resolve(TABLE, "linux", "x86_64")).unwrap();
        assert_eq!(json[0]["key"], "git-ai");
        assert_eq!(json[0]["on"], false);
        assert!(json[0]["reason"].is_string());
    }

    #[test]
    fn enabled_reads_the_resolved_list() {
        assert!(!enabled("no-such-capability"));
        assert_eq!(
            enabled("starship"),
            caps().iter().any(|c| c.key == "starship" && c.on)
        );
    }
}
