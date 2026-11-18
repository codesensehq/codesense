// SPDX-License-Identifier: MIT
//! Claude's hooks as `codesense-bridge hook …` runs them: the status post ([`notify`]) and the
//! secret-file guard's verdict ([`secret_guard`]), with the one list of protected credential
//! files ([`FAMILIES`], [`PROTECTED_DIRS`]).
//!
//! They port the installed scripts (`scripts/codesense-notify.reference.sh` and the guard
//! [`guard_source`] writes), so a hook needs no bash, curl or perl. The list lives here, beside
//! the verdict, and `codesense-pty-core` re-exports it: the guard, the installed script and
//! Claude's `permissions.deny` rules keep one list.
//!
//! The guard is a credential-exfiltration control, so its port may only deny more than the
//! script: it judges every path in the script's own form and in widened forms (`\` as a
//! separator, names in any letter case), and denies if any form denies.

use std::sync::LazyLock;

use regex::Regex;

mod notify;
#[cfg(test)]
mod oracle;

pub use notify::{notify, HookEnv, Outcome};

/// The secret-file guard's template, installed beside the status hook with the protected
/// families filled in ([`guard_source`]). The repo copy at
/// `scripts/codesense-secret-guard.reference.sh` is the single source of truth for its logic.
const GUARD_TEMPLATE: &str =
    include_str!("../../../../scripts/codesense-secret-guard.reference.sh");

/// One protected family of credential files, named by a basename glob. `except` are the globs
/// the hook lets through (templates, public keys); a native deny rule cannot express an
/// exception, so those are denied to Read, Grep and Glob and stay readable through Bash.
pub struct Family {
    pub glob: &'static str,
    pub except: &'static [&'static str],
}

/// The one list of protected files. The guard's patterns and Claude's `permissions.deny` rules
/// are both generated from it, so they cannot name different things.
pub const FAMILIES: &[Family] = &[
    Family {
        glob: ".env",
        except: &[],
    },
    Family {
        glob: ".env.*",
        except: &[".env.example", ".env.sample", ".env.template", ".env.dist"],
    },
    Family {
        glob: "*.pem",
        except: &[],
    },
    Family {
        glob: "*.key",
        except: &[],
    },
    Family {
        glob: "id_rsa*",
        except: &["*.pub"],
    },
    Family {
        glob: "id_ed25519*",
        except: &["*.pub"],
    },
];

/// Directories under the home folder whose whole contents are protected.
pub const PROTECTED_DIRS: &[&str] = &["~/.config/codesense-mcp"];

/// A basename glob as an anchored regular expression, in the installed guard's Perl syntax.
fn glob_regex(glob: &str) -> String {
    let mut re = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c if c.is_ascii_alphanumeric() || c == '_' => re.push(c),
            c => {
                re.push('\\');
                re.push(c);
            }
        }
    }
    re.push('$');
    re
}

/// Claude's `permissions.deny` rules for the protected families. The hook sees one path or
/// command; these also keep Grep and Glob from reaching a credential file inside a directory
/// they search.
pub fn deny_rules() -> &'static [String] {
    static RULES: LazyLock<Vec<String>> = LazyLock::new(|| {
        FAMILIES
            .iter()
            .map(|f| format!("Read(**/{})", f.glob))
            .chain(PROTECTED_DIRS.iter().map(|d| format!("Read({d}/**)")))
            .collect()
    });
    &RULES
}

/// The guard script as installed: its template with the families and directories written in.
pub fn guard_source() -> String {
    let mut defs = String::from("my @FAMILIES = (\n");
    for f in FAMILIES {
        let except: Vec<String> = f
            .except
            .iter()
            .map(|e| format!("qr/{}/", glob_regex(e)))
            .collect();
        defs.push_str(&format!(
            "  [qr/{}/, [{}]],\n",
            glob_regex(f.glob),
            except.join(", ")
        ));
    }
    defs.push_str(");\nmy @DIRS = (");
    let dirs: Vec<String> = PROTECTED_DIRS
        .iter()
        .map(|d| format!("qr{{{}}}", protected_dir(d).replace('.', "\\.")))
        .collect();
    defs.push_str(&dirs.join(", "));
    defs.push_str(");");
    GUARD_TEMPLATE
        .lines()
        .map(|line| {
            if line.starts_with("# @@PROTECTED@@") {
                defs.clone()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// A protected directory as the guard matches it: anywhere in a path, without the `~/`.
fn protected_dir(dir: &str) -> &str {
    dir.trim_start_matches("~/")
}

/// The reason the guard gives the agent, word for word the installed script's.
pub const GUARD_REASON: &str = "CodeSense blocks reading credential files (.env, key files, ~/.config/codesense-mcp/) so secrets do not land in transcripts. Ask the user to give you the value another way, or read .env.example for the names.";

/// The guard's verdict on a call that would read a credential file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deny {
    pub reason: &'static str,
}

impl Deny {
    /// The PreToolUse deny Claude reads, as the script prints it: canonical (sorted keys), no
    /// trailing newline.
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": self.reason,
            }
        })
        .to_string()
    }
}

