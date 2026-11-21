// SPDX-License-Identifier: MIT
//! The npm `.cmd` shim parser and the argv it builds, against the shims npm
//! writes today (`fixtures/npm-shims`). Pure text and temp files, so it runs
//! the same on every OS.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use codesense_platform::cli::{npm_shim_script, shim_argv, windows_extension, NpmShim, ShimError};
use codesense_platform::fs::{set_executable, Reach};

const CLAUDE: &str = include_str!("fixtures/npm-shims/claude.cmd");
const CODEX: &str = include_str!("fixtures/npm-shims/codex.cmd");
/// The same shim as cmd-shim 8 (npm 11) writes it.
const CODEX_V8: &str = include_str!("fixtures/npm-shims/codex-cmd-shim-8.cmd");

const CLAUDE_TARGET: &str = r"node_modules\@anthropic-ai\claude-code\bin\claude.exe";
const CODEX_TARGET: &str = r"node_modules\@openai\codex\bin\codex.js";

/// The fixture `text` with its target path `from` replaced by `to`.
fn retarget(text: &str, from: &str, to: &str) -> String {
    assert!(text.contains(from), "{from} is in the fixture");
    text.replace(from, to)
}

fn lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn shim() -> PathBuf {
    Path::new("npm").join("x.cmd")
}

fn node(relative: &str) -> Result<Option<NpmShim>, ShimError> {
    Ok(Some(NpmShim::Node {
        script: Path::new("npm").join(relative),
    }))
}

fn exe(relative: &str) -> Result<Option<NpmShim>, ShimError> {
    Ok(Some(NpmShim::Exe {
        program: Path::new("npm").join(relative),
    }))
}

fn refused(path: &Path) -> Result<Option<NpmShim>, ShimError> {
    Err(ShimError::NotAnNpmShim {
        path: path.to_path_buf(),
    })
}

#[test]
fn the_fixtures_are_the_forms_cmd_shim_writes() {
    for fixture in [CLAUDE, CODEX, CODEX_V8] {
        assert!(fixture.ends_with("\r\n") && !lf(fixture).contains('\r'));
    }
    let claude = Path::new("npm").join("claude.cmd");
    let codex = Path::new("npm").join("codex.cmd");
    assert_eq!(npm_shim_script(&claude, CLAUDE), exe(CLAUDE_TARGET));
    assert_eq!(npm_shim_script(&codex, CODEX), node(CODEX_TARGET));
    assert_eq!(npm_shim_script(&codex, CODEX_V8), node(CODEX_TARGET));
    // The two node forms differ only where PATHEXT is set.
    assert_eq!(
        CODEX_V8.replace("  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n", ""),
        CODEX.replace("set PATHEXT=%PATHEXT:;.JS;=;% & ", "")
    );
}

#[test]
fn the_extension_is_read_as_windows_reads_it() {
    for (name, ext) in [
        ("claude.cmd", Some("cmd")),
        ("claude.CMD", Some("cmd")),
        ("claude.cmd.", Some("cmd")),
        ("claude.cmd ", Some("cmd")),
        ("claude.cmd. .", Some("cmd")),
        (r"C:\npm\claude.Bat", Some("bat")),
        (r"C:\npm\claude.exe", Some("exe")),
        (r"C:\npm.d\claude", None),
        ("C:/npm.d/claude", None),
        ("claude", None),
    ] {
        assert_eq!(windows_extension(name).as_deref(), ext, "{name:?}");
    }
}

