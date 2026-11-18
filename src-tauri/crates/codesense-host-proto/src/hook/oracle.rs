// SPDX-License-Identifier: MIT
//! The guard's oracle: the installed Perl script ([`guard_source`]) against [`secret_guard`]
//! over a generated corpus. The port may deny more than the script, never less.
//!
//! Ignored by default; the `Rust (Linux)` job runs it with `/usr/bin/perl` on the runner:
//! `cargo test --locked -p codesense-host-proto --lib hook:: -- --ignored`.

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use super::tests::{allowed_cases, call, denied_cases, deny_more_cases, TempDir};
use super::{guard_source, secret_guard, Deny, FAMILIES, GUARD_REASON};

/// How a case's non-ASCII characters reach the guard: raw UTF-8 bytes (one Latin-1 character
/// each to the script), `\u` escapes (their code points), or the first escaped and the rest
/// raw.
#[derive(Clone, Copy)]
enum Encoding {
    Raw,
    Escaped,
    Mixed,
}

fn encode(payload: &Value, encoding: Encoding) -> Vec<u8> {
    let raw = payload.to_string();
    let mut escaped_one = false;
    let mut out = String::new();
    for c in raw.chars() {
        let escape = match encoding {
            Encoding::Raw => false,
            Encoding::Escaped => !c.is_ascii(),
            Encoding::Mixed => !c.is_ascii() && !std::mem::replace(&mut escaped_one, true),
        };
        if escape {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        } else {
            out.push(c);
        }
    }
    out.into_bytes()
}

/// Every payload in each encoding it has: the escaped and mixed forms only differ from the raw
/// one when the payload holds non-ASCII.
fn encodings(payload: &Value) -> Vec<Vec<u8>> {
    let raw = payload.to_string();
    if raw.is_ascii() {
        return vec![raw.into_bytes()];
    }
    [Encoding::Raw, Encoding::Escaped, Encoding::Mixed]
        .into_iter()
        .map(|e| encode(payload, e))
        .collect()
}

/// File names in and around every family: a member, the bare glob, each exception, other letter
/// cases, and names the families must not catch.
fn names() -> Vec<String> {
    let mut names = Vec::new();
    for family in FAMILIES {
        for fill in ["x", "", "backup.old"] {
            names.push(family.glob.replace('*', fill));
        }
        names.push(family.glob.to_string());
        for except in family.except {
            names.push(except.replace('*', "x"));
            names.push(except.to_string());
        }
    }
    let cased: Vec<String> = names
        .iter()
        .flat_map(|n| [n.to_uppercase(), capitalize(n)])
        .collect();
    names.extend(cased);
    names.extend(
        [
            "environment.md",
            ".envrc",
            "env",
            "main.rs",
            "id_rsa.pub.bak",
            ".env.example.local",
            "key",
            "pem",
            "*.pem*",
            "[.]env",
            "{.env,x}",
        ]
        .map(String::from),
    );
    names.sort();
    names.dedup();
    names
}