/// The guard's verdict on one PreToolUse payload: a [`Deny`] when the call reads a credential
/// file, `None` otherwise. Input it cannot parse is allowed: the guard never blocks work
/// because of its own failure.
///
/// The script decodes stdin with `JSON::PP->new->decode` and no `->utf8`, so each raw byte is
/// one character (Latin-1) while a `\u` escape is its code point; its `\s` and `\d` then follow
/// Unicode rules. This reads the input the same way, so words split where the script splits
/// them.
pub fn secret_guard(input: &[u8]) -> Option<Deny> {
    let text: String = input.iter().map(|&b| char::from(b)).collect();
    let Ok(serde_json::Value::Object(call)) = serde_json::from_str(&text) else {
        return None;
    };
    let tool = call.get("tool_name").and_then(scalar).unwrap_or_default();
    let Some(serde_json::Value::Object(tool_input)) = call.get("tool_input") else {
        return None;
    };
    let field = |key: &str| tool_input.get(key).and_then(scalar);
    // What the call READS: only those paths can put a credential into the transcript.
    let paths: Vec<String> = match tool.as_str() {
        "Read" => field("file_path").into_iter().collect(),
        "Grep" => [field("path"), field("glob")]
            .into_iter()
            .flatten()
            .collect(),
        "Glob" => [field("pattern"), field("path")]
            .into_iter()
            .flatten()
            .collect(),
        "Bash" => bash_reads(&field("command").unwrap_or_default()),
        _ => return None,
    };
    paths.iter().any(|p| secret(p)).then_some(Deny {
        reason: GUARD_REASON,
    })
}

/// A JSON value as Perl stringifies it, where it could name a path; arrays, objects, booleans
/// and null never name one.
fn scalar(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("guard pattern")
}

/// Perl's `s{.*/}{}`: drop everything up to the last `/` on the first line holding one.
static DIRNAME: LazyLock<Regex> = LazyLock::new(|| regex(".*/"));

fn basename(path: &str) -> std::borrow::Cow<'_, str> {
    DIRNAME.replacen(path, 1, "")
}

/// Verbs whose operands are all written or removed, never read.
const WRITE_ONLY: &[&str] = &[
    "rm", "rmdir", "unlink", "touch", "mkdir", "chmod", "chown", "chgrp", "ln", "truncate",
];
/// Verbs whose last operand is the destination; the others are read.
const TO_DESTINATION: &[&str] = &["cp", "mv", "install"];
const PREFIX: &[&str] = &[
    "sudo", "env", "command", "exec", "time", "nohup", "nice", "xargs",
];

