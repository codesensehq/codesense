// SPDX-License-Identifier: MIT
//! How a launch decides to run its agent as the PTY root, on each OS.

use std::path::Path;

use codesense_pty_core::agent_cli::{adapter, AgentCli};

use super::{launches_direct, scoped_execution_on};

#[test]
fn every_agent_launches_direct_on_windows_and_as_today_on_macos_and_linux() {
    for cli in AgentCli::ALL {
        let today = adapter(cli).end_on_engine_loss();
        assert!(launches_direct(cli, "windows"), "{cli:?} on windows");
        assert_eq!(launches_direct(cli, "macos"), today, "{cli:?} on macos");
        assert_eq!(launches_direct(cli, "linux"), today, "{cli:?} on linux");
    }
}

#[test]
fn a_direct_launch_runs_the_program_first_and_a_shell_launch_has_no_exec() {
    let program = Path::new(r"C:\tools\claude.exe");
    let exec = scoped_execution_on(AgentCli::Claude, program, vec!["--x".into()], "windows")
        .expect("a Windows launch is an exec");
    assert_eq!(
        exec.argv.first().map(String::as_str),
        Some(r"C:\tools\claude.exe")
    );
    assert!(exec.argv.contains(&"--x".to_string()));
    assert_eq!(exec.native_launch, AgentCli::Claude);
    assert_eq!(
        scoped_execution_on(AgentCli::Claude, program, Vec::new(), "macos"),
        None
    );
}
