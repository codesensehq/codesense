// SPDX-License-Identifier: MIT
//! Which optional features exist on this OS and architecture.
//!
//! One static table holds a row per capability. `caps()` resolves it once for the running
//! platform; every consumer (the startup log line, the attribution installer, the
//! `get_platform_caps` command) reads only that resolved list, and `enabled_for` answers for
//! any other platform from the same table.

use serde::Serialize;
use std::fmt::Write;
use std::sync::OnceLock;

pub const GIT_AI: &str = "git-ai";
pub const STARSHIP: &str = "starship";
pub const SECRET_STORE: &str = "secret-store";

/// Whether a capability exists on one OS.
#[derive(Clone, Copy)]
enum Support {
    On,
    Off,
    /// On only for the listed architectures (`std::env::consts::ARCH` values).
    OnFor(&'static [&'static str]),
    /// On when the probe says so. The probe is run by whoever resolves the table, so tests
    /// stub it and never touch the host.
    Probe(fn() -> bool),
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
        linux: Support::OnFor(&["x86_64", "aarch64"]),
        reason: "the bundled git-ai binary is shipped for macOS on Apple silicon and Linux on x86_64 and aarch64",
    },
    Row {
        key: STARSHIP,
        macos: Support::OnFor(&["aarch64"]),
        linux: Support::OnFor(&["x86_64", "aarch64"]),
        reason: "the bundled starship binary is shipped for macOS on Apple silicon and Linux on x86_64 and aarch64",
    },
    Row {
        key: SECRET_STORE,
        macos: Support::Probe(crate::commands::credential_store::secret_store_available),
        linux: Support::Probe(crate::commands::credential_store::secret_store_available),
        reason: "needs a system secret store that can be reached; values injected through the process environment are never saved",
    },
];

/// One resolved capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Cap {
    pub key: &'static str,
    pub on: bool,
    pub reason: Option<&'static str>,
}

/// Resolves `table` for one platform. `run` evaluates a probe row's probe.
fn resolve(table: &[Row], os: &str, arch: &str, run: &dyn Fn(fn() -> bool) -> bool) -> Vec<Cap> {
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
                Support::Probe(probe) => run(probe),
            };
            Cap {
                key: row.key,
                on,
                reason: (!on).then_some(row.reason),
            }
        })
        .collect()
}

/// The capabilities of the running platform, resolved once, with the real probes. The first call
/// runs them, so `log_startup` makes it in setup, before anything else asks.
pub fn caps() -> &'static [Cap] {
    static CAPS: OnceLock<Vec<Cap>> = OnceLock::new();
    CAPS.get_or_init(|| {
        resolve(
            TABLE,
            std::env::consts::OS,
            std::env::consts::ARCH,
            &|probe| probe(),
        )
    })
}

