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

/// The rows of `table`, in file order. Every row is an object with a key
/// (`[a-z0-9-]+`, unique, and so a unique `cfg`), a value per OS, a reason
/// that is not empty and an optional `scope`, `"product"` (the default) or
/// `"test"`.
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
            Ok(Row {
                key: key.to_string(),
                macos: column("macos")?,
                linux: column("linux")?,
                windows: column("windows")?,
                reason: reason.to_string(),
                scope,
            })
        })
        .collect()
}

/// The `cfg` a capability compiles as: `cap_` and its key with `-` as `_`
/// (`terminal-server-sidecar` is `cap_terminal_server_sidecar`).
pub fn cap_cfg(key: &str) -> String {
    format!("cap_{}", key.replace('-', "_"))
}

/// Every key of `table`, in file order, with whether `os` on `arch` compiles
/// it in: its value is `"on"`, `"probe"` (compiled in, decided at runtime) or
/// `{"on": [<arch>…]}` listing `arch`. An OS with no column compiles in
/// nothing. The whole table is checked, so a bad row fails the build on any
/// target.
pub fn compiled_caps(table: &str, os: &str, arch: &str) -> Result<Vec<(String, bool)>, String> {
    let rows = parse_caps(table)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let on = match row.support(os) {
                Some(Support::On | Support::Probe) => true,
                Some(Support::OnFor(archs)) => archs.iter().any(|on_for| on_for == arch),
                Some(Support::Off) | None => false,
            };
            (row.key, on)
        })
        .collect())
}

/// For a build script: reads the table at `path` (relative to the crate),
/// declares a `cfg` per capability and sets the ones the target being built
/// compiles in. The caller prints its own literal `rerun-if-changed` for the
/// table.
pub fn configure_caps(path: &str) {
    let table =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let target = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} is set by Cargo for build scripts"))
    };
    let caps = compiled_caps(
        &table,
        &target("CARGO_CFG_TARGET_OS"),
        &target("CARGO_CFG_TARGET_ARCH"),
    )
    .unwrap_or_else(|error| panic!("{path}: {error}"));
    for (key, on) in caps {
        let cfg = cap_cfg(&key);
        println!("cargo::rustc-check-cfg=cfg({cfg})");
        if on {
            println!("cargo:rustc-cfg={cfg}");
        }
    }
}
