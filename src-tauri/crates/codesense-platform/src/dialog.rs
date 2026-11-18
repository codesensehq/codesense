// SPDX-License-Identifier: MIT
//! A system dialog that asks for a secret with hidden entry. The caller passes
//! the words ([`SecretPrompt`]); the answer comes back only on the dialog
//! program's standard output, never as an argument, an environment variable
//! or a file, and never inside an error.
//!
//! - macOS: `/usr/bin/osascript` with a `display dialog … with hidden answer`
//!   script that reads the text, title and button from its argv.
//! - Linux and the other Unixes: the first of `zenity` and `kdialog` on
//!   `PATH`, the absolute program `SSH_ASKPASS` names, then
//!   `/usr/bin/ssh-askpass` (ssh's own default). A candidate counts when it is
//!   an executable regular file after following symlinks.
//! - Windows: [`DialogError::Unsupported`].
//!
//! Every arm goes through the one runner (null stdin, captured stdout and
//! stderr) and the pure [`argv`] and [`outcome`] helpers, which compile on
//! every OS so their tests run everywhere.

use std::ffi::OsString;
use std::fmt;
use std::path::Path;
use std::process::{Command, Stdio};

/// The words a dialog shows: its window title, the line above the entry and
/// the label of the button that answers.
#[derive(Debug, Clone, Copy)]
pub struct SecretPrompt<'a> {
    pub title: &'a str,
    pub text: &'a str,
    pub ok_label: &'a str,
}

/// Why no answer came back. Cancelling is not an error: it is `Ok(None)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogError {
    /// No dialog program was found (Linux).
    NoDialog,
    /// This OS has no dialog here yet (Windows).
    Unsupported,
    /// The dialog program could not run, or failed. Never holds its stdout.
    Failed(String),
}

impl fmt::Display for DialogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDialog => f.write_str(
                "No passphrase dialog found. Install zenity or kdialog, or set SSH_ASKPASS.",
            ),
            Self::Unsupported => {
                f.write_str("Asking for a key passphrase isn't supported on Windows yet.")
            }
            Self::Failed(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for DialogError {}

/// A dialog program, which fixes its argv and how its exit is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Program {
    Zenity,
    Kdialog,
    /// An `ssh-askpass`-style program: the prompt is its one argument, and
    /// only exit 0 on OK is promised.
    Askpass,
    Osascript,
}

impl Program {
    fn name(self) -> &'static str {
        match self {
            Self::Zenity => "zenity",
            Self::Kdialog => "kdialog",
            Self::Askpass => "ssh-askpass",
            Self::Osascript => "osascript",
        }
    }
}

/// The macOS dialog. `item 1` of argv is the text, `item 2` the title and
/// `item 3` the button; Cancel is button 1 and answers error -128.
pub const OSASCRIPT_LINES: [&str; 3] = [
    "on run argv",
    "text returned of (display dialog (item 1 of argv) default answer \"\" with hidden answer \
     with title (item 2 of argv) buttons {\"Cancel\", (item 3 of argv)} \
     default button 2 cancel button 1 with icon caution)",
    "end run",
];

/// Where macOS keeps `osascript`.
pub const OSASCRIPT: &str = "/usr/bin/osascript";

/// ssh's own askpass default, the last Linux candidate.
pub const ASKPASS_DEFAULT: &str = "/usr/bin/ssh-askpass";

/// The arguments `program` is run with to ask `prompt`.
pub fn argv(program: Program, prompt: &SecretPrompt) -> Vec<OsString> {
    let items = match program {
        Program::Zenity => vec![
            "--entry".to_owned(),
            "--hide-text".to_owned(),
            format!("--title={}", prompt.title),
            format!("--ok-label={}", prompt.ok_label),
            format!("--text={}", zenity_text(prompt.text)),
        ],
        Program::Kdialog => vec![
            "--title".to_owned(),
            prompt.title.to_owned(),
            "--password".to_owned(),
            prompt.text.to_owned(),
        ],
        Program::Askpass => vec![prompt.text.to_owned()],
        Program::Osascript => OSASCRIPT_LINES
            .into_iter()
            .flat_map(|line| ["-e", line])
            .chain(["--", prompt.text, prompt.title, prompt.ok_label])
            .map(str::to_owned)
            .collect(),
    };
    items.into_iter().map(OsString::from).collect()
}

