// SPDX-License-Identifier: MIT
// The capability table, `platform-caps.json`, and its gates, `cfg(cap_<key>)`.
// One parser for both readers: the app's and the session server's build scripts
// `include!` this file for the gates, and `src/platform_caps.rs` `include!`s it
// for the runtime answers, so the two cannot read the table differently.

/// Whether a capability exists on one OS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Support {
    On,
    Off,
    /// On only for the listed architectures (`std::env::consts::ARCH` values).
    OnFor(Vec<String>),
    /// Compiled in, and on at runtime when the key's probe says so.
    Probe,
}

/// Who a capability is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The app's: in the runtime table (`caps()`, the `caps:` line). The default.
    Product,
    /// Test and diagnostic code only (`"scope": "test"`): a gate and nothing
    /// more, left out of the runtime table.
    Test,
}

/// One row of the table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub key: String,
    pub macos: Support,
    pub linux: Support,
    pub windows: Support,
    /// Why the capability is off on a platform that lacks it.
    pub reason: String,
    pub scope: Scope,
}

impl Row {
    /// The row's value for one OS; an OS with no column has none.
    pub fn support(&self, os: &str) -> Option<&Support> {
        match os {
            "macos" => Some(&self.macos),
            "linux" => Some(&self.linux),
            "windows" => Some(&self.windows),
            _ => None,
        }
    }
}

/// `[a-z0-9-]+` for a key, `[a-z0-9_]+` for an architecture.
fn is_name(name: &str, separator: u8) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == separator)
}

/// One value: `"on"`, `"off"`, `"probe"` or `{"on": [<arch>…]}` with at least
/// one architecture; `None` for anything else.
pub fn parse_support(value: &serde_json::Value) -> Option<Support> {
    match value {
        serde_json::Value::String(word) => match word.as_str() {
            "on" => Some(Support::On),
            "off" => Some(Support::Off),
            "probe" => Some(Support::Probe),
            _ => None,
        },
        serde_json::Value::Object(map) if map.len() == 1 => {
            let archs = map.get("on")?.as_array()?;
            let archs = archs
                .iter()
                .map(|arch| arch.as_str().filter(|arch| is_name(arch, b'_')))
                .map(|arch| arch.map(str::to_string))
                .collect::<Option<Vec<String>>>()?;
            (!archs.is_empty()).then_some(Support::OnFor(archs))
        }
        _ => None,
    }
}

/// The architectures each OS ships for. An `{"on": [<arch>…]}` value is fully
/// on only when it lists every one of its OS's.
pub const SHIPPED_ARCHS: [(&str, &[&str]); 3] = [
    ("macos", &["aarch64", "x86_64"]),
    ("linux", &["x86_64", "aarch64"]),
    ("windows", &["x86_64"]),
];

