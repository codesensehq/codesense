// SPDX-License-Identifier: MIT
//! Which optional features exist on this OS and architecture.
//!
//! `platform-caps.json` holds a row per capability. The build scripts read the same file for the
//! `cfg(cap_…)` gates (`build_caps.rs`), so a gate and its runtime answer cannot drift. `caps()`
//! resolves it once for the running platform; every consumer (the startup log line, the
//! attribution installer, the `get_platform_caps` command) reads only that resolved list, and
//! `enabled_for` answers for any other platform from the same table.

use serde::Serialize;
use serde_json::Value;
use std::fmt::Write;
use std::sync::OnceLock;

pub const GIT_AI: &str = "git-ai";
pub const STARSHIP: &str = "starship";
pub const SECRET_STORE: &str = "secret-store";

/// The table: a JSON array of rows, in the order of the `caps:` line.
const TABLE_JSON: &str = include_str!("../platform-caps.json");

/// Whether a capability exists on one OS.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Support {
    On,
    Off,
    /// On only for the listed architectures (`std::env::consts::ARCH` values).
    OnFor(Vec<String>),
    /// On when the key's probe (`probe_for`) says so. The probe is run by whoever resolves the
    /// table, so tests stub it and never touch the host.
    Probe,
}

struct Row {
    key: String,
    macos: Support,
    linux: Support,
    windows: Support,
    /// Why the capability is off on a platform that lacks it.
    reason: String,
}

impl Row {
    /// The row's value for one OS; an OS with no column has none.
    fn support(&self, os: &str) -> Option<&Support> {
        match os {
            "macos" => Some(&self.macos),
            "linux" => Some(&self.linux),
            "windows" => Some(&self.windows),
            _ => None,
        }
    }
}

/// One value: `"on"`, `"off"`, `"probe"` or `{"on": [<arch>…]}`.
fn support(value: &Value) -> Result<Support, String> {
    let archs = |archs: &Vec<Value>| -> Option<Vec<String>> {
        archs
            .iter()
            .map(|arch| arch.as_str().map(str::to_string))
            .collect()
    };
    let parsed = match value {
        Value::String(word) => match word.as_str() {
            "on" => Some(Support::On),
            "off" => Some(Support::Off),
            "probe" => Some(Support::Probe),
            _ => None,
        },
        Value::Object(map) if map.len() == 1 => map
            .get("on")
            .and_then(Value::as_array)
            .and_then(archs)
            .map(Support::OnFor),
        _ => None,
    };
    parsed.ok_or_else(|| {
        format!("{value} is not \"on\", \"off\", \"probe\" or {{\"on\": [<arch>…]}}")
    })
}

/// The rows of a table, in file order.
fn parse_table(json: &str) -> Result<Vec<Row>, String> {
    let rows: Vec<Value> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    rows.iter()
        .map(|row| {
            let text = |field: &str| {
                row.get(field)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| format!("{row} has no string `{field}`"))
            };
            let column = |os: &str| {
                row.get(os)
                    .ok_or_else(|| format!("{row} has no `{os}`"))
                    .and_then(support)
            };
            Ok(Row {
                key: text("key")?,
                macos: column("macos")?,
                linux: column("linux")?,
                windows: column("windows")?,
                reason: text("reason")?,
            })
        })
        .collect()
}

/// The table, parsed once. The build scripts read the same bytes and fail the build on a bad
/// table, and the tests parse it here, so a built app never panics on it.
fn table() -> &'static [Row] {
    static TABLE: OnceLock<Vec<Row>> = OnceLock::new();
    TABLE.get_or_init(|| {
        parse_table(TABLE_JSON).unwrap_or_else(|error| panic!("platform-caps.json: {error}"))
    })
}

/// The probe a `"probe"` value runs, by key. A probe value whose key has no arm here is off.
fn probe_for(key: &str) -> Option<fn() -> bool> {
    match key {
        SECRET_STORE => Some(crate::commands::credential_store::secret_store_available),
        _ => None,
    }
}

/// One resolved capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Cap {
    pub key: &'static str,
    pub on: bool,
    pub reason: Option<&'static str>,
}