fn capitalize(name: &str) -> String {
    let mut chars = name.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// A name as different callers write its path: bare, under a directory, Windows-style, with a
/// trailing newline (Perl's `$` matches before it), and across a line break.
fn paths(name: &str) -> Vec<String> {
    vec![
        name.to_string(),
        format!("/repo/{name}"),
        format!("./keys/{name}"),
        format!("C:\\repo\\{name}"),
        format!("/repo/{name}\n"),
        format!("{name}\n"),
        format!("/a\nb/{name}"),
        format!("/repo\\sub/{name}"),
    ]
}

/// The protected directories, written as callers write them.
fn dir_paths() -> Vec<String> {
    let mut paths = Vec::new();
    for dir in ["~/.config/codesense-mcp", "/Users/a/.config/codesense-mcp"] {
        for suffix in ["", "/", "/token.json", "\n", "/x\n"] {
            paths.push(format!("{dir}{suffix}"));
        }
        paths.push(dir.replace('/', "\\"));
        paths.push(dir.to_uppercase());
        paths.push(format!("{dir}-old/token.json"));
        paths.push(format!("{}/x", dir.replace(".config", "config")));
    }
    paths
}

/// Bash commands around one path `{p}`: verbs, quoting, redirections, prefixes, options,
/// segments, non-ASCII whitespace and digits.
const COMMANDS: &[&str] = &[
    "cat {p}",
    "head -n1 {p}",
    "cat \"{p}\"",
    "cat '{p}'",
    "(cat {p})",
    "echo `cat {p}`",
    "cat < {p}",
    "cat <{p}",
    "cat 0<{p}",
    "echo x > {p}",
    "echo x >>{p}",
    "echo x 2>{p}",
    "cat 2>&1 {p}",
    "cp {p} /tmp/x",
    "cp /tmp/x {p}",
    "cp -r {p} {p}.bak /tmp/x",
    "mv -f {p} /tmp/y",
    "install -m 600 /tmp/x {p}",
    "rm {p}",
    "rm -f {p} && cat {p}",
    "touch {p}; cat {p}",
    "FOO=1 cat {p}",
    "A=1 B=2 sudo env cat {p}",
    "/bin/cat {p}",
    "sudo /usr/bin/rm {p}",
    "xargs cat {p}",
    "docker run --env-file={p} img",
    "docker run -e={p}",
    "ls && cat {p}",
    "false || cat {p}",
    "echo | cat {p}",
    "true\ncat {p}",
    "true\r\ncat {p}",
    "cat\t{p}",
    "cat\u{0b}{p}",
    "cat\u{0c}{p}",
    "cat\u{a0}{p}",
    "cat\u{85}{p}",
    "cat\u{2003}{p}",
    "cat\u{3000}{p}",
    "cat\u{2028}{p}",
    "cat\u{e0}{p}",
    "rm\u{a0}x {p}",
    "cp\u{2003}{p} /tmp/x",
    "cat\u{a0}x\u{2003}{p}",
    "cat \u{663}> {p}",
    "cat \u{663}< {p}",
    "cat \u{ff11}>{p}",
    "cat 1\u{663}>{p}",
    "A\u{e9}=1 cat {p}",
    "\u{e9}=1 cat {p}",
    "A\u{e9}=/bin/rm cat {p}",
    "A\u{10570}=1 rm {p}",
    "\u{16d70}>x rm {p}",
    "cat \u{16d70}< {p}",
];

/// The corpus: the moved tests' cases plus the generated variants, each in every encoding.
fn corpus() -> Vec<Vec<u8>> {
    let mut payloads: Vec<Value> = denied_cases()
        .into_iter()
        .chain(deny_more_cases())
        .chain(allowed_cases())
        .collect();
    let names = names();
    let mut all_paths: Vec<String> = names.iter().flat_map(|n| paths(n)).collect();
    all_paths.extend(dir_paths());
    for p in &all_paths {
        payloads.push(call("Read", json!({ "file_path": p })));
        payloads.push(call("Grep", json!({"pattern": "x", "path": p})));
        payloads.push(call("Grep", json!({"pattern": "x", "glob": p})));
        payloads.push(call("Glob", json!({ "pattern": p })));
        payloads.push(call("Glob", json!({"pattern": "*", "path": p})));
    }
    let bash_paths = names
        .iter()
        .flat_map(|n| [n.clone(), format!("/repo/{n}")])
        .chain(dir_paths().into_iter().filter(|p| !p.contains('\n')));
    for p in bash_paths {
        for command in COMMANDS {
            let command = command.replace("{p}", &p);
            payloads.push(call("Bash", json!({ "command": command })));
        }
    }
    // Non-ASCII in the path itself, and payloads of other shapes.
    for p in [
        "/repo/.env\u{a0}",
        "/repo/\u{e9}/.env",
        "/repo/.env\u{2003}x",
    ] {
        payloads.push(call("Read", json!({ "file_path": p })));
        payloads.push(call("Bash", json!({ "command": format!("cat {p}") })));
    }
    payloads.push(call("Read", json!({"file_path": 5})));
    payloads.push(call("Read", json!({"file_path": [".env"]})));
    payloads.push(call("Bash", json!({"command": [".env"]})));
    payloads.push(json!({"tool_name": "Read", "tool_input": ".env"}));
    payloads.push(json!({"tool_name": "Write", "tool_input": {"file_path": ".env"}}));

    let mut corpus: Vec<Vec<u8>> = payloads.iter().flat_map(encodings).collect();
    // Nesting near and past JSON::PP's depth limit, and numbers serde_json alone refuses.
    let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    for extra in [
        nested(300),
        nested(510),
        nested(511),
        "1e400".to_string(),
        "-0.5e-999".to_string(),
        "01".to_string(),
    ] {
        let read = format!(
            r#"{{"tool_name":"Read","tool_input":{{"file_path":"/repo/x.pem","x":{extra}}}}}"#
        );
        corpus.push(read.into_bytes());
    }
    // Bytes that are not one JSON document.
    corpus.push(b"not json".to_vec());
    corpus.push(Vec::new());
    corpus.push(b"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\".env\"}} x".to_vec());
    corpus
        .push(b"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\".env\\ud800\"}}".to_vec());
    corpus
}

/// The installed script, written to a temp directory and run once per case.
struct Script {
    _dir: TempDir,
    path: std::path::PathBuf,
}

impl Script {
    fn install() -> Self {
        let dir = TempDir::new();
        let path = dir.0.join("codesense-secret-guard.sh");
        std::fs::write(&path, guard_source()).unwrap();
        Self { _dir: dir, path }
    }

    /// The script's verdict: whether it denied. A deny is the port's JSON byte for byte.
    fn denies(&self, input: &[u8]) -> bool {
        let mut child = Command::new("/bin/bash")
            .arg(&self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("run the installed guard");
        child.stdin.take().unwrap().write_all(input).unwrap();
        let out = child.wait_with_output().unwrap();
        if out.stdout.is_empty() {
            return false;
        }
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            Deny {
                reason: GUARD_REASON
            }
            .to_json(),
            "the script's deny for {}",
            String::from_utf8_lossy(input)
        );
        true
    }
}

#[test]
#[ignore = "needs /usr/bin/perl; run by the oracle step"]
fn the_port_denies_everything_the_installed_script_denies() {
    let script = Script::install();

    // The raw template denies nothing; the installed script must deny what the tests expect
    // denied, or the comparison below proves nothing.
    for payload in denied_cases() {
        assert!(
            script.denies(payload.to_string().as_bytes()),
            "the installed script allows {payload}"
        );
    }

    let corpus = corpus();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let verdicts: Vec<(bool, bool)> = std::thread::scope(|scope| {
        let chunks: Vec<_> = corpus
            .chunks(corpus.len().div_ceil(threads))
            .map(|chunk| {
                let script = &script;
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|input| (script.denies(input), secret_guard(input).is_some()))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        chunks.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });

    let shown = |input: &Vec<u8>| input.escape_ascii().to_string();
    let mut looser = Vec::new();
    let mut stricter = Vec::new();
    for (input, (perl, port)) in corpus.iter().zip(verdicts) {
        match (perl, port) {
            (true, false) => looser.push(shown(input)),
            (false, true) => stricter.push(shown(input)),
            _ => {}
        }
    }
    // Straight to stderr, past the test harness's capture, so a passing run lists them too.
    let mut log = std::io::stderr().lock();
    let _ = writeln!(
        log,
        "{} cases; the port denies {} the script allows:",
        corpus.len(),
        stricter.len()
    );
    for case in &stricter {
        let _ = writeln!(log, "  deny-more {case}");
    }
    drop(log);
    assert!(
        looser.is_empty(),
        "the port allows {} cases the script denies:\n{}",
        looser.len(),
        looser.join("\n")
    );
}
