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

/// A basename glob as the body of a regular expression: `*` and `?` match within a line, and
/// `escape` writes every other character in the caller's syntax.
fn glob_body(glob: &str, escape: impl Fn(char, &mut String)) -> String {
    let mut re = String::new();
    for c in glob.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => escape(c, &mut re),
        }
    }
    re
}

/// A basename glob as an anchored regular expression, in the installed guard's Perl syntax.
fn glob_regex(glob: &str) -> String {
    let body = glob_body(glob, |c, re| {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            re.push('\\');
        }
        re.push(c);
    });
    format!("^{body}$")
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
    let Some(serde_json::Value::Object(call)) = decode(&text) else {
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

/// How deep `JSON::PP` nests arrays and objects before it gives up (its `max_depth`).
const MAX_DEPTH: usize = 512;

/// `text` as JSON, wherever `JSON::PP` reads it: nested up to [`MAX_DEPTH`] (serde_json stops at
/// 128 by default) and with numbers of any size (serde_json refuses `1e400`). A number never
/// names a path, so each one is read as `0`; JSON the script could read keeps its shape.
fn decode(text: &str) -> Option<serde_json::Value> {
    use serde::Deserialize;
    let mut tamed = String::with_capacity(text.len());
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0, false, false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            tamed.push(c);
            continue;
        }
        match c {
            '"' => in_string = true,
            '[' | '{' => {
                depth += 1;
                deepest = deepest.max(depth);
                if depth > MAX_DEPTH {
                    return None;
                }
            }
            ']' | '}' => depth = depth.saturating_sub(1),
            '-' | '0'..='9' => {
                while chars
                    .next_if(|c| matches!(c, '0'..='9' | '+' | '-' | '.' | 'e' | 'E'))
                    .is_some()
                {}
                tamed.push('0');
                continue;
            }
            _ => {}
        }
        tamed.push(c);
    }
    let parse = move || {
        let mut de = serde_json::Deserializer::from_str(&tamed);
        de.disable_recursion_limit();
        let value = serde_json::Value::deserialize(&mut de).ok()?;
        de.end().ok()?;
        Some(value)
    };
    if deepest <= 128 {
        return parse();
    }
    // Deep input recurses deeply: parse it on a stack sized for it.
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(parse)
        .ok()?
        .join()
        .ok()?
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
///
/// The script's `\d` and `\w` follow its Perl's Unicode version, which the `regex` crate's need
/// not match: one may class a newer letter or digit as one and the other not, and that moves the
/// verb (`A<new letter>=1 rm x` is an assignment then `rm`, or a verb that reads `x`), and a
/// command can mix letters from different versions. So a segment holding any non-ASCII letter or
/// digit is not parsed for its verb: every word in it that is not a write target counts as read,
/// with redirections spaced by either meaning of a digit. That reads at least what any version
/// of the script reads. An all-ASCII segment means the same to every version and is parsed
/// exactly. Splitting words keeps Unicode `\s`.
fn bash_reads(cmd: &str) -> Vec<String> {
    static SEGMENT: LazyLock<Regex> = LazyLock::new(|| regex(r"&&|\|\||;|\||\n"));
    static NON_ASCII_WORD: LazyLock<Regex> = LazyLock::new(|| regex(r"[\w&&[^\x00-\x7F]]"));
    static REDIRECT: LazyLock<Regex> = LazyLock::new(|| regex(r"(\d*[<>]+&?)"));
    static ASCII_REDIRECT: LazyLock<Regex> = LazyLock::new(|| regex(r"([0-9]*[<>]+&?)"));
    static OPTION_VALUE: LazyLock<Regex> = LazyLock::new(|| regex(r"^-[^=]*=(.+)$"));

    let mut read: Vec<String> = Vec::new();
    for segment in SEGMENT.split(cmd) {
        if NON_ASCII_WORD.is_match(segment) {
            for redirect in [&*REDIRECT, &*ASCII_REDIRECT] {
                read.extend(every_word_read(&redirect.replace_all(segment, " ${1} ")));
            }
        } else {
            read.extend(parsed_reads(&REDIRECT.replace_all(segment, " ${1} ")));
        }
    }
    // A value after = in an option (--env-file=FILE) is an operand too.
    read.into_iter()
        .flat_map(|word| {
            let value = OPTION_VALUE.captures(&word).map(|c| c[1].to_string());
            std::iter::once(word).chain(value)
        })
        .collect()
}