/// Resolves `table` for one platform. `run` evaluates a probe value's probe.
fn resolve(
    table: &'static [Row],
    os: &str,
    arch: &str,
    run: &dyn Fn(fn() -> bool) -> bool,
) -> Vec<Cap> {
    table
        .iter()
        .map(|row| {
            let on = row.support(os).is_some_and(|support| match support {
                Support::On => true,
                Support::Off => false,
                Support::OnFor(archs) => archs.iter().any(|on_for| on_for == arch),
                Support::Probe => probe_for(&row.key).is_some_and(run),
            });
            Cap {
                key: &row.key,
                on,
                reason: (!on).then_some(row.reason.as_str()),
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
            table(),
            std::env::consts::OS,
            std::env::consts::ARCH,
            &|probe| probe(),
        )
    })
}

/// Whether the named capability is on for one platform; an unknown key is off. The running
/// platform reads `caps()`, so its probes run once; any other resolves only the key's row. A
/// probe row is off there: a probe can only answer for the host it runs on.
pub fn enabled_for(key: &str, os: &str, arch: &str) -> bool {
    if (os, arch) == (std::env::consts::OS, std::env::consts::ARCH) {
        return caps().iter().any(|cap| cap.key == key && cap.on);
    }
    table()
        .iter()
        .find(|row| row.key == key)
        .is_some_and(|row| resolve(std::slice::from_ref(row), os, arch, &|_| false)[0].on)
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
        resolve(table(), os, arch, &|_| probe)
    }

    fn line(os: &str, arch: &str, probe: bool) -> String {
        log_line(&resolved(os, arch, probe))
    }

    #[test]
    fn macos_apple_silicon_has_everything_on() {
        assert_eq!(
            line("macos", "aarch64", true),
            "caps: git-ai=on starship=on secret-store=on mcp-bridge=on terminal-server-sidecar=on \
             remote-machines=on agent-cli-sockets=on shell-integration=on pdf-export=on"
        );
    }

    #[test]
    fn macos_intel_has_no_bundled_binaries() {
        assert_eq!(
            line("macos", "x86_64", true),
            "caps: git-ai=off starship=off secret-store=on mcp-bridge=on terminal-server-sidecar=on \
             remote-machines=on agent-cli-sockets=on shell-integration=on pdf-export=on"
        );
    }

    #[test]
    fn linux_has_git_ai_and_starship() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(
                line("linux", arch, true),
                "caps: git-ai=on starship=on secret-store=on mcp-bridge=on \
                 terminal-server-sidecar=on remote-machines=on agent-cli-sockets=on \
                 shell-integration=on pdf-export=off"
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
        let table: &'static [Row] = Vec::leak(vec![Row {
            key: SECRET_STORE.into(),
            macos: Support::Off,
            linux: Support::Probe,
            windows: Support::Off,
            reason: "r".into(),
        }]);
        for os in ["windows", "freebsd"] {
            let caps = resolve(table, os, "x86_64", &|_| panic!("never run"));
            assert!(!caps[0].on);
        }
    }

    /// Every `"probe"` value names a key `probe_for` binds; one without an arm would be off for
    /// good.
    #[test]
    fn every_probe_row_has_a_probe() {
        for row in table() {
            for os in ["macos", "linux", "windows"] {
                if row.support(os) == Some(&Support::Probe) {
                    assert!(probe_for(&row.key).is_some(), "{} {os}", row.key);
                }
            }
        }
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
        let all_off = "caps: git-ai=off starship=off secret-store=off mcp-bridge=off \
                       terminal-server-sidecar=off remote-machines=off agent-cli-sockets=off \
                       shell-integration=off pdf-export=off";
        assert_eq!(line("windows", "x86_64", true), all_off);
        assert_eq!(line("freebsd", "x86_64", true), all_off);
    }

    #[test]
    fn the_table_keys_are_unique() {
        let mut keys: Vec<_> = table().iter().map(|row| row.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), table().len());
    }

    /// The `caps:` line and `get_platform_caps` keep the file's order.
    #[test]
    fn the_table_keeps_its_file_order() {
        let keys: Vec<_> = table().iter().map(|row| row.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                GIT_AI,
                STARSHIP,
                SECRET_STORE,
                "mcp-bridge",
                "terminal-server-sidecar",
                "remote-machines",
                "agent-cli-sockets",
                "shell-integration",
                "pdf-export",
            ]
        );
    }

    #[test]
    fn each_value_form_parses() {
        let value = |json: &str| support(&serde_json::from_str(json).unwrap());
        assert_eq!(value(r#""on""#), Ok(Support::On));
        assert_eq!(value(r#""off""#), Ok(Support::Off));
        assert_eq!(value(r#""probe""#), Ok(Support::Probe));
        assert_eq!(
            value(r#"{"on": ["x86_64", "aarch64"]}"#),
            Ok(Support::OnFor(vec!["x86_64".into(), "aarch64".into()]))
        );
        for bad in [
            r#""yes""#,
            "true",
            r#"["aarch64"]"#,
            r#"{"on": "aarch64"}"#,
            r#"{"on": [1]}"#,
            r#"{"off": ["aarch64"]}"#,
            r#"{"on": [], "off": []}"#,
        ] {
            assert!(value(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_malformed_table_is_refused() {
        for bad in [
            r#"{"key": "x"}"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "windows": "maybe", "reason": "r"}]"#,
            r#"[{"macos": "on", "linux": "on", "windows": "off", "reason": "r"}]"#,
        ] {
            assert!(parse_table(bad).is_err(), "{bad}");
        }
        assert_eq!(parse_table(TABLE_JSON).map(|rows| rows.len()), Ok(9));
    }

    /// The build scripts' gates. A build script's own tests never run, so they are tested here.
    #[allow(dead_code)]
    mod build {
        include!("../build_caps.rs");
    }

    /// The keys `table` compiles in for one target, in file order.
    fn compiled(table: &str, os: &str, arch: &str) -> Vec<String> {
        build::compiled_caps(table, os, arch)
            .unwrap()
            .into_iter()
            .filter_map(|(key, on)| on.then_some(key))
            .collect()
    }

    #[test]
    fn the_build_compiles_in_each_value_form() {
        let table = r#"[
            {"key": "always", "macos": "on", "linux": "on", "windows": "on", "reason": "r"},
            {"key": "never", "macos": "off", "linux": "off", "windows": "off", "reason": "r"},
            {"key": "probed", "macos": "probe", "linux": "off", "windows": "off", "reason": "r"},
            {"key": "some-arch", "macos": {"on": ["aarch64"]},
             "linux": {"on": ["x86_64", "aarch64"]}, "windows": "off", "reason": "r"}
        ]"#;
        assert_eq!(
            compiled(table, "macos", "aarch64"),
            ["always", "probed", "some-arch"]
        );
        assert_eq!(compiled(table, "macos", "x86_64"), ["always", "probed"]);
        assert_eq!(compiled(table, "linux", "aarch64"), ["always", "some-arch"]);
        assert_eq!(compiled(table, "linux", "riscv64"), ["always"]);
        assert_eq!(compiled(table, "windows", "x86_64"), ["always"]);
        assert!(compiled(table, "freebsd", "x86_64").is_empty());
        let declared: Vec<_> = build::compiled_caps(table, "windows", "x86_64")
            .unwrap()
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        assert_eq!(
            declared,
            ["always", "never", "probed", "some-arch"],
            "every key is declared, in file order"
        );
    }

    /// A bad value fails the build for every target, not only the one it names.
    #[test]
    fn the_build_refuses_a_malformed_table() {
        for bad in [
            r#"{"key": "x"}"#,
            r#"[{"macos": "on", "linux": "on", "windows": "off", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "windows": "maybe", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": {"on": "x86_64"}, "windows": "off", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": {"on": [1]}, "windows": "off", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": {"off": []}, "windows": "off", "reason": "r"}]"#,
        ] {
            assert!(
                build::compiled_caps(bad, "macos", "aarch64").is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_cap_cfg_is_its_key_with_underscores() {
        assert_eq!(
            build::cap_cfg("terminal-server-sidecar"),
            "cap_terminal_server_sidecar"
        );
        assert_eq!(build::cap_cfg(GIT_AI), "cap_git_ai");
        assert_eq!(build::cap_cfg("pdf-export"), "cap_pdf_export");
    }

    /// The build and the runtime read the same bytes: a target compiles in exactly what resolves
    /// on there when every probe answers yes.
    #[test]
    fn the_build_gates_match_the_runtime_table() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("windows", "x86_64"),
        ] {
            let runtime: Vec<_> = resolved(os, arch, true)
                .into_iter()
                .filter_map(|cap| cap.on.then_some(cap.key))
                .collect();
            assert_eq!(compiled(TABLE_JSON, os, arch), runtime, "{os} {arch}");
        }
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

    /// Off the running platform a probe row is off, so this host's probe never answers for
    /// another platform.
    #[test]
    fn enabled_for_another_platform_never_runs_a_probe() {
        let host = (std::env::consts::OS, std::env::consts::ARCH);
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("windows", "x86_64"),
        ] {
            if (os, arch) != host {
                assert!(!enabled_for(SECRET_STORE, os, arch), "{os} {arch}");
            }
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
