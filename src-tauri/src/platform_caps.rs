// SPDX-License-Identifier: MIT
//! Which optional features exist on this OS and architecture.
//!
//! One static table holds a row per capability. `caps()` resolves it once for the running
//! platform; every consumer (the startup log line, the attribution installer, the
//! `get_platform_caps` command) reads only that resolved list.

use serde::Serialize;
use std::fmt::Write;
use std::sync::OnceLock;

pub const GIT_AI: &str = "git-ai";
pub const STARSHIP: &str = "starship";

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
    /// Why the capability is off on a platform that lacks it.
    reason: &'static str,
}

const TABLE: &[Row] = &[
    Row {
        key: GIT_AI,
        macos: Support::OnFor(&["aarch64"]),
        linux: Support::Off,
        reason: "the bundled git-ai binary is only shipped for macOS on Apple silicon",
    },
    Row {
        key: STARSHIP,
        macos: Support::OnFor(&["aarch64"]),
        linux: Support::Off,
        reason: "the bundled starship binary is only shipped for macOS on Apple silicon",
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
        let state = if cap.on { "on" } else { "off" };
        // Writing to a `String` cannot fail.
        let _ = write!(line, " {}={state}", cap.key);
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
    fn macos_intel_has_no_bundled_binaries() {
        assert_eq!(line("macos", "x86_64"), "caps: git-ai=off starship=off");
    }

    #[test]
    fn linux_has_no_git_ai_or_starship() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(line("linux", arch), "caps: git-ai=off starship=off");
        }
    }

    #[test]
    fn a_reason_is_present_exactly_when_a_row_is_off() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
        ] {
            for cap in resolve(TABLE, os, arch) {
                assert_eq!(cap.reason.is_none(), cap.on, "{os} {arch} {}", cap.key);
                assert!(cap.reason.map_or(true, |r| !r.is_empty()));
            }
        }
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
    fn a_capability_resolves_on_only_where_its_row_says() {
        let on = |os, arch, key| {
            resolve(TABLE, os, arch)
                .iter()
                .any(|cap| cap.key == key && cap.on)
        };
        assert!(on("macos", "aarch64", GIT_AI));
        assert!(!on("macos", "x86_64", GIT_AI));
        assert!(!on("linux", "x86_64", GIT_AI));
        assert!(on("macos", "aarch64", STARSHIP));
        assert!(!on("macos", "x86_64", STARSHIP));
        assert!(!on("linux", "x86_64", STARSHIP));
    }

    #[test]
    fn enabled_matches_the_live_host() {
        let apple_silicon = cfg!(all(target_os = "macos", target_arch = "aarch64"));
        assert_eq!(enabled(GIT_AI), apple_silicon);
        assert_eq!(enabled(STARSHIP), apple_silicon);
        assert!(!enabled("no-such-capability"));
    }
}
