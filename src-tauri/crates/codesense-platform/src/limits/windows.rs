// SPDX-License-Identifier: MIT
//! Windows: no per-process soft limit to raise or hand down, so every entry
//! point is a no-op (see the module docs).

use std::ffi::{OsStr, OsString};

use super::Usage;

/// No soft limit to raise: `None`.
pub fn raise(_wanted: u64) -> Option<(u64, u64)> {
    None
}

/// No limit to carry to a child host: does nothing.
pub fn inherit_original_limit(_command: &mut std::process::Command) {}

/// No shim to serve: does nothing, so [`child_argv`] never wraps.
pub fn serve_child_limit() {}

/// Children run as given: `None`.
pub fn child_argv(_program: &OsStr, _argv: &[OsString]) -> Option<Vec<OsString>> {
    None
}

/// The shim is unix-only; nothing on Windows launches through it.
pub fn exec_with_limit(_args: &[OsString]) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "--nofile-exec is unix-only: Windows has no open-file soft limit to set",
    )
}

/// No soft limit to report: `None`.
pub fn usage() -> Option<Usage> {
    None
}

/// Nothing to sample: does nothing.
pub fn watch(_process: &'static str, _warn: fn(&str)) {}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    #[test]
    fn every_entry_point_is_a_no_op() {
        assert_eq!(super::raise(10_240), None);
        super::serve_child_limit();
        let argv: Vec<OsString> = vec!["pwsh".into()];
        assert_eq!(super::child_argv("pwsh.exe".as_ref(), &argv), None);
        let mut command = std::process::Command::new("pwsh.exe");
        super::inherit_original_limit(&mut command);
        assert_eq!(super::usage(), None);
        super::watch("test", |_| panic!("nothing is sampled"));
        let args: Vec<OsString> = vec!["256".into(), "pwsh.exe".into(), "--".into(), "pwsh".into()];
        assert_eq!(
            super::exec_with_limit(&args).kind(),
            std::io::ErrorKind::Unsupported
        );
        assert!(super::super::limit_reached("test").contains("its limit could not be read"));
    }
}