/// zenity (3.x and 4.x) shows `--text` with `g_strcompress` and then as a
/// mnemonic label, not markup: a lone `_` marks a mnemonic and a `\` starts
/// an escape, so both are doubled to show as typed.
fn zenity_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c == '_' || c == '\\' {
            out.push(c);
        }
        out.push(c);
    }
    out
}

/// Read a finished dialog: its exit code (`None` when a signal ended it),
/// stdout and stderr. Exit 0 answers stdout less one trailing newline, and an
/// empty answer is `None`; a cancel is `None`; anything else is
/// [`DialogError::Failed`] naming the program, the code and stderr.
pub fn outcome(
    program: Program,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: &[u8],
) -> Result<Option<String>, DialogError> {
    if code == Some(0) {
        let mut text = String::from_utf8(stdout)
            .map_err(|_| DialogError::Failed("the passphrase is not text".into()))?;
        if text.ends_with('\n') {
            text.pop();
        }
        return Ok((!text.is_empty()).then_some(text));
    }
    let said = String::from_utf8_lossy(stderr);
    let cancelled = match program {
        Program::Askpass => true,
        Program::Zenity | Program::Kdialog => code == Some(1),
        Program::Osascript => said.contains("-128"),
    };
    if cancelled {
        return Ok(None);
    }
    let how = code.map_or_else(|| "a signal".to_owned(), |code| format!("exit {code}"));
    let mut why = format!("the passphrase dialog {} failed ({how})", program.name());
    if !said.trim().is_empty() {
        why = format!("{why}: {}", said.trim());
    }
    Err(DialogError::Failed(why))
}

/// The one runner: `path` with `argv`, stdin null, stdout and stderr captured.
#[cfg_attr(windows, allow(dead_code))]
fn run(path: &Path, argv: &[OsString]) -> Result<(Option<i32>, Vec<u8>, Vec<u8>), DialogError> {
    let output = Command::new(path)
        .args(argv)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            DialogError::Failed(format!(
                "open the passphrase dialog {}: {e}",
                path.display()
            ))
        })?;
    Ok((output.status.code(), output.stdout, output.stderr))
}

#[cfg_attr(windows, allow(dead_code))]
fn ask_with(
    program: Program,
    path: &Path,
    prompt: &SecretPrompt,
) -> Result<Option<String>, DialogError> {
    let (code, stdout, stderr) = run(path, &argv(program, prompt))?;
    outcome(program, code, stdout, &stderr)
}

/// Ask for a secret in this OS's dialog: `None` when the person cancelled or
/// answered nothing.
#[cfg(target_os = "macos")]
pub fn ask_secret(prompt: &SecretPrompt) -> Result<Option<String>, DialogError> {
    ask_with(Program::Osascript, Path::new(OSASCRIPT), prompt)
}

/// Ask for a secret in this OS's dialog: `None` when the person cancelled or
/// answered nothing.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn ask_secret(prompt: &SecretPrompt) -> Result<Option<String>, DialogError> {
    ask_secret_with(
        prompt,
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("SSH_ASKPASS").as_deref(),
        Path::new(ASKPASS_DEFAULT),
    )
}

/// Ask for a secret in this OS's dialog: there is none here yet.
#[cfg(windows)]
pub fn ask_secret(_prompt: &SecretPrompt) -> Result<Option<String>, DialogError> {
    Err(DialogError::Unsupported)
}

/// The Linux search with its inputs passed in: `path_var` and `askpass_var`
/// are the `PATH` and `SSH_ASKPASS` values, `askpass_default` the last
/// candidate. With no candidate it is [`DialogError::NoDialog`].
#[cfg(unix)]
pub fn ask_secret_with(
    prompt: &SecretPrompt,
    path_var: Option<&std::ffi::OsStr>,
    askpass_var: Option<&std::ffi::OsStr>,
    askpass_default: &Path,
) -> Result<Option<String>, DialogError> {
    let (program, path) =
        find_dialog(path_var, askpass_var, askpass_default).ok_or(DialogError::NoDialog)?;
    ask_with(program, &path, prompt)
}