static WORDS: LazyLock<Regex> = LazyLock::new(|| regex(r#"[\s"'`()]+"#));
static WRITE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d*>"));

/// The words of a segment (redirections spaced out), past any `>` and its target.
fn words(spaced: &str) -> impl Iterator<Item = &str> {
    let mut words = WORDS.split(spaced).filter(|w| !w.is_empty());
    std::iter::from_fn(move || loop {
        let w = words.next()?;
        if !WRITE.is_match(w) {
            return Some(w);
        }
        // A write target.
        words.next();
    })
}

/// Every word of a segment but its write targets: what any reading of it could read.
fn every_word_read(spaced: &str) -> Vec<String> {
    words(spaced).map(str::to_string).collect()
}

/// What the script reads in one all-ASCII segment: redirected reads, and the operands its verb
/// reads.
fn parsed_reads(spaced: &str) -> Vec<String> {
    static READ: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d*<"));
    static ASSIGN: LazyLock<Regex> = LazyLock::new(|| regex(r"^[A-Za-z_]\w*="));

    let mut read: Vec<String> = Vec::new();
    let mut words = words(spaced);
    let mut verb: Option<std::borrow::Cow<'_, str>> = None;
    let mut operands: Vec<&str> = Vec::new();
    while let Some(w) = words.next() {
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
    let Some(verb) = verb else { return read };
    if WRITE_ONLY.contains(&&*verb) {
        return read;
    }
    if TO_DESTINATION.contains(&&*verb) {
        let mut args: Vec<&str> = operands
            .into_iter()
            .filter(|a| !a.starts_with('-'))
            .collect();
        args.pop();
        read.extend(args.into_iter().map(str::to_string));
        return read;
    }
    read.extend(operands.into_iter().map(str::to_string));
    read
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
            let body = glob_body(glob, |c, re| {
                re.push_str(&regex::escape(c.encode_utf8(&mut [0; 4])))
            });
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
        let check = |name: &str| {
            !name.is_empty()
                && self.families.iter().any(|(family, except)| {
                    family.is_match(name) && !except.iter().any(|e| e.is_match(name))
                })
        };
        check(&base) || check(&unglobbed)
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

    /// A character one Unicode version calls a letter or digit and another does not still
    /// leaves the read found: `regex` and Perl may disagree on new characters, and ASCII
    /// classes alone would miss `é`, which Perl calls a letter. The characters arrive as `\u`
    /// escapes (U+10570, U+16D70, U+00E9, U+0663, U+105C0): raw, their UTF-8 bytes are other
    /// characters. The last row mixes an old letter with a Unicode 16 one, so no single class
    /// reading finds the script's verb.
    #[test]
    fn a_command_is_read_with_either_letter_and_digit_class() {
        for command in [
            r"A\ud801\udd70=1 rm /repo/.env",
            r"\ud81b\udd70>x rm /repo/.env",
            r"A\u00e9=/bin/rm cat /repo/.env",
            r"cat \u0663< /repo/.env",
            r"A\u00e9=/bin/rm B\ud801\uddc0=1 rm /repo/.env",
        ] {
            let input = format!(r#"{{"tool_name":"Bash","tool_input":{{"command":"{command}"}}}}"#);
            assert!(secret_guard(input.as_bytes()).is_some(), "{command}");
        }
    }

    /// The script reads JSON nested up to 512 deep and numbers of any size; past that depth it
    /// cannot parse the input and allows it.
    #[test]
    fn deep_nesting_and_huge_numbers_are_read_as_the_script_reads_them() {
        let read = |extra: &str| {
            format!(
                r#"{{"tool_name":"Read","tool_input":{{"file_path":"/repo/.env","x":{extra}}}}}"#
            )
        };
        let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert!(secret_guard(read(&nested(300)).as_bytes()).is_some());
        assert!(secret_guard(read(&nested(510)).as_bytes()).is_some());
        assert_eq!(secret_guard(read(&nested(600)).as_bytes()), None);
        for number in ["1e400", "-0.5e-999", "123456789012345678901234567890"] {
            assert!(secret_guard(read(number).as_bytes()).is_some(), "{number}");
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