/// Whether the named capability is on for one platform; an unknown key is off. The running
/// platform reads `caps()`, so its probes run once; any other resolves only the key's row, and a
/// probe row there runs this host's probe.
pub fn enabled_for(key: &str, os: &str, arch: &str) -> bool {
    if (os, arch) == (std::env::consts::OS, std::env::consts::ARCH) {
        return caps().iter().any(|cap| cap.key == key && cap.on);
    }
    TABLE
        .iter()
        .position(|row| row.key == key)
        .is_some_and(|i| resolve(&TABLE[i..=i], os, arch, &|probe| probe())[0].on)
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

    /// The table resolved with every probe answering `probe`, never the host's own.
    fn resolved(os: &str, arch: &str, probe: bool) -> Vec<Cap> {
        resolve(TABLE, os, arch, &|_| probe)
    }

    fn line(os: &str, arch: &str, probe: bool) -> String {
        log_line(&resolved(os, arch, probe))
    }

    #[test]
    fn macos_apple_silicon_has_everything_on() {
        assert_eq!(
            line("macos", "aarch64", true),
            "caps: git-ai=on starship=on secret-store=on"
        );
    }

    #[test]
    fn macos_intel_has_no_bundled_binaries() {
        assert_eq!(
            line("macos", "x86_64", true),
            "caps: git-ai=off starship=off secret-store=on"
        );
    }

    #[test]
    fn linux_has_git_ai_and_starship() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(
                line("linux", arch, true),
                "caps: git-ai=on starship=on secret-store=on"
            );
        }
    }

    /// The secret store follows its probe on macOS and Linux: an unreachable store, an unknown
    /// one and the environment source (all of which the probe reports as false) turn it off.
    #[test]
    fn the_secret_store_follows_its_probe_on_macos_and_linux() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
        ] {
            for probe in [true, false] {
                let caps = resolved(os, arch, probe);
                let cap = caps.iter().find(|cap| cap.key == SECRET_STORE).unwrap();
                assert_eq!(cap.on, probe, "{os} {arch}");
            }
        }
    }

    /// Windows has no support for it, whatever a probe would say.
    #[test]
    fn the_secret_store_is_off_on_windows() {
        for probe in [true, false] {
            let caps = resolved("windows", "x86_64", probe);
            let cap = caps.iter().find(|cap| cap.key == SECRET_STORE).unwrap();
            assert!(!cap.on);
            assert!(cap.reason.is_some());
        }
    }

    /// A probe row asks its probe only on the platforms that name it.
    #[test]
    fn a_probe_is_not_run_for_an_unlisted_os() {
        let table = [Row {
            key: "probed",
            macos: Support::Off,
            linux: Support::Probe(|| panic!("never run")),
            reason: "r",
        }];
        let caps = resolve(&table, "windows", "x86_64", &|probe| probe());
        assert!(!caps[0].on);
    }

    #[test]
    fn a_reason_is_present_exactly_when_a_row_is_off() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("windows", "x86_64"),
        ] {
            for probe in [true, false] {
                for cap in resolved(os, arch, probe) {
                    assert_eq!(cap.reason.is_none(), cap.on, "{os} {arch} {}", cap.key);
                    assert!(cap.reason.map_or(true, |r| !r.is_empty()));
                }
            }
        }
    }

    #[test]
    fn an_unlisted_os_is_off() {
        assert_eq!(
            line("windows", "x86_64", true),
            "caps: git-ai=off starship=off secret-store=off"
        );
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
        let json = serde_json::to_value(resolved("linux", "x86_64", false)).unwrap();
        assert_eq!(json[0]["key"], "git-ai");
        assert_eq!(json[0]["on"], true);
        assert!(json[0]["reason"].is_null());
        assert_eq!(json[2]["key"], "secret-store");
        assert_eq!(json[2]["on"], false);
        assert!(json[2]["reason"].is_string());
    }

    #[test]
    fn a_capability_resolves_on_only_where_its_row_says() {
        let on = |os, arch, key| {
            resolved(os, arch, true)
                .iter()
                .any(|cap| cap.key == key && cap.on)
        };
        assert!(on("macos", "aarch64", GIT_AI));
        assert!(!on("macos", "x86_64", GIT_AI));
        assert!(on("linux", "x86_64", GIT_AI));
        assert!(on("linux", "aarch64", GIT_AI));
        assert!(!on("linux", "riscv64", GIT_AI));
        assert!(on("macos", "aarch64", STARSHIP));
        assert!(!on("macos", "x86_64", STARSHIP));
        assert!(on("linux", "x86_64", STARSHIP));
        assert!(on("linux", "aarch64", STARSHIP));
        assert!(!on("linux", "riscv64", STARSHIP));
    }

    /// Whether `key` is on for the running platform.
    fn enabled(key: &str) -> bool {
        enabled_for(key, std::env::consts::OS, std::env::consts::ARCH)
    }

    /// Another platform answers from the same table as the running one, from any host.
    #[test]
    fn enabled_for_answers_for_any_platform() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("linux", "riscv64"),
            ("windows", "x86_64"),
        ] {
            for key in [GIT_AI, STARSHIP] {
                let row = resolved(os, arch, false)
                    .into_iter()
                    .find(|cap| cap.key == key)
                    .unwrap();
                assert_eq!(enabled_for(key, os, arch), row.on, "{os} {arch} {key}");
            }
            assert!(!enabled_for("no-such-capability", os, arch));
        }
    }

    #[test]
    fn enabled_matches_the_live_host() {
        let host = (std::env::consts::OS, std::env::consts::ARCH);
        assert_eq!(
            enabled(GIT_AI),
            matches!(
                host,
                ("macos", "aarch64") | ("linux", "x86_64") | ("linux", "aarch64")
            )
        );
        assert_eq!(
            enabled(STARSHIP),
            matches!(
                host,
                ("macos", "aarch64") | ("linux", "x86_64") | ("linux", "aarch64")
            )
        );
        // The macOS Keychain is always there (unless the environment source is selected).
        if cfg!(target_os = "macos") && std::env::var("CODESENSE_CRED_SOURCE").is_err() {
            assert!(enabled(SECRET_STORE));
        }
        assert!(!enabled("no-such-capability"));
    }
}
