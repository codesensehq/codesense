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

/// Every producer's projection, as the renderer's launch and relaunch command runs it.
mod producers {
    use std::path::Path;

    use codesense_pty_core::agent_cli::{descriptor, AgentCli};

    use super::super::{
        finish_launch_execution, remove_scope_config, without_removed_args, LaunchCli,
        ScopeCreation, ScopeOutcome, AGENT_CLI_NOT_FOUND,
    };
    use crate::commands::mcp_authoring::ScopeLaunch;

    const PROGRAM: &str = r"C:\Users\u\AppData\Roaming\npm\claude.exe";
    const PERMISSIVE: &str = "--dangerously-skip-permissions";

    fn session(tag: &str) -> String {
        format!("launch-exec-{tag}-{}", uuid::Uuid::new_v4())
    }

    /// One projection of `launch` for `runtime` on `os`, its scope removed after.
    #[allow(clippy::too_many_arguments)]
    fn project(
        launch: &ScopeLaunch,
        runtime: AgentCli,
        session: &str,
        cwd: &Path,
        allow: Option<&[String]>,
        program: Option<&Path>,
        args: &[String],
        os: &str,
    ) -> Result<(ScopeOutcome, Option<ScopeCreation>), String> {
        let principal = crate::agents::resolve::tests::alice();
        let cli = program.map(|program| LaunchCli::new(program, args));
        let projected = launch.project_launch(
            runtime,
            session,
            cwd,
            allow,
            None,
            cli.as_ref(),
            Some((cwd, &principal)),
            args,
            os,
        );
        remove_scope_config(session);
        projected
    }

    fn argv(outcome: &ScopeOutcome) -> Vec<String> {
        outcome.execution.as_ref().expect("an exec").argv.clone()
    }

    fn words(program: &str, args: &[&str], extra: &[String]) -> Vec<String> {
        std::iter::once(program.to_string())
            .chain(args.iter().map(|arg| arg.to_string()))
            .chain(extra.iter().cloned())
            .collect()
    }

    #[test]
    fn a_named_agent_launch_execs_on_windows_and_is_unchanged_on_macos() {
        let _home = crate::routines::test_support::TempHome::new();
        let root = tempfile::tempdir().unwrap();
        let launch = ScopeLaunch {
            agent: true,
            ..ScopeLaunch::default()
        };
        let args = vec!["--model".to_string(), "opus".to_string()];
        let id = session("agent");
        let program = Some(Path::new(PROGRAM));
        let (windows, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            Some(&[]),
            program,
            &args,
            "windows",
        )
        .unwrap();
        let (macos, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            Some(&[]),
            program,
            &args,
            "macos",
        )
        .unwrap();
        assert_eq!(macos.execution, None);
        assert_eq!(
            argv(&windows),
            words(PROGRAM, &["--model", "opus"], &windows.extra_args)
        );
        assert!(!argv(&windows).contains(&PERMISSIVE.to_string()));
    }

    #[test]
    fn a_scoped_profile_launch_execs_on_windows_and_is_unchanged_on_macos() {
        let _home = crate::routines::test_support::TempHome::new();
        let root = tempfile::tempdir().unwrap();
        let launch = ScopeLaunch::default();
        let args = vec!["--verbose".to_string()];
        let id = session("profile");
        let program = Some(Path::new(PROGRAM));
        let (windows, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            Some(&[]),
            program,
            &args,
            "windows",
        )
        .unwrap();
        let (macos, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            Some(&[]),
            program,
            &args,
            "macos",
        )
        .unwrap();
        assert_eq!(macos.execution, None);
        assert!(windows
            .extra_args
            .contains(&"--strict-mcp-config".to_string()));
        assert_eq!(
            argv(&windows),
            words(PROGRAM, &["--verbose"], &windows.extra_args)
        );
    }

    /// The default tab's launch: the exec is the words of the line macOS types, in order.
    #[test]
    fn a_default_claude_launch_execs_the_words_of_the_macos_typed_line() {
        let _home = crate::routines::test_support::TempHome::new();
        let root = tempfile::tempdir().unwrap();
        let launch = ScopeLaunch {
            default_args: true,
            ..ScopeLaunch::default()
        };
        let id = session("open");
        let program = Some(Path::new(PROGRAM));
        let (windows, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            None,
            program,
            &[],
            "windows",
        )
        .unwrap();
        let (macos, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            None,
            program,
            &[],
            "macos",
        )
        .unwrap();
        assert_eq!(macos.execution, None);
        assert!(!macos.extra_args.is_empty(), "the open scope's flags");
        // `agentLaunchLine` with no allowlist: the agent, the permissive flag, the scope's flags.
        assert_eq!(
            argv(&windows),
            words(PROGRAM, &[PERMISSIVE], &macos.extra_args)
        );
    }

    /// A runtime whose scope declares no open template reaches the open scope's empty outcome.
    #[test]
    fn an_open_launch_with_no_open_template_still_execs_on_windows() {
        let _home = crate::routines::test_support::TempHome::new();
        let root = tempfile::tempdir().unwrap();
        let launch = ScopeLaunch::default();
        let id = session("default");
        let program = Some(Path::new(r"C:\npm\codex.exe"));
        let (windows, _) = project(
            &launch,
            AgentCli::Codex,
            &id,
            root.path(),
            None,
            program,
            &[],
            "windows",
        )
        .unwrap();
        let (macos, _) = project(
            &launch,
            AgentCli::Codex,
            &id,
            root.path(),
            None,
            program,
            &[],
            "macos",
        )
        .unwrap();
        assert!(windows.extra_args.is_empty() && macos.extra_args.is_empty());
        assert_eq!(macos.execution, None);
        assert_eq!(
            argv(&windows).first().map(String::as_str),
            Some(r"C:\npm\codex.exe")
        );
    }

