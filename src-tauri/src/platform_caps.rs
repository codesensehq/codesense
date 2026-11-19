// SPDX-License-Identifier: MIT
//! Which optional features exist on this OS and architecture.
//!
//! `platform-caps.json` holds a row per capability. The build scripts read the same file for the
//! `cfg(cap_…)` gates (`build_caps.rs`), so a gate and its runtime answer cannot drift. `caps()`
//! resolves it once for the running platform; every consumer (the startup log line, the
//! attribution installer, the `get_platform_caps` command) reads only that resolved list, and
//! `enabled_for` answers for any other platform from the same table.

use serde::Serialize;
use std::fmt::Write;
use std::sync::OnceLock;

pub const GIT_AI: &str = "git-ai";
pub const STARSHIP: &str = "starship";
pub const SECRET_STORE: &str = "secret-store";
pub const TERMINAL_SERVER_SIDECAR: &str = "terminal-server-sidecar";

/// The table: a JSON array of rows, in the order of the `caps:` line.
const TABLE_JSON: &str = include_str!("../platform-caps.json");

/// The table's one parser, the build scripts' too, so the gates and the runtime answers read the
/// table alike.
// The build scripts use `configure_caps` (and through it `compiled_rows`); `compiled_caps` is
// for the tests below.
#[allow(dead_code)]
mod caps_table {
    include!("../build_caps.rs");
}
use caps_table::{Row, Scope, Support};

/// The runtime table: the product rows, parsed once. Test-scope rows are gates for test and
/// diagnostic code only, so `caps()`, the `caps:` line and `enabled_for` never name them. The
/// build scripts parse the same bytes with the same parser and fail the build on a bad table, so
/// a built app never panics on it.
fn table() -> &'static [Row] {
    static TABLE: OnceLock<Vec<Row>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let rows = caps_table::parse_caps(TABLE_JSON)
            .unwrap_or_else(|error| panic!("platform-caps.json: {error}"));
        rows.into_iter()
            .filter(|row| row.scope == Scope::Product)
            .collect()
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
                reason: (!on).then_some(&*row.reason),
            }
        })
        .collect()
}

/// The capabilities this build turned off (`CODESENSE_CAPS_OFF`, a comma-separated key list,
/// usually empty): a check build that compiles the code a platform without them builds.
const BUILT_OFF: &str = env!("CODESENSE_CAPS_OFF");

/// Why a capability the build turned off is off.
const BUILT_OFF_REASON: &str = "turned off for this build";

/// `caps` with each key in `off` (a `CODESENSE_CAPS_OFF` list) off, as the build compiled it, so
/// the runtime never reports on what the build left out.
fn turned_off(mut caps: Vec<Cap>, off: &str) -> Vec<Cap> {
    for cap in &mut caps {
        if cap.on && off.split(',').any(|key| key == cap.key) {
            cap.on = false;
            cap.reason = Some(BUILT_OFF_REASON);
        }
    }
    caps
}

/// The capabilities of the running platform, resolved once, with the real probes. The first call
/// runs them, so `log_startup` makes it in setup, before anything else asks.
pub fn caps() -> &'static [Cap] {
    static CAPS: OnceLock<Vec<Cap>> = OnceLock::new();
    CAPS.get_or_init(|| {
        let resolved = resolve(
            table(),
            std::env::consts::OS,
            std::env::consts::ARCH,
            &|probe| probe(),
        );
        turned_off(resolved, BUILT_OFF)
    })
}

/// A resolved answer, handed to code that branches on a capability so that code stays pure:
/// `Caps::live()` at the call site, an injected list in tests.
#[derive(Clone, Copy, Debug)]
pub struct Caps<'a>(pub &'a [Cap]);

impl Caps<'static> {
    /// The running platform's capabilities, `caps()`.
    pub fn live() -> Self {
        Caps(caps())
    }
}

impl Caps<'_> {
    /// Whether `key` is on; an unknown key is off.
    pub fn enabled(&self, key: &str) -> bool {
        self.0.iter().any(|cap| cap.key == key && cap.on)
    }
}

/// Every capability in the table on except the `off` keys, which are off with their reasons:
/// the list a test hands to `Caps`.
#[cfg(test)]
pub(crate) fn caps_with_off(off: &[&str]) -> Vec<Cap> {
    table()
        .iter()
        .map(|row| {
            let on = !off.contains(&row.key.as_str());
            Cap {
                key: &row.key,
                on,
                reason: (!on).then_some(&*row.reason),
            }
        })
        .collect()
}

