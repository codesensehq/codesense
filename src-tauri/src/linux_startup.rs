// SPDX-License-Identifier: MIT
//! Linux process setup that must run before the webview exists.

use std::ffi::OsStr;

const DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// The value to set for `WEBKIT_DISABLE_DMABUF_RENDERER`, or `None` to keep what the user set
/// (any value, `0` included). WebKitGTK's DMABUF renderer renders a blank window in many VMs.
pub fn webkit_env_default(user_value: Option<&OsStr>) -> Option<&'static str> {
    user_value.is_none().then_some("1")
}

/// Applies the WebKitGTK defaults on Linux and does nothing elsewhere. Call first in `main`,
/// before any thread starts.
pub fn apply_webkit_env_defaults() {
    if std::env::consts::OS != "linux" {
        return;
    }
    let user_value = std::env::var_os(DMABUF_VAR);
    if let Some(value) = webkit_env_default(user_value.as_deref()) {
        // Safe to mutate the environment here: this crate is edition 2021, where `set_var` is
        // not `unsafe`, and the call runs before any thread starts, which is the condition
        // edition 2024 makes callers uphold with an `unsafe` block.
        std::env::set_var(DMABUF_VAR, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkit_env_default_table() {
        assert_eq!(webkit_env_default(None), Some("1"));
        assert_eq!(webkit_env_default(Some(OsStr::new("0"))), None);
        assert_eq!(webkit_env_default(Some(OsStr::new("1"))), None);
        assert_eq!(webkit_env_default(Some(OsStr::new(""))), None);
    }
}