    #[test]
    fn an_unresolved_cli_is_refused_on_windows_and_projects_as_today_elsewhere() {
        let _home = crate::routines::test_support::TempHome::new();
        let root = tempfile::tempdir().unwrap();
        let launch = ScopeLaunch {
            default_args: true,
            ..ScopeLaunch::default()
        };
        let id = session("unresolved");
        let refused = launch.project_launch(
            AgentCli::Claude,
            &id,
            root.path(),
            None,
            None,
            None,
            None,
            &[],
            "windows",
        );
        // The refusal takes the scope it projected with it: nothing is left to launch.
        let left = super::super::mcp_scope_session_dir(&id).exists();
        remove_scope_config(&id);
        assert_eq!(refused.unwrap_err(), AGENT_CLI_NOT_FOUND);
        assert!(!left);
        let (macos, _) = project(
            &launch,
            AgentCli::Claude,
            &id,
            root.path(),
            None,
            None,
            &[],
            "macos",
        )
        .unwrap();
        assert_eq!(macos.execution, None);
    }

    /// Only Claude's own bypass flag is the typed line's permissive flag; no other runtime's
    /// bypass flag reaches a default-args exec (Codex's would turn its sandbox off).
    #[test]
    fn a_default_args_exec_carries_no_other_runtimes_bypass_flag() {
        for runtime in [AgentCli::Codex, AgentCli::OpenCode, AgentCli::Hermes] {
            let mut outcome = ScopeOutcome::default();
            finish_launch_execution(
                &mut outcome,
                runtime,
                Some(Path::new(PROGRAM)),
                &[],
                true,
                "windows",
            )
            .unwrap();
            let argv = argv(&outcome);
            assert!(
                !argv.contains(&descriptor(runtime).bypass_flag),
                "{runtime:?}: {argv:?}"
            );
            assert!(
                !argv.contains(&PERMISSIVE.to_string()),
                "{runtime:?}: {argv:?}"
            );
        }
        let mut claude = ScopeOutcome::default();
        finish_launch_execution(
            &mut claude,
            AgentCli::Claude,
            Some(Path::new(PROGRAM)),
            &[],
            true,
            "windows",
        )
        .unwrap();
        assert_eq!(argv(&claude), words(PROGRAM, &[PERMISSIVE], &[]));
    }

    #[test]
    fn a_revoked_override_never_reaches_the_exec_argv() {
        let mut outcome = ScopeOutcome {
            remove_args: Some(vec!["-c".into(), "hooks.x=1".into()]),
            extra_args: vec!["--fresh".into()],
            ..ScopeOutcome::default()
        };
        let args: Vec<String> = ["-c", "keep=1", "-c", "hooks.x=1", "--y"]
            .map(String::from)
            .into();
        finish_launch_execution(
            &mut outcome,
            AgentCli::Claude,
            Some(Path::new(PROGRAM)),
            &args,
            false,
            "windows",
        )
        .unwrap();
        assert_eq!(
            argv(&outcome),
            words(PROGRAM, &["-c", "keep=1", "--y", "--fresh"], &[])
        );
    }

    /// The rows the typed relaunch's removal (`withoutRemovedArgs`) asserts too.
    #[test]
    fn removal_matches_whole_overrides_in_order_as_the_typed_relaunch_does() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/remove-args.json")).unwrap();
        let strings = |words: &serde_json::Value| -> Vec<String> {
            serde_json::from_value(words.clone()).unwrap()
        };
        for row in table["rows"].as_array().unwrap() {
            let (args, remove, kept) = (strings(&row[0]), strings(&row[1]), strings(&row[2]));
            assert_eq!(
                without_removed_args(&args, &remove),
                kept,
                "{args:?} - {remove:?}"
            );
        }
    }

    /// A projection that already set its exec (a managed home's relaunch) keeps it.
    #[test]
    fn an_exec_a_projection_set_is_kept() {
        let set = super::super::scoped_execution_on(
            AgentCli::Hermes,
            Path::new("/x/hermes"),
            vec!["-t".into()],
            "macos",
        );
        let mut outcome = ScopeOutcome {
            execution: set.clone(),
            ..ScopeOutcome::default()
        };
        finish_launch_execution(
            &mut outcome,
            AgentCli::Hermes,
            Some(Path::new(PROGRAM)),
            &[],
            true,
            "windows",
        )
        .unwrap();
        assert!(set.is_some());
        assert_eq!(outcome.execution, set);
    }
}

/// A launch of a CLI that needs a configured model endpoint projects no profile launch on
/// any OS, so it never execs: macOS keeps main's refusal.
#[test]
fn a_profile_launch_of_an_endpoint_cli_is_refused_on_every_os() {
    use crate::commands::mcp_authoring::ScopeLaunch;
    let _home = crate::routines::test_support::TempHome::new();
    let root = tempfile::tempdir().unwrap();
    for runtime in AgentCli::ALL.into_iter().filter(|cli| {
        crate::agents::adapter::desktop(*cli)
            .model_endpoint
            .is_some()
    }) {
        for os in ["macos", "linux", "windows"] {
            let id = format!("launch-exec-endpoint-{}", uuid::Uuid::new_v4());
            let args: Vec<String> = Vec::new();
            let cli = super::LaunchCli::new(Path::new("/opt/bin/agent"), &args);
            let projected = ScopeLaunch::default().project_launch(
                runtime,
                &id,
                root.path(),
                None,
                None,
                Some(&cli),
                None,
                &args,
                os,
            );
            super::remove_scope_config(&id);
            assert!(projected.is_err(), "{runtime:?} on {os}");
        }
    }
}