#[test]
fn only_npms_two_forms_with_a_contained_path_are_accepted() {
    let endings: [fn(&str) -> String; 2] = [|text| text.to_string(), lf];
    for ending in endings {
        let claude = ending(CLAUDE);
        let codex = ending(CODEX);
        let codex_v8 = ending(CODEX_V8);
        let direct = |to: &str| retarget(&claude, CLAUDE_TARGET, to);
        let script = |to: &str| retarget(&codex, CODEX_TARGET, to);
        let script_v8 = |to: &str| retarget(&codex_v8, CODEX_TARGET, to);
        assert_eq!(npm_shim_script(&shim(), &codex_v8), node(CODEX_TARGET));

        // Both forms, any batch spelling of the shim's name.
        for name in ["x.cmd", "x.CMD", "x.bat", "x.cmd.", "x.cmd "] {
            let path = Path::new("npm").join(name);
            assert_eq!(
                npm_shim_script(&path, &codex),
                node(CODEX_TARGET),
                "{name:?}"
            );
        }
        assert_eq!(npm_shim_script(&shim(), &claude), exe(CLAUDE_TARGET));
        // A space in the path is fine; it reaches the child as one argument.
        let spaced = r"node_modules\my tool\cli.js";
        assert_eq!(npm_shim_script(&shim(), &script(spaced)), node(spaced));
        assert_eq!(npm_shim_script(&shim(), &script_v8(spaced)), node(spaced));
        assert_eq!(
            npm_shim_script(&shim(), &direct(r"node_modules\my tool\bin\t.EXE")),
            exe(r"node_modules\my tool\bin\t.EXE")
        );

        // A path that leaves the shim's tree, names a drive or a stream, or holds batch
        // syntax, in either form.
        for relative in [
            r"..\x\cli.js",
            r"node_modules\..\..\cli.js",
            r"node_modules\.\cli.js",
            r"node_modules\. \cli.js",
            r"node_modules\.. \cli.js",
            r"node_modules\\cli.js",
            r"\x\cli.js",
            "/x/cli.js",
            "node_modules/../cli.js",
            r"C:x\cli.js",
            r"C:\abs\cli.js",
            r"\\server\share\cli.js",
            r"node_modules\x\cli.js:stream",
            r"node_modules\%PATH%\cli.js",
            r"node_modules\!X!\cli.js",
            r#"node_modules\x" & calc & "\cli.js"#,
            "node_modules\\x\u{7}\\cli.js",
        ] {
            assert_eq!(
                npm_shim_script(&shim(), &script(relative)),
                refused(&shim()),
                "node form {relative:?}"
            );
            assert_eq!(
                npm_shim_script(&shim(), &script_v8(relative)),
                refused(&shim()),
                "cmd-shim 8 node form {relative:?}"
            );
            let as_exe = format!("{relative}.exe");
            assert_eq!(
                npm_shim_script(&shim(), &direct(&as_exe)),
                refused(&shim()),
                "direct form {as_exe:?}"
            );
        }
        assert_eq!(npm_shim_script(&shim(), &script("")), refused(&shim()));
        // The direct form runs only an `.exe`: never a batch file, a script or a bare name.
        for relative in [
            r"node_modules\x\bin\x.cmd",
            r"node_modules\x\bin\x.bat",
            r"node_modules\x\bin\x.js",
            r"node_modules\x\bin\x",
            r"node_modules\x\bin\x.exe:x.cmd",
        ] {
            assert_eq!(
                npm_shim_script(&shim(), &direct(relative)),
                refused(&shim()),
                "direct form {relative:?}"
            );
        }
    }
}

#[test]
fn every_other_batch_file_is_refused() {
    let head = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
    let node_body = "\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\n";
    let launch =
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & ";
    // The pieces rebuild the node fixture exactly, so each variant below differs from it only
    // where it says.
    assert_eq!(
        format!("{head}{node_body}{launch}\"%_prog%\"  \"%dp0%\\{CODEX_TARGET}\" %*\r\n"),
        CODEX
    );
    for (what, text) in [
        ("hand-written", "@echo off\r\nnode \"%~dp0\\cli.js\" %*\r\n".to_string()),
        ("empty", String::new()),
        (
            "legacy %~dp0 form",
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\x\\cli.js\" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\node_modules\\x\\cli.js\" %*\r\n)\r\n".to_string(),
        ),
        (
            "shebang args",
            format!("{head}{node_body}{launch}\"%_prog%\" --inspect \"%dp0%\\{CODEX_TARGET}\" %*\r\n"),
        ),
        (
            "shebang variables",
            format!("{head}@SET NODE_ENV=x\r\n{node_body}{launch}\"%_prog%\"  \"%dp0%\\{CODEX_TARGET}\" %*\r\n"),
        ),
        (
            "_prog names something other than node",
            CODEX.replace("SET \"_prog=node\"", "SET \"_prog=deno\""),
        ),
        (
            "_prog beside the shim is not node.exe",
            CODEX.replace("\"_prog=%dp0%\\node.exe\"", "\"_prog=%dp0%\\evil.exe\""),
        ),
        (
            "cmd-shim 9's body with cmd-shim 8's launch line",
            CODEX.replace("set PATHEXT=%PATHEXT:;.JS;=;% & ", ""),
        ),
        (
            "cmd-shim 8's body with cmd-shim 9's launch line",
            CODEX_V8.replace(
                "title %COMSPEC% & \"%_prog%\"",
                "title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & \"%_prog%\"",
            ),
        ),
        (
            "cmd-shim 8's _prog naming something other than node",
            CODEX_V8.replace("SET \"_prog=node\"", "SET \"_prog=deno\""),
        ),
        ("a command after the launch", format!("{CODEX}calc\r\n")),
        ("a command before the head", format!("calc\r\n{CODEX}")),
        ("no line end at the end", CODEX.trim_end().to_string()),
        ("a blank line at the end", format!("{CODEX}\r\n")),
        (
            "the direct form with arguments",
            CLAUDE.replace("\"   %*", "\" --x  %*"),
        ),
        (
            "a pnpm shim",
            "@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET \"NODE_PATH=x\"\r\n)\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\x\\cli.js\" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\..\\x\\cli.js\" %*\r\n)\r\n".to_string(),
        ),
    ] {
        assert_eq!(npm_shim_script(&shim(), &text), refused(&shim()), "{what}");
    }
}