/// The paths a Bash command reads, word for word as the script finds them. A path that is only
/// written, created, deleted or the destination of a copy is not read.
fn bash_reads(cmd: &str) -> Vec<String> {
    static SEGMENT: LazyLock<Regex> = LazyLock::new(|| regex(r"&&|\|\||;|\||\n"));
    static REDIRECT: LazyLock<Regex> = LazyLock::new(|| regex(r"(\d*[<>]+&?)"));
    static WORDS: LazyLock<Regex> = LazyLock::new(|| regex(r#"[\s"'`()]+"#));
    static WRITE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d*>"));
    static READ: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d*<"));
    static ASSIGN: LazyLock<Regex> = LazyLock::new(|| regex(r"^[A-Za-z_]\w*="));
    static OPTION_VALUE: LazyLock<Regex> = LazyLock::new(|| regex(r"^-[^=]*=(.+)$"));

    let mut read: Vec<String> = Vec::new();
    for segment in SEGMENT.split(cmd) {
        let spaced = REDIRECT.replace_all(segment, " ${1} ");
        let mut words = WORDS.split(&spaced).filter(|w| !w.is_empty());
        let mut verb: Option<std::borrow::Cow<'_, str>> = None;
        let mut operands: Vec<&str> = Vec::new();
        while let Some(w) = words.next() {
            if WRITE.is_match(w) {
                // A write target.
                words.next();
                continue;
            }
            if READ.is_match(w) {
                // A redirected read.
                read.extend(words.next().map(str::to_string));
                continue;
            }
            if verb.is_none() && ASSIGN.is_match(w) {
                // VAR=value before the verb.
                continue;
            }
            if verb.is_none() {
                let base = basename(w);
                if !PREFIX.contains(&&*base) {
                    verb = Some(base);
                }
                continue;
            }
            operands.push(w);
        }
        let Some(verb) = verb else { continue };
        if WRITE_ONLY.contains(&&*verb) {
            continue;
        }
        if TO_DESTINATION.contains(&&*verb) {
            let mut args: Vec<&str> = operands
                .into_iter()
                .filter(|a| !a.starts_with('-'))
                .collect();
            args.pop();
            read.extend(args.into_iter().map(str::to_string));
            continue;
        }
        read.extend(operands.into_iter().map(str::to_string));
    }
    // A value after = in an option (--env-file=.env) is an operand too.
    read.into_iter()
        .flat_map(|word| {
            let value = OPTION_VALUE.captures(&word).map(|c| c[1].to_string());
            std::iter::once(word).chain(value)
        })
        .collect()
}

/// Perl's `$` as the last thing in a pattern: the end, or just before a final newline.
const PERL_END: &str = r"\n?\z";

/// The protected list compiled for one letter-case form.
struct Matcher {
    dirs: Vec<Regex>,
    families: Vec<(Regex, Vec<Regex>)>,
}

impl Matcher {
    /// `flags` is `""` for the script's own, case-sensitive form, `"(?i)"` for any case.
    fn new(flags: &str) -> Self {
        let glob = |glob: &str| {
            let body: String = glob
                .chars()
                .map(|c| match c {
                    '*' => ".*".to_string(),
                    '?' => ".".to_string(),
                    c => regex::escape(c.encode_utf8(&mut [0; 4])),
                })
                .collect();
            regex(&format!("{flags}^{body}{PERL_END}"))
        };
        Self {
            dirs: PROTECTED_DIRS
                .iter()
                .map(|d| {
                    let dir = regex::escape(protected_dir(d));
                    regex(&format!("{flags}(?:^|/){dir}(?:/|{PERL_END})"))
                })
                .collect(),
            families: FAMILIES
                .iter()
                .map(|f| (glob(f.glob), f.except.iter().map(|&e| glob(e)).collect()))
                .collect(),
        }
    }

    /// The script's `secret()`: whether `path` is in a protected directory or its basename (or
    /// that basename with glob characters dropped) is in a family and not one of its
    /// exceptions.
    fn denies(&self, path: &str) -> bool {
        if self.dirs.iter().any(|d| d.is_match(path)) {
            return true;
        }
        let base = basename(path);
        let unglobbed = base.replace(['*', '?', '[', ']', '{', '}'], "");
        [&*base, unglobbed.as_str()]
            .into_iter()
            .filter(|name| !name.is_empty())
            .any(|name| {
                self.families.iter().any(|(family, except)| {
                    family.is_match(name) && !except.iter().any(|e| e.is_match(name))
                })
            })
    }
}

/// Whether `path` names a credential file in any candidate form: the script's own (split on
/// `/`, names compared case-sensitively) and the widened ones (split on `/` and `\`, names in
/// any case, and both). A family's exception lifts a deny only within its own form, so a
/// widened form never overrides a deny from another.
fn secret(path: &str) -> bool {
    static FORMS: LazyLock<[Matcher; 2]> =
        LazyLock::new(|| [Matcher::new(""), Matcher::new("(?i)")]);
    if path.is_empty() {
        return false;
    }
    let slashed = path.replace('\\', "/");
    FORMS
        .iter()
        .any(|form| form.denies(path) || form.denies(&slashed))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// A fresh temporary directory, removed when dropped.
    pub(crate) struct TempDir(pub(crate) std::path::PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "codesense-hook-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn call(tool: &str, input: Value) -> Value {
        json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input})
    }

    /// The guard's verdict on one hook payload: the deny reason, or `None` when it allows.
    fn verdict(payload: &Value) -> Option<&'static str> {
        secret_guard(payload.to_string().as_bytes()).map(|deny| deny.reason)
    }

    /// Calls the guard denies, the installed script too.
    pub(crate) fn denied_cases() -> Vec<Value> {
        vec![
            call("Read", json!({"file_path": "/repo/.env"})),
            call("Read", json!({"file_path": "/repo/.env.local"})),
            call("Read", json!({"file_path": "/repo/certs/server.pem"})),
            call("Read", json!({"file_path": "/repo/tls.key"})),
            call("Read", json!({"file_path": "/Users/a/.ssh/id_rsa"})),
            call("Read", json!({"file_path": "/Users/a/.ssh/id_ed25519"})),
            call(
                "Read",
                json!({"file_path": "/Users/a/.config/codesense-mcp/token.json"}),
            ),
            call("Grep", json!({"pattern": "KEY", "path": "/repo/.env"})),
            call("Grep", json!({"pattern": "KEY", "glob": "**/*.pem"})),
            call("Glob", json!({"pattern": "**/.env*"})),
            call(
                "Glob",
                json!({"pattern": "*", "path": "/Users/a/.config/codesense-mcp"}),
            ),
            call("Bash", json!({"command": "cat .env"})),
            call(
                "Bash",
                json!({"command": "grep -r token ~/.config/codesense-mcp/"}),
            ),
            call(
                "Bash",
                json!({"command": "ls && head -3 \"keys/server.key\""}),
            ),
            call(
                "Bash",
                json!({"command": "set -a; source .env.production; set +a"}),
            ),
            // Reading it, whatever else the command does with it.
            call("Bash", json!({"command": "cp .env /tmp/x"})),
            call("Bash", json!({"command": "mv server.pem /tmp/x"})),
            call("Bash", json!({"command": "cat < .env"})),
            call("Bash", json!({"command": "head -n1 .env | wc -c"})),
            call("Bash", json!({"command": "FOO=1 sudo cat .env"})),
            call("Bash", json!({"command": "docker run --env-file=.env img"})),
            call("Bash", json!({"command": "bash -c \"cat .env\""})),
            // An exception lifts a deny only in its own form: the script denies these, so the
            // case-insensitive or `\`-split form allowing them never counts.
            call("Read", json!({"file_path": "/repo/.env.EXAMPLE"})),
            call("Read", json!({"file_path": "/Users/a/.ssh/id_rsa.PUB"})),
            call("Read", json!({"file_path": "/proj/.env.d\\x"})),
            // A no-break space splits words as the script's Unicode `\s` does.
            call("Bash", json!({"command": "cat\u{a0}.env"})),
        ]
    }

    /// Calls the guard denies that the installed script lets through: Windows paths and other
    /// letter cases.
    pub(crate) fn deny_more_cases() -> Vec<Value> {
        vec![
            call("Read", json!({"file_path": "C:\\Users\\a\\proj\\.env"})),
            call(
                "Read",
                json!({"file_path": "C:\\Users\\a\\proj\\.env.local"}),
            ),
            call("Read", json!({"file_path": "C:\\Users\\a\\.ssh\\id_rsa"})),
            call(
                "Read",
                json!({"file_path": "C:\\Users\\a\\.ssh\\id_ed25519"}),
            ),
            call(
                "Read",
                json!({"file_path": "C:\\Users\\a\\.config\\codesense-mcp\\token.json"}),
            ),
            call("Bash", json!({"command": "type C:\\proj\\.env"})),
            call("Read", json!({"file_path": "/repo/.ENV"})),
            call("Read", json!({"file_path": "/repo/Server.PEM"})),
            call("Read", json!({"file_path": "/Users/a/.ssh/ID_RSA"})),
            call(
                "Read",
                json!({"file_path": "/Users/a/.CONFIG/CodeSense-MCP/token.json"}),
            ),
        ]
    }

    /// Calls the guard allows, the installed script too.
    pub(crate) fn allowed_cases() -> Vec<Value> {
        vec![
            call("Read", json!({"file_path": "/repo/.env.example"})),
            call("Read", json!({"file_path": "/repo/.env.sample"})),
            call("Read", json!({"file_path": "/repo/src/main.rs"})),
            call("Read", json!({"file_path": "/Users/a/.ssh/id_rsa.pub"})),
            call("Read", json!({"file_path": "/repo/environment.md"})),
            call("Grep", json!({"pattern": "\\.env", "path": "/repo/src"})),
            call("Glob", json!({"pattern": "src/**/*.rs"})),
            call("Bash", json!({"command": "cargo test && cat .env.example"})),
            call("Bash", json!({"command": "ls -la"})),
            // Setup and cleanup only write, create or remove the protected file.
            call("Bash", json!({"command": "cp .env.example .env"})),
            call("Bash", json!({"command": "rm .env"})),
            call(
                "Bash",
                json!({"command": "rm -f .env.local server.pem && touch .env"}),
            ),
            call("Bash", json!({"command": "echo A=1 > .env"})),
            call("Bash", json!({"command": "echo A=1 >> .env.local"})),
            call("Bash", json!({"command": "mv .env.example .env"})),
            call(
                "Write",
                json!({"file_path": "/repo/.env", "content": "A=1"}),
            ),
            json!({"tool_name": "Read"}),
        ]
    }

    #[test]
    fn the_guard_denies_credential_files_for_every_reading_tool() {
        for payload in denied_cases() {
            let reason = verdict(&payload).unwrap_or_else(|| panic!("allowed: {payload}"));
            assert!(reason.contains("credential files"), "{reason}");
        }
    }

    #[test]
    fn the_guard_denies_windows_paths_and_any_letter_case() {
        for payload in deny_more_cases() {
            assert!(verdict(&payload).is_some(), "allowed: {payload}");
        }
    }

    #[test]
    fn the_guard_allows_ordinary_work_and_the_example_files() {
        for payload in allowed_cases() {
            assert_eq!(verdict(&payload), None, "denied: {payload}");
        }
    }

    #[test]
    fn the_guard_allows_what_it_cannot_parse() {
        let inputs: [&[u8]; 4] = [b"not json", b"", b"[1]", b"{\"tool_name\":\"Read\"} x"];
        for input in inputs {
            assert_eq!(secret_guard(input), None, "{input:?}");
        }
    }

    /// Words split where the script's Latin-1 decode splits them: a raw byte is one character,
    /// so the raw no-break space `C2 A0` and the `A0` inside `à` (`C3 A0`) both end a word, and
    /// an escaped `\u2003` is a space while its raw bytes are not.
    #[test]
    fn the_guard_splits_words_as_the_script_decodes_them() {
        let bash = |command: &[u8]| {
            let mut input = br#"{"tool_name":"Bash","tool_input":{"command":""#.to_vec();
            input.extend_from_slice(command);
            input.extend_from_slice(br#""}}"#);
            secret_guard(&input)
        };
        assert!(bash(b"cat\xc2\xa0.env").is_some());
        assert!(bash(b"cat\xc3\xa0.env").is_some());
        assert!(bash(b"cat\\u2003.env").is_some());
        assert!(
            bash(b"cat\xe2\x80\x83.env").is_none(),
            "one word, no operand"
        );
        assert!(bash(b"cat\\u00a0x\xc2\xa0.env").is_some());
    }

    /// Perl's `$` also matches before a final newline, so a name with one is still the name.
    #[test]
    fn a_trailing_newline_does_not_hide_a_name() {
        for path in [
            "/repo/.env\n",
            "/Users/a/.config/codesense-mcp\n",
            "id_rsa\n",
        ] {
            let payload = call("Read", json!({ "file_path": path }));
            assert!(verdict(&payload).is_some(), "{path:?}");
        }
    }

    #[test]
    fn the_deny_is_the_scripts_canonical_json() {
        assert!(GUARD_TEMPLATE.contains(GUARD_REASON));
        let deny = Deny {
            reason: GUARD_REASON,
        };
        assert_eq!(
            deny.to_json(),
            format!(
                "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"{GUARD_REASON}\"}}}}"
            )
        );
    }

    /// Every protected family has both a hook pattern and a native deny rule, and the hook
    /// denies a name in the family while letting its exceptions through.
    #[test]
    fn every_family_has_a_hook_pattern_and_a_deny_rule() {
        let script = guard_source();
        for family in FAMILIES {
            assert!(
                script.contains(&format!("qr/{}/", glob_regex(family.glob))),
                "{} has no hook pattern",
                family.glob
            );
            let rule = format!("Read(**/{})", family.glob);
            assert!(deny_rules().contains(&rule), "{rule} is not a deny rule");
            let name = family.glob.replace('*', "backup");
            let path = format!("/repo/keys/{name}");
            let payload = call("Read", json!({ "file_path": path }));
            assert!(
                verdict(&payload).is_some(),
                "{path} is not denied by the hook"
            );
            for except in family.except {
                let path = format!("/repo/keys/{}", except.replace('*', "x"));
                let payload = call("Read", json!({ "file_path": path }));
                assert_eq!(verdict(&payload), None, "{path} is an exception");
            }
        }
        for dir in PROTECTED_DIRS {
            let rule = format!("Read({dir}/**)");
            assert!(deny_rules().contains(&rule), "{rule} is not a deny rule");
        }
        assert_eq!(
            deny_rules().len(),
            FAMILIES.len() + PROTECTED_DIRS.len(),
            "no rule outside the list"
        );
    }

    /// A variant name inside a directory a search walks is covered by the family rule.
    #[test]
    fn the_deny_rules_are_the_families_not_a_list_of_names() {
        for rule in [
            "Read(**/.env.*)",
            "Read(**/id_rsa*)",
            "Read(**/id_ed25519*)",
            "Read(~/.config/codesense-mcp/**)",
        ] {
            assert!(deny_rules().iter().any(|r| r == rule), "{rule}");
        }
    }
}