/// Whether the named capability is on for one platform; an unknown key is off. The running
/// platform reads `caps()`, so its probes run once; any other resolves only the key's row. A
/// probe row is off there: a probe can only answer for the host it runs on.
pub fn enabled_for(key: &str, os: &str, arch: &str) -> bool {
    if (os, arch) == (std::env::consts::OS, std::env::consts::ARCH) {
        return Caps::live().enabled(key);
    }
    table()
        .iter()
        .find_map(|row| (row.key == key).then_some(row))
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
             remote-machines=on agent-cli-sockets=on shell-integration=on pdf-export=on \
             background-on-close=on terminal-server-tray=on"
        );
    }

    #[test]
    fn macos_intel_has_no_bundled_binaries() {
        assert_eq!(
            line("macos", "x86_64", true),
            "caps: git-ai=off starship=off secret-store=on mcp-bridge=on terminal-server-sidecar=on \
             remote-machines=on agent-cli-sockets=on shell-integration=on pdf-export=on \
             background-on-close=on terminal-server-tray=on"
        );
    }

    #[test]
    fn linux_has_git_ai_and_starship() {
        for arch in ["x86_64", "aarch64"] {
            assert_eq!(
                line("linux", arch, true),
                "caps: git-ai=on starship=on secret-store=on mcp-bridge=on \
                 terminal-server-sidecar=on remote-machines=on agent-cli-sockets=on \
                 shell-integration=on pdf-export=off background-on-close=off \
                 terminal-server-tray=off"
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
            scope: Scope::Product,
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
                       shell-integration=off pdf-export=off background-on-close=off \
                       terminal-server-tray=off";
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
                "background-on-close",
                "terminal-server-tray",
            ]
        );
    }

    #[test]
    fn each_value_form_parses() {
        let value = |json: &str| caps_table::parse_support(&serde_json::from_str(json).unwrap());
        assert_eq!(value(r#""on""#), Some(Support::On));
        assert_eq!(value(r#""off""#), Some(Support::Off));
        assert_eq!(value(r#""probe""#), Some(Support::Probe));
        assert_eq!(
            value(r#"{"on": ["x86_64", "aarch64"]}"#),
            Some(Support::OnFor(vec!["x86_64".into(), "aarch64".into()]))
        );
        for bad in [
            r#""yes""#,
            "true",
            r#"["aarch64"]"#,
            r#"{"on": "aarch64"}"#,
            r#"{"on": [1]}"#,
            r#"{"off": ["aarch64"]}"#,
            r#"{"on": [], "off": []}"#,
            r#"{"on": []}"#,
            r#"{"on": [""]}"#,
            r#"{"on": ["X86_64"]}"#,
            r#"{"on": ["x86-64"]}"#,
        ] {
            assert!(value(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_malformed_table_is_refused() {
        for bad in [
            r#"{"key": "x"}"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "windows": "maybe", "reason": "r"}]"#,
            r#"[{"macos": "on", "linux": "on", "windows": "off", "reason": "r"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "windows": "off"}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "windows": "off", "reason": " "}]"#,
            r#"[{"key": "x", "macos": "on", "linux": "on", "windows": "off", "reason": 1}]"#,
        ] {
            assert!(caps_table::parse_caps(bad).is_err(), "{bad}");
        }
        assert_eq!(
            caps_table::parse_caps(TABLE_JSON).map(|rows| rows.len()),
            Ok(14)
        );
        assert_eq!(table().len(), 11, "the product rows");
    }

    /// The keys `table` compiles in for one target, in file order.
    fn compiled(table: &str, os: &str, arch: &str) -> Vec<String> {
        caps_table::compiled_caps(table, os, arch, "")
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
        let declared: Vec<_> = caps_table::compiled_caps(table, "windows", "x86_64", "")
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

    /// `CODESENSE_CAPS_OFF` turns product capabilities off for a build, whatever their value; it
    /// never turns one on, and empty or blank entries change nothing.
    #[test]
    fn the_build_override_only_turns_capabilities_off() {
        let table = r#"[
            {"key": "always", "macos": "on", "linux": "on", "windows": "on", "reason": "r"},
            {"key": "never", "macos": "off", "linux": "off", "windows": "off", "reason": "r"},
            {"key": "probed", "macos": "probe", "linux": "off", "windows": "off", "reason": "r"},
            {"key": "some-arch", "macos": {"on": ["aarch64"]}, "linux": "off", "windows": "off",
             "reason": "r"},
            {"key": "fixture", "macos": "on", "linux": "on", "windows": "off", "reason": "r",
             "scope": "test"}
        ]"#;
        let with_off = |off: &str| -> Vec<String> {
            caps_table::compiled_caps(table, "macos", "aarch64", off)
                .unwrap()
                .into_iter()
                .filter_map(|(key, on)| on.then_some(key))
                .collect()
        };
        let all = ["always", "probed", "some-arch", "fixture"];
        for nothing in ["", " ", ",", " , "] {
            assert_eq!(with_off(nothing), all, "{nothing:?}");
        }
        assert_eq!(with_off("always"), ["probed", "some-arch", "fixture"]);
        assert_eq!(with_off("probed, some-arch"), ["always", "fixture"]);
        assert_eq!(with_off("never"), all, "off stays off; nothing turns on");
        for refused in ["missing", "always,missing", "fixture", "Always"] {
            let error = caps_table::compiled_caps(table, "macos", "aarch64", refused)
                .err()
                .unwrap_or_default();
            assert!(
                error.contains(caps_table::CAPS_OFF_ENV),
                "{refused}: {error}"
            );
        }
        let rows = caps_table::parse_caps(TABLE_JSON).unwrap();
        assert_eq!(
            caps_table::caps_off(" remote-machines ,git-ai,", &rows),
            Ok(vec!["remote-machines".to_string(), GIT_AI.to_string()])
        );
    }

    /// An unset override is an empty list; one that is not UTF-8 fails the build.
    #[test]
    fn the_build_override_is_read_as_utf8() {
        use std::env::VarError;
        assert_eq!(
            caps_table::caps_off_list(Err(VarError::NotPresent)),
            Ok(String::new())
        );
        assert_eq!(
            caps_table::caps_off_list(Ok("git-ai".into())),
            Ok("git-ai".to_string())
        );
        let error = caps_table::caps_off_list(Err(VarError::NotUnicode("\u{fffd}".into())))
            .err()
            .unwrap_or_default();
        assert!(error.contains(caps_table::CAPS_OFF_ENV), "{error}");
    }

    /// What the build turned off is off at runtime too, with a reason; the rest is untouched.
    #[test]
    fn the_runtime_agrees_with_the_build_override() {
        let all_on = resolved("macos", "aarch64", true);
        assert_eq!(turned_off(all_on.clone(), ""), all_on);
        let off = turned_off(all_on.clone(), "remote-machines,git-ai");
        for (before, after) in all_on.iter().zip(&off) {
            let turned = [GIT_AI, "remote-machines"].contains(&before.key);
            assert_eq!(after.on, before.on && !turned, "{}", before.key);
            assert_eq!(after.reason.is_some(), !after.on, "{}", before.key);
        }
        assert_eq!(
            off.iter()
                .find(|cap| cap.key == GIT_AI)
                .and_then(|cap| cap.reason),
            Some(BUILT_OFF_REASON)
        );
        let already_off = resolved("macos", "x86_64", true);
        assert_eq!(
            turned_off(already_off.clone(), GIT_AI),
            already_off,
            "an off capability keeps its own reason"
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
                caps_table::compiled_caps(bad, "macos", "aarch64", "").is_err(),
                "{bad}"
            );
        }
    }

    /// The table's test-scope rows: gates for test and diagnostic code.
    const TEST_SCOPE_KEYS: [&str; 3] = ["pty-test-fixtures", "pty-leak-gate", "tui-fixture"];

    #[test]
    fn a_row_scope_is_product_or_test() {
        let scoped = |scope: &str| {
            let table = format!(
                r#"[{{"key": "x", "macos": "on", "linux": "on", "windows": "off", "reason": "r"{scope}}}]"#
            );
            caps_table::parse_caps(&table).map(|rows| rows[0].scope)
        };
        assert_eq!(scoped(""), Ok(Scope::Product), "the default");
        assert_eq!(scoped(r#", "scope": "product""#), Ok(Scope::Product));
        assert_eq!(scoped(r#", "scope": "test""#), Ok(Scope::Test));
        for bad in [
            r#", "scope": "fixture""#,
            r#", "scope": "Test""#,
            r#", "scope": 1"#,
        ] {
            assert!(scoped(bad).is_err(), "{bad}");
        }
    }

    /// Test-scope rows compile their gates like any row but stay out of the runtime table.
    #[test]
    fn test_scope_rows_stay_out_of_the_runtime_table() {
        let rows = caps_table::parse_caps(TABLE_JSON).unwrap();
        let test_rows: Vec<_> = rows
            .iter()
            .filter(|row| row.scope == Scope::Test)
            .map(|row| row.key.as_str())
            .collect();
        assert_eq!(test_rows, TEST_SCOPE_KEYS);
        assert!(rows[rows.len() - 3..]
            .iter()
            .all(|row| row.scope == Scope::Test));
        for (os, arch) in [
            ("macos", "aarch64"),
            ("linux", "x86_64"),
            ("windows", "x86_64"),
        ] {
            let compiled = compiled(TABLE_JSON, os, arch);
            for key in TEST_SCOPE_KEYS {
                assert_eq!(
                    compiled.iter().any(|on| on == key),
                    os != "windows",
                    "{os} {key}"
                );
                assert!(!enabled_for(key, os, arch), "{os} {key}");
                assert!(resolved(os, arch, true).iter().all(|cap| cap.key != key));
            }
        }
        assert!(caps().iter().all(|cap| !TEST_SCOPE_KEYS.contains(&cap.key)));
    }

    /// A key is `[a-z0-9-]+` and appears once, so each one has its own `cfg`.
    #[test]
    fn a_key_is_lowercase_and_unique() {
        let row = |key: &str| {
            format!(
                r#"{{"key": "{key}", "macos": "on", "linux": "on", "windows": "off", "reason": "r"}}"#
            )
        };
        for key in ["", "Git-ai", "git_ai", "git ai", "git.ai", "gît"] {
            let table = format!("[{}]", row(key));
            assert!(caps_table::parse_caps(&table).is_err(), "{key:?}");
        }
        let twice = format!("[{}, {}]", row("git-ai"), row("git-ai"));
        let error = caps_table::parse_caps(&twice).err().unwrap_or_default();
        assert!(error.contains("second row"), "{error}");
        let fine = format!("[{}, {}]", row("git-ai"), row("pdf-export2"));
        assert_eq!(caps_table::parse_caps(&fine).map(|rows| rows.len()), Ok(2));
    }

    #[test]
    fn a_cap_cfg_is_its_key_with_underscores() {
        assert_eq!(
            caps_table::cap_cfg("terminal-server-sidecar"),
            "cap_terminal_server_sidecar"
        );
        assert_eq!(caps_table::cap_cfg(GIT_AI), "cap_git_ai");
        assert_eq!(caps_table::cap_cfg("pdf-export"), "cap_pdf_export");
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
            let product: Vec<_> = compiled(TABLE_JSON, os, arch)
                .into_iter()
                .filter(|key| !TEST_SCOPE_KEYS.contains(&key.as_str()))
                .collect();
            assert_eq!(product, runtime, "{os} {arch}");
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

    #[test]
    fn caps_answer_from_the_list_they_are_given() {
        let all_on = caps_with_off(&[]);
        assert_eq!(all_on.len(), table().len());
        assert!(all_on
            .iter()
            .all(|cap| Caps(&all_on).enabled(cap.key) && cap.reason.is_none()));
        let off = caps_with_off(&[TERMINAL_SERVER_SIDECAR]);
        let off_caps = Caps(&off);
        assert!(!off_caps.enabled(TERMINAL_SERVER_SIDECAR));
        assert!(off
            .iter()
            .find(|cap| cap.key == TERMINAL_SERVER_SIDECAR)
            .is_some_and(|cap| cap.reason.is_some()));
        assert!(off_caps.enabled(GIT_AI));
        assert!(!off_caps.enabled("no-such-capability"));
        assert_eq!(Caps::live().0, caps());
    }

    /// The app's terminal-server state follows the capability: a root (so a
    /// sidecar can be launched) only with it on. Here, so the Linux app job runs
    /// it too.
    #[test]
    fn the_local_session_state_follows_the_sidecar_capability() {
        use crate::commands::pty_backend::local_session_state;
        let home = std::path::PathBuf::from("/instance");
        let on = caps_with_off(&[]);
        let off = caps_with_off(&[TERMINAL_SERVER_SIDECAR]);
        assert_eq!(
            local_session_state(&Caps(&on), Some(home.clone())).root(),
            Some(home.as_path())
        );
        assert_eq!(local_session_state(&Caps(&off), Some(home)).root(), None);
        assert_eq!(local_session_state(&Caps(&on), None).root(), None);
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