#[test]
fn a_program_that_is_not_a_batch_file_is_none() {
    for name in ["claude.exe", "claude", "claude.cmd.exe", "claude.ps1"] {
        let path = Path::new("npm").join(name);
        assert_eq!(npm_shim_script(&path, CODEX), Ok(None), "{name}");
        assert_eq!(
            shim_argv(&path, &["x"], OsStr::new("")),
            Ok(None),
            "{name} is not read"
        );
    }
}

/// An executable file at `path`, made with its parent dirs.
fn install(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
    set_executable(path, Reach::Everyone).unwrap();
}

fn path_env(dirs: &[&Path]) -> OsString {
    std::env::join_paths(dirs).unwrap()
}

fn os(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

#[test]
fn the_argv_runs_node_beside_the_shim_or_the_first_node_exe_on_path() {
    let tmp = tempfile::tempdir().unwrap();
    let npm = tmp.path().join("npm");
    let codex = npm.join("codex.cmd");
    install(&codex, CODEX);
    let early = tmp.path().join("early");
    let late = tmp.path().join("late");
    install(&early.join("node.cmd"), "@echo off\r\n");
    install(&early.join("node.bat"), "@echo off\r\n");
    install(&late.join("node.exe"), "");
    let path = path_env(&[&early, &late]);
    let args = ["say \"hi\" & %PATH%", "", "trailing\\"];
    let script = npm.join(CODEX_TARGET);

    // No node.exe beside the shim: the first node.exe on PATH, past node.cmd and node.bat.
    let mut expected = vec![
        late.join("node.exe").into_os_string(),
        script.clone().into(),
    ];
    expected.extend(os(&args));
    assert_eq!(shim_argv(&codex, &args, &path), Ok(Some(expected)));

    // node.exe beside the shim wins over PATH.
    install(&npm.join("node.exe"), "");
    let mut expected = vec![npm.join("node.exe").into_os_string(), script.into()];
    expected.extend(os(&args));
    assert_eq!(shim_argv(&codex, &args, &path), Ok(Some(expected)));

    // A direct-program shim runs its .exe, with no node.
    let claude = npm.join("claude.cmd");
    install(&claude, CLAUDE);
    let mut expected = vec![npm.join(CLAUDE_TARGET).into_os_string()];
    expected.extend(os(&args));
    assert_eq!(
        shim_argv(&claude, &args, OsStr::new("")),
        Ok(Some(expected))
    );
}

#[test]
fn a_shim_without_node_or_that_cannot_be_read_is_a_typed_error() {
    let tmp = tempfile::tempdir().unwrap();
    let codex = tmp.path().join("npm").join("codex.cmd");
    install(&codex, CODEX);
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let no_args: [&str; 0] = [];
    assert_eq!(
        shim_argv(&codex, &no_args, &path_env(&[&empty])),
        Err(ShimError::NodeNotFound {
            path: codex.clone()
        })
    );

    let missing = tmp.path().join("npm").join("missing.cmd");
    assert!(matches!(
        shim_argv(&missing, &no_args, OsStr::new("")),
        Err(ShimError::Unreadable { path, .. }) if path == missing
    ));
    let large = tmp.path().join("npm").join("large.cmd");
    install(&large, &format!("{CODEX}{}", " ".repeat(64 * 1024)));
    assert_eq!(
        shim_argv(&large, &no_args, OsStr::new("")),
        Err(ShimError::Unreadable {
            path: large.clone(),
            reason: "larger than 64 KiB".into()
        })
    );
    let binary = tmp.path().join("npm").join("binary.cmd");
    std::fs::write(&binary, [0xff, 0xfe, b'@']).unwrap();
    assert_eq!(
        shim_argv(&binary, &no_args, OsStr::new("")),
        Err(ShimError::Unreadable {
            path: binary.clone(),
            reason: "not UTF-8".into()
        })
    );
    let hand_written = tmp.path().join("npm").join("x.bat");
    install(&hand_written, "@echo off\r\nnode cli.js %*\r\n");
    assert_eq!(
        shim_argv(&hand_written, &no_args, OsStr::new("")),
        Err(ShimError::NotAnNpmShim {
            path: hand_written.clone()
        })
    );

    for error in [
        ShimError::NotAnNpmShim {
            path: hand_written.clone(),
        },
        ShimError::NodeNotFound {
            path: hand_written.clone(),
        },
        ShimError::Unreadable {
            path: hand_written.clone(),
            reason: "denied".into(),
        },
    ] {
        let text = error.to_string();
        assert!(text.contains(&hand_written.display().to_string()), "{text}");
    }
}
