// SPDX-License-Identifier: MIT
//! SW-PB-21: the build channel and its public host. The frontend reads them at
//! startup to decide whether the activation gate and the "Private beta" labels
//! apply. They are injected with the invoke initialization script, so they exist
//! before any app code runs, and the internal build says `internal`.

#[cfg(cs_channel = "internal")]
const CHANNEL: &str = "internal";
#[cfg(cs_channel = "beta")]
const CHANNEL: &str = "beta";
#[cfg(cs_channel = "beta-staging")]
const CHANNEL: &str = "beta-staging";

/// Forces the terminal renderer (`dom` or `webgl`) and skips the front end's render probe.
const TERMINAL_RENDERER_VAR: &str = "CODESENSE_TERMINAL_RENDERER";

/// The script every webview runs before the page: sets `window.__CODESENSE_CHANNEL__`,
/// `window.__CODESENSE_PUBLIC_HOST__`, `window.__CODESENSE_DASHBOARD_PUBLISH__` and
/// `window.__CODESENSE_TERMINAL_RENDERER__` (the override, or `null`). Built once at startup,
/// so the override is read once.
pub fn init_script() -> String {
    let channel = serde_json::to_string(CHANNEL).expect("channel serializes");
    let host = serde_json::to_string(env!("CODESENSE_PUBLIC_HOST")).expect("host serializes");
    let publishing = cfg!(feature = "dashboard-publish");
    let value = std::env::var(TERMINAL_RENDERER_VAR).ok();
    let forced = terminal_renderer_override(value.as_deref());
    if let (Some(value), None) = (&value, forced) {
        // Built once, before the log plugin is up: say it on stderr, as early startup does.
        crate::console_log::write_stderr_line(&format!(
            "{TERMINAL_RENDERER_VAR}={value:?} is not dom or webgl; ignored"
        ));
    }
    let renderer = serde_json::to_string(&forced).expect("renderer serializes");
    format!("window.__CODESENSE_CHANNEL__={channel};window.__CODESENSE_PUBLIC_HOST__={host};window.__CODESENSE_DASHBOARD_PUBLISH__={publishing};window.__CODESENSE_TERMINAL_RENDERER__={renderer};")
}

/// The renderer the variable forces: `dom` or `webgl`, in any case and with spaces around it.
/// Anything else forces nothing.
fn terminal_renderer_override(value: Option<&str>) -> Option<&'static str> {
    match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("dom") => Some("dom"),
        Some("webgl") => Some("webgl"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_init_script_names_the_build_channel_and_host() {
        let script = init_script();
        assert!(script.contains(&format!("window.__CODESENSE_CHANNEL__=\"{CHANNEL}\"")));
        assert!(script.contains("window.__CODESENSE_PUBLIC_HOST__=\""));
        assert!(script.contains(&format!(
            "window.__CODESENSE_DASHBOARD_PUBLISH__={}",
            cfg!(feature = "dashboard-publish")
        )));
        assert!(matches!(CHANNEL, "internal" | "beta" | "beta-staging"));
        assert!(script.contains("window.__CODESENSE_TERMINAL_RENDERER__="));
    }

    #[test]
    fn the_terminal_renderer_override_takes_dom_or_webgl_only() {
        assert_eq!(terminal_renderer_override(Some("dom")), Some("dom"));
        assert_eq!(terminal_renderer_override(Some(" WebGL ")), Some("webgl"));
        assert_eq!(terminal_renderer_override(Some("canvas")), None);
        assert_eq!(terminal_renderer_override(Some("")), None);
        assert_eq!(terminal_renderer_override(None), None);
    }
}