/// The architectures of `shipped` that `support` leaves out: none for `"on"`
/// and `"probe"`, every one for `"off"`.
pub fn missing_archs(shipped: &[&'static str], support: &Support) -> Vec<&'static str> {
    match support {
        Support::On | Support::Probe => Vec::new(),
        Support::Off => shipped.to_vec(),
        Support::OnFor(archs) => shipped
            .iter()
            .copied()
            .filter(|shipped| !archs.iter().any(|arch| arch == shipped))
            .collect(),
    }
}

/// A tracking key names the work that turns a capability on where it is off:
/// words of a-z and 0-9 joined by single `-`s (`tray-background`).
pub fn validate_tracked_key(key: &str) -> Result<(), String> {
    let word = |word: &str| {
        !word.is_empty()
            && word
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    };
    if key.split('-').all(word) {
        Ok(())
    } else {
        Err(format!(
            "`{key}` is not a tracking key: words of a-z and 0-9 joined by single `-`s"
        ))
    }
}

/// A row's `tracked` object: a tracking key for each OS of [`SHIPPED_ARCHS`]
/// where the capability is not fully on ([`missing_archs`]), and for no other.
/// A test-scope row has none. Checked here and then dropped; nothing reads it
/// at runtime.
fn check_tracked(row: &Row, tracked: Option<&serde_json::Value>) -> Result<(), String> {
    let key = &row.key;
    let entries = match (tracked, row.scope) {
        (None, Scope::Test) => return Ok(()),
        (Some(_), Scope::Test) => {
            return Err(format!(
                "`{key}`.tracked: a test-scope row tracks nothing; delete `tracked`"
            ))
        }
        (None, Scope::Product) => None,
        (Some(serde_json::Value::Object(entries)), Scope::Product) => Some(entries),
        (Some(other), Scope::Product) => {
            return Err(format!(
                "`{key}`.tracked: {other} is not an object of an OS to a tracking key"
            ))
        }
    };
    if let Some(entries) = entries {
        for (os, entry) in entries {
            if !SHIPPED_ARCHS.iter().any(|(name, _)| *name == os.as_str()) {
                return Err(format!(
                    "`{key}`.tracked.{os}: `{os}` is not \"macos\", \"linux\" or \"windows\""
                ));
            }
            entry
                .as_str()
                .ok_or_else(|| format!("{entry} is not a string"))
                .and_then(validate_tracked_key)
                .map_err(|error| format!("`{key}`.tracked.{os}: {error}"))?;
        }
    }
    for (os, shipped) in SHIPPED_ARCHS {
        let support = row
            .support(os)
            .ok_or_else(|| format!("`{key}` has no `{os}`"))?;
        let missing = missing_archs(shipped, support);
        let entry = entries.and_then(|entries| entries.get(os));
        match (missing.is_empty(), entry) {
            (true, Some(_)) => {
                return Err(format!(
                    "`{key}` is not off on {os}: delete the `tracked.{os}` entry"
                ))
            }
            (false, None) => {
                let archs = match support {
                    Support::OnFor(_) => format!(" {}", missing.join(", ")),
                    _ => String::new(),
                };
                return Err(format!(
                    "`{key}` is off on {os}{archs} and names no tracking key: add `tracked.{os}`"
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

/// The rows of `table`, in file order. Every row is an object with a key
/// (`[a-z0-9-]+`, unique, and so a unique `cfg`), a value per OS, a reason
/// that is not empty, an optional `scope`, `"product"` (the default) or
/// `"test"`, and on a product row a `tracked` key for each OS where it is not
/// fully on ([`check_tracked`]).
pub fn parse_caps(table: &str) -> Result<Vec<Row>, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(table).map_err(|error| error.to_string())?;
    let mut cfgs = std::collections::BTreeSet::new();
    rows.iter()
        .map(|row| -> Result<Row, String> {
            let key = row
                .get("key")
                .and_then(|key| key.as_str())
                .filter(|key| is_name(key, b'-'))
                .ok_or_else(|| format!("{row} has no `key` of a-z, 0-9 and `-`"))?;
            if !cfgs.insert(cap_cfg(key)) {
                return Err(format!("`{key}` has a second row (or the same cfg, {})", cap_cfg(key)));
            }
            let column = |os: &str| -> Result<Support, String> {
                let value = row.get(os).ok_or_else(|| format!("`{key}` has no `{os}`"))?;
                parse_support(value).ok_or_else(|| {
                    format!(
                        "`{key}`.{os}: {value} is not \"on\", \"off\", \"probe\" or {{\"on\": [<arch>…]}}"
                    )
                })
            };
            let reason = row
                .get("reason")
                .and_then(|reason| reason.as_str())
                .filter(|reason| !reason.trim().is_empty())
                .ok_or_else(|| format!("`{key}` has no `reason`"))?;
            let scope = match row.get("scope") {
                None => Scope::Product,
                Some(scope) => match scope.as_str() {
                    Some("product") => Scope::Product,
                    Some("test") => Scope::Test,
                    _ => {
                        return Err(format!(
                            "`{key}`.scope: {scope} is not \"product\" or \"test\""
                        ))
                    }
                },
            };
            let parsed = Row {
                key: key.to_string(),
                macos: column("macos")?,
                linux: column("linux")?,
                windows: column("windows")?,
                reason: reason.to_string(),
                scope,
            };
            check_tracked(&parsed, row.get("tracked"))?;
            Ok(parsed)
        })
        .collect()
}

/// The `cfg` a capability compiles as: `cap_` and its key with `-` as `_`
/// (`terminal-server-sidecar` is `cap_terminal_server_sidecar`).
pub fn cap_cfg(key: &str) -> String {
    format!("cap_{}", key.replace('-', "_"))
}

/// The build override that turns capabilities off, so one platform can compile
/// the code another platform builds without them.
pub const CAPS_OFF_ENV: &str = "CODESENSE_CAPS_OFF";

/// The keys a `CODESENSE_CAPS_OFF` list turns off, in list order: product
/// keys of `rows`, separated by commas, blank entries ignored. A key that is
/// not in the table, or is a test-scope one, is refused. It can only turn a
/// capability off, never on.
pub fn caps_off(list: &str, rows: &[Row]) -> Result<Vec<String>, String> {
    list.split(',')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| match rows.iter().find(|row| row.key == key) {
            Some(row) if row.scope == Scope::Product => Ok(key.to_string()),
            Some(_) => Err(format!(
                "{CAPS_OFF_ENV}: `{key}` is a test-scope capability; only product capabilities can be turned off"
            )),
            None => Err(format!("{CAPS_OFF_ENV}: `{key}` is not a capability in the table")),
        })
        .collect()
}

/// Every key of `table`, in file order, with whether `os` on `arch` compiles
/// it in ([`compiled_rows`]), the `off` list checked by [`caps_off`]. The
/// whole table is checked, so a bad row fails the build on any target.
pub fn compiled_caps(
    table: &str,
    os: &str,
    arch: &str,
    off: &str,
) -> Result<Vec<(String, bool)>, String> {
    let rows = parse_caps(table)?;
    let off = caps_off(off, &rows)?;
    Ok(compiled_rows(&rows, os, arch, &off))
}

/// Every key of `rows`, in file order, with whether `os` on `arch` compiles
/// it in: its value is `"on"`, `"probe"` (compiled in, decided at runtime) or
/// `{"on": [<arch>…]}` listing `arch`, and `off` does not name it. An OS with
/// no column compiles in nothing.
pub fn compiled_rows(rows: &[Row], os: &str, arch: &str, off: &[String]) -> Vec<(String, bool)> {
    rows.iter()
        .map(|row| {
            let on = !off.contains(&row.key)
                && match row.support(os) {
                    Some(Support::On | Support::Probe) => true,
                    Some(Support::OnFor(archs)) => archs.iter().any(|on_for| on_for == arch),
                    Some(Support::Off) | None => false,
                };
            (row.key.clone(), on)
        })
        .collect()
}

/// The `CODESENSE_CAPS_OFF` list as the build reads it (the variable lookup's
/// answer): empty when unset; a value that is not UTF-8 is refused.
pub fn caps_off_list(var: Result<String, std::env::VarError>) -> Result<String, String> {
    match var {
        Ok(list) => Ok(list),
        Err(std::env::VarError::NotPresent) => Ok(String::new()),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{CAPS_OFF_ENV} is not UTF-8")),
    }
}

/// For a build script: reads the table at `path` (relative to the crate),
/// declares a `cfg` per capability and sets the ones the target being built
/// compiles in, less those `CODESENSE_CAPS_OFF` turns off. It hands the
/// effective off list to the crate as the `CODESENSE_CAPS_OFF` env, so the
/// runtime answers off for them too. The table is parsed and the off list
/// checked once. The caller prints its own literal `rerun-if-changed` for the
/// table.
pub fn configure_caps(path: &str) {
    let table =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let target = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} is set by Cargo for build scripts"))
    };
    println!("cargo:rerun-if-env-changed={CAPS_OFF_ENV}");
    let rows = parse_caps(&table).unwrap_or_else(|error| panic!("{path}: {error}"));
    let off = caps_off_list(std::env::var(CAPS_OFF_ENV))
        .and_then(|list| caps_off(&list, &rows))
        .unwrap_or_else(|error| panic!("{path}: {error}"));
    println!("cargo:rustc-env={CAPS_OFF_ENV}={}", off.join(","));
    let caps = compiled_rows(
        &rows,
        &target("CARGO_CFG_TARGET_OS"),
        &target("CARGO_CFG_TARGET_ARCH"),
        &off,
    );
    for (key, on) in caps {
        let cfg = cap_cfg(&key);
        println!("cargo::rustc-check-cfg=cfg({cfg})");
        if on {
            println!("cargo:rustc-cfg={cfg}");
        }
    }
}
