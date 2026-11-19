// SPDX-License-Identifier: MIT
// The capability gates, `cfg(cap_<key>)`, from `platform-caps.json`: the table
// `src/platform_caps.rs` resolves at runtime. The app's and the session
// server's build scripts `include!` this file, and so do `platform_caps.rs`'s
// tests, since a build script's own tests never run.

/// The `cfg` a capability compiles as: `cap_` and its key with `-` as `_`
/// (`terminal-server-sidecar` is `cap_terminal_server_sidecar`).
pub fn cap_cfg(key: &str) -> String {
    format!("cap_{}", key.replace('-', "_"))
}

/// Every key of `table`, in file order, with whether `os` on `arch` compiles
/// it in: its value is `"on"`, `"probe"` (compiled in, decided at runtime) or
/// `{"on": [<arch>…]}` listing `arch`. An OS with no column compiles in
/// nothing. Every column of every row is checked, so a bad value fails the
/// build on any target.
pub fn compiled_caps(table: &str, os: &str, arch: &str) -> Result<Vec<(String, bool)>, String> {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(table).map_err(|error| error.to_string())?;
    rows.iter()
        .map(|row| {
            let key = row
                .get("key")
                .and_then(|key| key.as_str())
                .ok_or_else(|| format!("{row} has no string `key`"))?;
            let mut on = false;
            for column in ["macos", "linux", "windows"] {
                let value = row
                    .get(column)
                    .ok_or_else(|| format!("`{key}` has no `{column}`"))?;
                let compiled = compiled_in(value, arch).ok_or_else(|| {
                    format!(
                        "`{key}`.{column}: {value} is not \"on\", \"off\", \"probe\" or {{\"on\": [<arch>…]}}"
                    )
                })?;
                if column == os {
                    on = compiled;
                }
            }
            Ok((key.to_string(), on))
        })
        .collect()
}

/// Whether one value compiles its capability in on `arch`; `None` for a value
/// that is none of the forms.
fn compiled_in(value: &serde_json::Value, arch: &str) -> Option<bool> {
    match value {
        serde_json::Value::String(word) => match word.as_str() {
            "on" | "probe" => Some(true),
            "off" => Some(false),
            _ => None,
        },
        serde_json::Value::Object(map) if map.len() == 1 => {
            let archs = map.get("on")?.as_array()?;
            archs
                .iter()
                .try_fold(false, |listed, each| Some(listed || each.as_str()? == arch))
        }
        _ => None,
    }
}

/// Declares a `cfg` per capability and sets the ones the target being built
/// compiles in. The caller reads `table` from `platform-caps.json` and names
/// that path in its own `rerun-if-changed`.
pub fn emit_caps(table: &str) {
    let target = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} is set by Cargo for build scripts"))
    };
    let caps = compiled_caps(
        table,
        &target("CARGO_CFG_TARGET_OS"),
        &target("CARGO_CFG_TARGET_ARCH"),
    )
    .unwrap_or_else(|error| panic!("platform-caps.json: {error}"));
    for (key, on) in caps {
        let cfg = cap_cfg(&key);
        println!("cargo::rustc-check-cfg=cfg({cfg})");
        if on {
            println!("cargo:rustc-cfg={cfg}");
        }
    }
}