/// The first candidate in order: zenity, kdialog, `SSH_ASKPASS` when absolute,
/// then the default askpass.
#[cfg(unix)]
fn find_dialog(
    path_var: Option<&std::ffi::OsStr>,
    askpass_var: Option<&std::ffi::OsStr>,
    askpass_default: &Path,
) -> Option<(Program, std::path::PathBuf)> {
    let on_path = |program: Program| {
        path_var
            .into_iter()
            .flat_map(std::env::split_paths)
            // An empty or relative entry would run a program from wherever
            // the app was started.
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(program.name()))
            .find(|candidate| is_executable(candidate))
            .map(|found| (program, found))
    };
    let askpass = |path: &Path| {
        (path.is_absolute() && is_executable(path)).then(|| (Program::Askpass, path.to_path_buf()))
    };
    on_path(Program::Zenity)
        .or_else(|| on_path(Program::Kdialog))
        .or_else(|| askpass_var.and_then(|var| askpass(Path::new(var))))
        .or_else(|| askpass(askpass_default))
}

/// An executable regular file, following symlinks: a dangling link is absent.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROMPT: SecretPrompt<'static> = SecretPrompt {
        title: "CodeSense",
        text: "Passphrase for /home/me/.ssh/id_ed25519",
        ok_label: "Save",
    };

    fn strings(argv: Vec<OsString>) -> Vec<String> {
        argv.into_iter()
            .map(|item| item.into_string().unwrap())
            .collect()
    }

    #[test]
    fn zenity_asks_with_hidden_entry_and_escaped_text() {
        assert_eq!(
            strings(argv(Program::Zenity, &PROMPT)),
            [
                "--entry",
                "--hide-text",
                "--title=CodeSense",
                "--ok-label=Save",
                "--text=Passphrase for /home/me/.ssh/id__ed25519",
            ]
        );
    }

    #[test]
    fn zenity_text_shows_underscores_backslashes_and_ampersands_as_typed() {
        fn text_arg(text: &str) -> String {
            let prompt = SecretPrompt { text, ..PROMPT };
            strings(argv(Program::Zenity, &prompt)).pop().unwrap()
        }
        assert_eq!(text_arg("my_key_rsa"), "--text=my__key__rsa");
        assert_eq!(text_arg(r"C:\keys\n"), r"--text=C:\\keys\\n");
        assert_eq!(text_arg("R&D <key>"), "--text=R&D <key>");
    }

    #[test]
    fn kdialog_asks_for_a_password() {
        assert_eq!(
            strings(argv(Program::Kdialog, &PROMPT)),
            [
                "--title",
                "CodeSense",
                "--password",
                "Passphrase for /home/me/.ssh/id_ed25519",
            ]
        );
    }

    #[test]
    fn askpass_gets_the_text_alone() {
        assert_eq!(
            strings(argv(Program::Askpass, &PROMPT)),
            ["Passphrase for /home/me/.ssh/id_ed25519"]
        );
    }

    #[test]
    fn osascript_gets_the_script_then_text_title_and_button() {
        let mut expected = Vec::new();
        for line in OSASCRIPT_LINES {
            expected.extend(["-e", line]);
        }
        expected.extend([
            "--",
            "Passphrase for /home/me/.ssh/id_ed25519",
            "CodeSense",
            "Save",
        ]);
        assert_eq!(strings(argv(Program::Osascript, &PROMPT)), expected);
    }

    fn failed(result: Result<Option<String>, DialogError>) -> String {
        match result {
            Err(DialogError::Failed(why)) => why,
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn an_answer_loses_one_trailing_newline() {
        for program in [
            Program::Zenity,
            Program::Kdialog,
            Program::Askpass,
            Program::Osascript,
        ] {
            assert_eq!(
                outcome(program, Some(0), b"s3cret\n\n".to_vec(), b""),
                Ok(Some("s3cret\n".into()))
            );
            assert_eq!(
                outcome(program, Some(0), b"s3cret".to_vec(), b""),
                Ok(Some("s3cret".into()))
            );
        }
    }

    #[test]
    fn an_empty_answer_is_none() {
        assert_eq!(
            outcome(Program::Zenity, Some(0), b"\n".to_vec(), b""),
            Ok(None)
        );
        assert_eq!(
            outcome(Program::Askpass, Some(0), Vec::new(), b""),
            Ok(None)
        );
    }

    #[test]
    fn an_answer_that_is_not_text_fails_without_it() {
        assert_eq!(
            failed(outcome(Program::Zenity, Some(0), vec![0xff, b'\n'], b"")),
            "the passphrase is not text"
        );
    }

    #[test]
    fn cancel_is_none() {
        assert_eq!(outcome(Program::Zenity, Some(1), Vec::new(), b""), Ok(None));
        assert_eq!(
            outcome(Program::Kdialog, Some(1), Vec::new(), b""),
            Ok(None)
        );
        for code in [Some(1), Some(2), Some(255), None] {
            assert_eq!(outcome(Program::Askpass, code, Vec::new(), b"x"), Ok(None));
        }
        assert_eq!(
            outcome(
                Program::Osascript,
                Some(1),
                Vec::new(),
                b"execution error: User canceled. (-128)\n"
            ),
            Ok(None)
        );
    }

    #[test]
    fn any_other_exit_fails_naming_program_code_and_stderr_but_not_stdout() {
        for (program, code) in [
            (Program::Zenity, 5),
            (Program::Zenity, 255),
            (Program::Kdialog, 2),
            (Program::Osascript, 1),
        ] {
            let why = failed(outcome(
                program,
                Some(code),
                b"hunter2\n".to_vec(),
                b"  no display\n",
            ));
            assert_eq!(
                why,
                format!(
                    "the passphrase dialog {} failed (exit {code}): no display",
                    program.name()
                )
            );
        }
    }

    #[test]
    fn a_signal_fails_a_dialog_but_cancels_an_askpass() {
        for program in [Program::Zenity, Program::Kdialog, Program::Osascript] {
            assert_eq!(
                failed(outcome(program, None, b"hunter2".to_vec(), b"")),
                format!("the passphrase dialog {} failed (a signal)", program.name())
            );
        }
        assert_eq!(outcome(Program::Askpass, None, Vec::new(), b""), Ok(None));
    }

    #[test]
    fn the_errors_read_as_sentences() {
        assert_eq!(
            DialogError::NoDialog.to_string(),
            "No passphrase dialog found. Install zenity or kdialog, or set SSH_ASKPASS."
        );
        assert_eq!(
            DialogError::Unsupported.to_string(),
            "Asking for a key passphrase isn't supported on Windows yet."
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_has_no_dialog_yet() {
        assert_eq!(ask_secret(&PROMPT), Err(DialogError::Unsupported));
    }

    /// The script lines still compile, so a slip in the argv-reading script
    /// fails here instead of in front of a person.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_osascript_lines_compile() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = Command::new("/usr/bin/osacompile");
        for line in OSASCRIPT_LINES {
            command.args(["-e", line]);
        }
        let output = command
            .arg("-o")
            .arg(dir.path().join("dialog.scpt"))
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "osacompile: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    mod fakes {
        use super::*;
        use std::ffi::OsStr;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::path::PathBuf;

        struct Fakes {
            dir: tempfile::TempDir,
        }

        impl Fakes {
            fn new() -> Self {
                let fakes = Self {
                    dir: tempfile::tempdir().unwrap(),
                };
                std::fs::create_dir(fakes.bin()).unwrap();
                fakes
            }

            fn bin(&self) -> PathBuf {
                self.dir.path().join("bin")
            }

            fn path_var(&self) -> OsString {
                self.bin().into_os_string()
            }

            /// Where a fake writes the arguments it got, one per line.
            fn argv_file(&self) -> PathBuf {
                self.dir.path().join("argv")
            }

            /// No default askpass unless a test makes one.
            fn no_default(&self) -> PathBuf {
                self.dir.path().join("ssh-askpass")
            }

            fn script(&self, path: &Path, body: &str, mode: u32) -> PathBuf {
                let script = format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n{body}\n",
                    self.argv_file().display()
                );
                std::fs::write(path, script).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
                path.to_path_buf()
            }

            fn on_path(&self, name: &str, body: &str) -> PathBuf {
                self.script(&self.bin().join(name), body, 0o755)
            }

            fn elsewhere(&self, name: &str, body: &str) -> PathBuf {
                self.script(&self.dir.path().join(name), body, 0o755)
            }

            fn ask(
                &self,
                askpass: Option<&OsStr>,
                default: &Path,
            ) -> Result<Option<String>, DialogError> {
                ask_secret_with(&PROMPT, Some(self.path_var().as_os_str()), askpass, default)
            }

            fn argv_received(&self) -> Vec<String> {
                std::fs::read_to_string(self.argv_file())
                    .unwrap()
                    .lines()
                    .map(str::to_owned)
                    .collect()
            }
        }

        #[test]
        fn zenity_comes_first_and_gets_its_argv() {
            let fakes = Fakes::new();
            fakes.on_path("zenity", "printf 'from zenity\\n'");
            fakes.on_path("kdialog", "printf 'from kdialog\\n'");
            let askpass = fakes.elsewhere("askpass", "printf 'from askpass\\n'");
            let answer = fakes.ask(Some(askpass.as_os_str()), &fakes.no_default());
            assert_eq!(answer, Ok(Some("from zenity".into())));
            assert_eq!(
                fakes.argv_received(),
                strings(argv(Program::Zenity, &PROMPT))
            );
        }

        #[test]
        fn kdialog_comes_before_any_askpass() {
            let fakes = Fakes::new();
            fakes.on_path("kdialog", "printf 'from kdialog\\n'");
            let askpass = fakes.elsewhere("askpass", "printf 'from askpass\\n'");
            let default = fakes.elsewhere("default", "printf 'from default\\n'");
            assert_eq!(
                fakes.ask(Some(askpass.as_os_str()), &default),
                Ok(Some("from kdialog".into()))
            );
            assert_eq!(
                fakes.argv_received(),
                strings(argv(Program::Kdialog, &PROMPT))
            );
        }

        #[test]
        fn ssh_askpass_comes_before_the_default() {
            let fakes = Fakes::new();
            let askpass = fakes.elsewhere("askpass", "printf 'from askpass\\n'");
            let default = fakes.elsewhere("default", "printf 'from default\\n'");
            assert_eq!(
                fakes.ask(Some(askpass.as_os_str()), &default),
                Ok(Some("from askpass".into()))
            );
            assert_eq!(fakes.argv_received(), [PROMPT.text]);
        }

        #[test]
        fn the_default_askpass_is_reached_through_a_symlink() {
            let fakes = Fakes::new();
            let real = fakes.elsewhere("ksshaskpass", "printf 'from default\\n'");
            let default = fakes.dir.path().join("ssh-askpass");
            symlink(&real, &default).unwrap();
            assert_eq!(fakes.ask(None, &default), Ok(Some("from default".into())));
        }

        #[test]
        fn a_symlinked_zenity_on_path_counts() {
            let fakes = Fakes::new();
            let real = fakes.elsewhere("zenity-4", "printf 'from zenity\\n'");
            symlink(&real, fakes.bin().join("zenity")).unwrap();
            assert_eq!(
                fakes.ask(None, &fakes.no_default()),
                Ok(Some("from zenity".into()))
            );
        }

        #[test]
        fn a_dangling_symlink_is_skipped() {
            let fakes = Fakes::new();
            symlink(fakes.dir.path().join("gone"), fakes.bin().join("zenity")).unwrap();
            fakes.on_path("kdialog", "printf 'from kdialog\\n'");
            assert_eq!(
                fakes.ask(None, &fakes.no_default()),
                Ok(Some("from kdialog".into()))
            );
            let dangling = fakes.dir.path().join("dangling-askpass");
            symlink(fakes.dir.path().join("gone"), &dangling).unwrap();
            assert_eq!(
                ask_secret_with(&PROMPT, None, None, &dangling),
                Err(DialogError::NoDialog)
            );
        }

        #[test]
        fn cancel_and_an_empty_answer_are_none() {
            let fakes = Fakes::new();
            fakes.on_path("zenity", "exit 1");
            assert_eq!(fakes.ask(None, &fakes.no_default()), Ok(None));
            fakes.on_path("zenity", "printf '\\n'");
            assert_eq!(fakes.ask(None, &fakes.no_default()), Ok(None));
            let askpass = fakes.elsewhere("askpass", "exit 3");
            assert_eq!(
                ask_secret_with(
                    &PROMPT,
                    None,
                    Some(askpass.as_os_str()),
                    &fakes.no_default()
                ),
                Ok(None)
            );
        }

        #[test]
        fn a_failing_dialog_keeps_its_stdout_out_of_the_error() {
            let fakes = Fakes::new();
            fakes.on_path(
                "zenity",
                "printf 'hunter2\\n'; echo 'cannot open display' >&2; exit 255",
            );
            let why = failed(fakes.ask(None, &fakes.no_default()));
            assert_eq!(
                why,
                "the passphrase dialog zenity failed (exit 255): cannot open display"
            );
            assert!(!why.contains("hunter2"));
        }

        #[test]
        fn a_signal_fails_zenity_and_cancels_an_askpass() {
            let fakes = Fakes::new();
            fakes.on_path("zenity", "printf 'hunter2'; kill -9 $$");
            let why = failed(fakes.ask(None, &fakes.no_default()));
            assert!(why.contains("(a signal)"), "{why}");
            assert!(!why.contains("hunter2"));
            let default = fakes.elsewhere("default", "kill -9 $$");
            assert_eq!(ask_secret_with(&PROMPT, None, None, &default), Ok(None));
        }

        #[test]
        fn an_answer_that_is_not_text_is_refused() {
            let fakes = Fakes::new();
            fakes.on_path("kdialog", "printf '\\377\\n'");
            assert_eq!(
                failed(fakes.ask(None, &fakes.no_default())),
                "the passphrase is not text"
            );
        }

        #[test]
        fn no_dialog_with_an_empty_path_and_no_ssh_askpass() {
            let fakes = Fakes::new();
            assert_eq!(
                ask_secret_with(&PROMPT, Some(OsStr::new("")), None, &fakes.no_default()),
                Err(DialogError::NoDialog)
            );
        }

        #[test]
        fn no_dialog_with_an_empty_ssh_askpass() {
            let fakes = Fakes::new();
            assert_eq!(
                fakes.ask(Some(OsStr::new("")), &fakes.no_default()),
                Err(DialogError::NoDialog)
            );
        }

        #[test]
        fn no_dialog_with_a_relative_ssh_askpass() {
            let fakes = Fakes::new();
            fakes.elsewhere("askpass", "printf 'from askpass\\n'");
            assert_eq!(
                fakes.ask(Some(OsStr::new("askpass")), &fakes.no_default()),
                Err(DialogError::NoDialog)
            );
        }

        #[test]
        fn no_dialog_with_a_ssh_askpass_that_is_not_executable() {
            let fakes = Fakes::new();
            let askpass = fakes.script(
                &fakes.dir.path().join("askpass"),
                "printf 'from askpass\\n'",
                0o644,
            );
            assert_eq!(
                fakes.ask(Some(askpass.as_os_str()), &fakes.no_default()),
                Err(DialogError::NoDialog)
            );
        }

        #[test]
        fn a_program_that_cannot_start_fails_naming_it() {
            let fakes = Fakes::new();
            let missing = fakes.dir.path().join("missing");
            let why = failed(ask_with(Program::Zenity, &missing, &PROMPT));
            assert!(why.contains(&missing.display().to_string()), "{why}");
        }
    }
}
