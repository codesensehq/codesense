// SPDX-License-Identifier: MIT
//! Claude's hooks as `codesense-bridge hook …` runs them: the status post ([`notify`]), the
//! secret-file guard's verdict ([`secret_guard`]) and the reply reminder ([`reply_check`]),
//! with the one list of protected credential files ([`FAMILIES`], [`PROTECTED_DIRS`]), and the
//! hook commands CodeSense writes to run them ([`command`]).
//!
//! They port the bash status script and the Perl guard script earlier releases installed, so a
//! hook needs no bash, curl or perl; "the script" below is that guard, whose reading of a call
//! the verdict keeps. The list lives here, beside the verdict, and `codesense-pty-core`
//! re-exports it: the guard and Claude's `permissions.deny` rules keep one list.
//!
//! The guard is a credential-exfiltration control, so its port may only deny more than the
//! script: it judges every path in the script's own form and in widened forms (`\` as a
//! separator, names in any letter case), and denies if any form denies.

use std::sync::LazyLock;

use regex::Regex;

mod command;
mod notify;
mod reply_check;

pub use command::{
    command, legacy_verb, HookCommand, HookTarget, Verb, BRIDGE, HOST_ENV, LEGACY_COMMANDS,
};
pub use notify::{notify, HookEnv, Outcome};
pub use reply_check::{reply_check, Block, REPLY_CHECK_PATH};

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

/// A protected directory as the guard matches it: anywhere in a path, without the `~/`.
fn protected_dir(dir: &str) -> &str {
    dir.trim_start_matches("~/")
}

