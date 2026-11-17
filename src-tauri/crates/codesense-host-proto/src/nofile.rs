// SPDX-License-Identifier: MIT
//! The open-file soft limit, under the path the host protocol's callers use:
//! [`codesense_platform::limits`] holds the mechanism (a host raises its own
//! limit and hands its PTY children the original one).
pub use codesense_platform::limits::{
    child_argv, exec_with_limit, inherit_original_limit, limit_reached, raise, serve_child_limit,
    usage, warning, watch, Alarm, Usage, EXEC_ARG,
};

/// The facade's behaviour before and after the code moved: the frozen shim
/// argument, the shim's refusal of a malformed command and the counted usage.
#[cfg(all(test, unix))]
mod tests {
    use std::ffi::OsString;

    #[test]
    fn the_shim_argument_is_frozen() {
        assert_eq!(super::EXEC_ARG, "--nofile-exec");
    }

    #[test]
    fn the_shim_refuses_a_malformed_command() {
        let args: Vec<OsString> = vec!["many".into(), "/bin/sh".into(), "--".into(), "sh".into()];
        assert_eq!(
            super::exec_with_limit(&args).kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn usage_counts_this_process() {
        let usage = super::usage().unwrap();
        assert!(usage.soft > 0);
        assert!(usage.open.is_some_and(|open| open > 0));
        let reached = super::limit_reached("test");
        assert!(
            reached.starts_with(&format!(
                "open-file limit reached in test (pid {}): ",
                std::process::id()
            )),
            "{reached}"
        );
    }
}