/// The reason the guard gives the agent, word for word the script's.
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
    let (mut depth, mut deepest, mut in_string) = (0usize, 0, false);
    // JSON::PP holds a high-surrogate escape until a low one pairs with it, however much of the
    // string comes between, and a later high replaces it. Hold it here too and emit it just
    // before the next `\u` escape or the closing quote: before a low, that is the pair, at the
    // low's place as the script puts it; before any other `\u` escape or the closing quote it
    // stays unpaired, and serde_json refuses the string as the script does. Simple escapes such
    // as `\n` leave it held.
    let mut held: Option<String> = None;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_string {
            match c {
                '\\' if hex_escape(chars.clone()) => {
                    let escape: String = std::iter::once(c).chain(chars.by_ref().take(5)).collect();
                    if let [b'd' | b'D', b'8' | b'9' | b'a' | b'b' | b'A' | b'B'] =
                        &escape.as_bytes()[2..4]
                    {
                        held = Some(escape);
                    } else {
                        tamed.extend(held.take());
                        tamed.push_str(&escape);
                    }
                    continue;
                }
                '\\' => {
                    tamed.push(c);
                    tamed.extend(chars.next());
                    continue;
                }
                '"' => {
                    in_string = false;
                    tamed.extend(held.take());
                }
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

/// Whether `rest`, just past a backslash in a string, is `u` and four hex digits.
fn hex_escape(mut rest: impl Iterator<Item = char>) -> bool {
    rest.next() == Some('u') && rest.take(4).filter(char::is_ascii_hexdigit).count() == 4
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

/// The paths a Bash command reads. A path that is only written, created, deleted or the
/// destination of a copy is not read. Two invariants, one per kind of segment:
///
/// - An all-ASCII segment is read exactly as the script's loop reads it: on ASCII, `\d`, `\w`
///   and `\s` mean the same in every Perl.
/// - A segment holding any character at or above 0x80 is read as a superset of every reading
///   any Perl could make of it, whatever its Unicode tables: every word counts as read (write
///   targets and a write-only verb's operands too), split at redirections, each also without
///   the trailing digits or non-ASCII characters a redirection may take. It relies on no Unicode
///   property but White_Space, which splitting words needs anyway, and does linear work. Such
///   a segment may be denied where the script allows it.
fn bash_reads(cmd: &str) -> Vec<String> {
    static SEGMENT: LazyLock<Regex> = LazyLock::new(|| regex(r"&&|\|\||;|\||\n"));
    static OPTION_VALUE: LazyLock<Regex> = LazyLock::new(|| regex(r"^-[^=]*=(.+)$"));

    let mut read: Vec<String> = Vec::new();
    for segment in SEGMENT.split(cmd) {
        if segment.is_ascii() {
            read.extend(exact_reads(segment));
        } else {
            read.extend(superset_reads(segment));
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

/// The script's words: split on whitespace, quotes, backquotes and parentheses.
static WORDS: LazyLock<Regex> = LazyLock::new(|| regex(r#"[\s"'`()]+"#));

/// What the script reads in one all-ASCII segment, statement for statement as its loop.
fn exact_reads(segment: &str) -> Vec<String> {
    static REDIRECT: LazyLock<Regex> = LazyLock::new(|| regex(r"(\d*[<>]+&?)"));
    static WRITE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d*>"));
    static READ: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d*<"));
    static ASSIGN: LazyLock<Regex> = LazyLock::new(|| regex(r"^[A-Za-z_]\w*="));

    let spaced = REDIRECT.replace_all(segment, " ${1} ");
    let mut words = WORDS.split(&spaced).filter(|w| !w.is_empty());
    let mut read: Vec<String> = Vec::new();
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
            if PREFIX.contains(&&*base) {
                continue;
            }
            verb = Some(base);
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

/// Every word any Perl could read in a segment holding non-ASCII text. The script spaces out
/// `\d*[<>]+&?` before splitting, so none of its words holds `<` or `>`, and which characters its
/// `\d` takes depends on its Unicode version: a digit is ASCII `0-9` or non-ASCII. So the words
/// are the pieces between whitespace, quotes, parentheses and `[<>]+&?`, each also without its
/// whole trailing run of `0-9` and non-ASCII characters. A word the script could cut inside
/// that run ends in such a character, so it can only match a family whose glob ends in `*`, which
/// the whole piece then matches too, and no exception or directory name ends in one
/// (`protected_names_end_where_a_cut_word_cannot`); trying each cut would be quadratic in a long
/// run.
fn superset_reads(segment: &str) -> Vec<String> {
    static CUT: LazyLock<Regex> = LazyLock::new(|| regex(r#"(?:[\s"'`()]|[<>]+&?)+"#));

    let mut read: Vec<String> = Vec::new();
    for piece in CUT.split(segment).filter(|w| !w.is_empty()) {
        read.push(piece.to_string());
        let stem = piece.trim_end_matches(|c: char| c.is_ascii_digit() || !c.is_ascii());
        if !stem.is_empty() && stem.len() < piece.len() {
            read.push(stem.to_string());
        }
    }
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

    fn call(tool: &str, input: Value) -> Value {
        json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input})
    }

    /// JSON `\u` escapes: two high surrogates, a low one and a character that is neither.
    const HIGH: &str = "\\ud800";
    const HIGH2: &str = "\\udbff";
    const LOW: &str = "\\udc00";
    const HIGH_UPPER: &str = "\\uD9AB";
    const HIGH_MIXED: &str = "\\uDa00";
    const LOW_LAST: &str = "\\uDFFF";
    const PLAIN: &str = "\\u0041";

    /// Strings JSON::PP reads as a split surrogate pair: a high escape, then a character, a
    /// simple escape or another high (which replaces it), then the low that pairs with it. The
    /// hex digits may be either case.
    fn split_pairs() -> [String; 5] {
        [
            format!("{HIGH}x{LOW}"),
            format!("{HIGH}\\n{LOW}"),
            format!("{HIGH2}{HIGH}{LOW}"),
            format!("{HIGH_UPPER}x{LOW}"),
            format!("{HIGH_MIXED}\\n{LOW_LAST}"),
        ]
    }

    /// Strings JSON::PP and serde_json both refuse: a high followed by a non-surrogate `\u`
    /// escape or the closing quote before any low, and a low with no high before it.
    fn unpaired() -> [String; 5] {
        [
            format!("{HIGH}A"),
            HIGH.to_string(),
            LOW.to_string(),
            format!("{HIGH}{PLAIN}{LOW}"),
            format!("{HIGH}{LOW}{LOW}"),
        ]
    }

    /// Payloads carrying the JSON string body `s`: beside a protected path, as a key, in a Bash
    /// description and in the command itself.
    fn carrying(s: &str) -> [String; 4] {
        [
            format!(
                r#"{{"tool_name":"Read","tool_input":{{"file_path":"/repo/.env","x":"{s}"}}}}"#
            ),
            format!(r#"{{"tool_name":"Read","tool_input":{{"file_path":"/repo/.env","{s}":1}}}}"#),
            format!(
                r#"{{"tool_name":"Bash","tool_input":{{"command":"cat .env","description":"{s}"}}}}"#
            ),
            format!(r#"{{"tool_name":"Bash","tool_input":{{"command":"cat .env {s}"}}}}"#),
        ]
    }

    /// The guard's verdict on one hook payload: the deny reason, or `None` when it allows.
    fn verdict(payload: &Value) -> Option<&'static str> {
        secret_guard(payload.to_string().as_bytes()).map(|deny| deny.reason)
    }

    /// Calls the guard denies, the script too.
    fn denied_cases() -> Vec<Value> {
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

    /// Calls the guard denies that the script lets through: Windows paths and other
    /// letter cases.
    fn deny_more_cases() -> Vec<Value> {
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

    /// Calls the guard allows, the script too.
    fn allowed_cases() -> Vec<Value> {
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

    /// JSON::PP pairs a high-surrogate escape with the next low one, whatever comes between,
    /// and puts the pair where the low was; serde_json alone refuses such a string, and the
    /// guard would allow what the script denies.
    #[test]
    fn a_split_surrogate_pair_is_read_as_the_script_reads_it() {
        let reads = [
            ("x", 0x10000),
            ("\n", 0x10000),
            ("", 0x10000),
            ("x", 0x7ac00),
            ("\n", 0x903ff),
        ];
        for (s, (read, pair)) in split_pairs().iter().zip(reads) {
            let pair = char::from_u32(pair).unwrap();
            let decoded = decode(&format!(r#""a{s}b""#));
            assert_eq!(
                decoded,
                Some(Value::String(format!("a{read}{pair}b"))),
                "{s}"
            );
            for input in carrying(s) {
                assert!(secret_guard(input.as_bytes()).is_some(), "{input}");
            }
        }
        for s in unpaired() {
            assert_eq!(decode(&format!(r#""{s}""#)), None, "{s}");
            for input in carrying(&s) {
                assert_eq!(secret_guard(input.as_bytes()), None, "{input}");
            }
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

    /// An all-ASCII segment is read as the script's loop reads it, so the word after `<` is read
    /// whatever it looks like. A segment with non-ASCII text is read as a superset of any Perl's
    /// reading: a trailing digit any Unicode version may hand to a redirection is dropped as well
    /// as kept, and a write target counts too (the last row is denied where the script allows
    /// it, the accepted cost). The characters arrive as `\u` escapes.
    #[test]
    fn a_segment_is_read_exactly_or_as_a_superset() {
        for command in [
            r"cat '<' '>' /repo/.env",
            r"cat '<' '>' /repo/.env \u00e9",
            r"A\ud888\udfb0=/bin/rm cat /repo/.env",
            r"cat /repo/.env\u0663>x",
            r"cat /repo/.env\ud839\udcf0>x",
            r"cat /repo/.env\u00e99>x",
            r"echo \u00e9 > /repo/.env",
        ] {
            let input = format!(r#"{{"tool_name":"Bash","tool_input":{{"command":"{command}"}}}}"#);
            assert!(secret_guard(input.as_bytes()).is_some(), "{command}");
        }
    }

    /// A word the superset reader could cut inside its trailing run of digits or non-ASCII
    /// characters ends in one, so trying only the whole piece and the piece without that run is
    /// enough while every family glob ends in `*` or an ASCII letter and every exception and
    /// directory name ends in an ASCII letter. Not `k` or `s`: the Kelvin sign and the long s
    /// fold to them in the case-insensitive form.
    #[test]
    fn protected_names_end_where_a_cut_word_cannot() {
        let letter =
            |c: char| c.is_ascii_alphabetic() && !matches!(c.to_ascii_lowercase(), 'k' | 's');
        let last = |name: &str| name.chars().last().unwrap();
        for family in FAMILIES {
            assert!(
                last(family.glob) == '*' || letter(last(family.glob)),
                "{}",
                family.glob
            );
            for except in family.except {
                assert!(letter(last(except)), "{except}");
            }
        }
        for dir in PROTECTED_DIRS {
            assert!(letter(last(dir)), "{dir}");
        }
    }

    /// A long run of non-ASCII text beside a credential file is still read, and in linear time.
    #[test]
    fn a_long_non_ascii_run_is_read_in_linear_time() {
        let run = "\u{e9}".repeat(100_000);
        for command in [
            format!("cat /repo/.env; echo {run}"),
            format!("cat /repo/.env {run}"),
            format!("cat /repo/.env{run}>x"),
        ] {
            let payload = call("Bash", json!({ "command": command }));
            assert!(verdict(&payload).is_some());
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

    /// Every protected family has a native deny rule, and the hook denies a name in the family
    /// while letting its exceptions through.
    #[test]
    fn every_family_has_a_deny_rule_and_the_hooks_verdict() {
        for family in FAMILIES {
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
