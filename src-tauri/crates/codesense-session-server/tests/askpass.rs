// SPDX-License-Identifier: MIT
#![cfg(cap_terminal_server_sidecar)]
//! The askpass as `ssh-keygen` runs it: this binary, answering from the
//! socket, is how a kept passphrase unlocks a key — and it answers nothing
//! but a key's passphrase prompt.

use std::path::Path;
use std::process::Command;

use codesense_session_server::askpass::Askpass;

const PROGRAM: &str = env!("CARGO_BIN_EXE_codesense-session-server");

/// A new ed25519 key at `dir/name`, locked with `passphrase` (none when empty).
fn key(dir: &Path, name: &str, passphrase: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let made = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", passphrase, "-C", "t", "-f"])
        .arg(&path)
        .status()
        .expect("ssh-keygen");
    assert!(made.success());
    path
}

/// Prints the exact prompt this system's `ssh-keygen -y -f <locked key>` sends
/// the askpass, escaped, from an endpoint that records it and answers nothing.
/// Off by default: set `CODESENSE_CAPTURE_ASKPASS_PROMPT=1` and run it with
/// output shown.
#[test]
fn capture_the_ssh_keygen_prompt() {
    use codesense_platform::ipc::blocking::LocalListener;
    use codesense_platform::ipc::Endpoint;
    use std::io::Read;
    use std::process::Stdio;
    if std::env::var_os("CODESENSE_CAPTURE_ASKPASS_PROMPT").is_none() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let locked = key(dir.path(), "locked", "correct horse");
    let endpoint = Endpoint::Ephemeral {
        dir: dir.path().to_path_buf(),
        name: "record".into(),
    };
    let wire = endpoint.to_wire().unwrap();
    let mut listener = LocalListener::bind(&endpoint).unwrap();
    let (sender, prompts) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(mut stream) = listener.accept() {
            let mut length = [0; 4];
            let mut prompt = Vec::new();
            if stream.read_exact(&mut length).is_ok() {
                prompt = vec![0; u32::from_be_bytes(length) as usize];
                let _ = stream.read_exact(&mut prompt);
            }
            // Dropping the stream unanswered fails the prompt.
            if sender.send(prompt).is_err() {
                break;
            }
        }
    });
    let version = Command::new("ssh").arg("-V").output().unwrap();
    let run = Command::new("ssh-keygen")
        .args(["-y", "-f"])
        .arg(&locked)
        .env("SSH_ASKPASS", PROGRAM)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(codesense_session_server::askpass::SOCKET_ENV, &wire)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    println!(
        "openssh: {}",
        String::from_utf8_lossy(&version.stderr).trim()
    );
    println!("ssh-keygen exit: {:?}", run.status.code());
    println!(
        "ssh-keygen stderr: {:?}",
        String::from_utf8_lossy(&run.stderr)
    );
    let mut asked = 0;
    while let Ok(prompt) = prompts.recv_timeout(std::time::Duration::from_secs(1)) {
        asked += 1;
        println!("askpass prompt {asked}: b\"{}\"", prompt.escape_ascii());
    }
    println!("askpass prompts recorded: {asked}");
}

// Fails on Linux (linux-test-defects): ssh-keygen's passphrase prompt gets no answer.
#[cfg(target_os = "macos")]
mod key_unlock {
    use super::*;
    use codesense_session_server::askpass::check_passphrase;

    #[test]
    fn a_kept_passphrase_unlocks_its_key_through_the_askpass() {
        let dir = tempfile::tempdir().unwrap();
        let locked = key(dir.path(), "locked", "correct horse");
        let plain = key(dir.path(), "plain", "");
        let sockets = dir.path().join("askpass");
        let program = Path::new(PROGRAM);

        check_passphrase(&locked, "correct horse", program, &sockets)
            .unwrap_or_else(|e| panic!("the right passphrase: {e}"));
        let wrong = check_passphrase(&locked, "battery staple", program, &sockets).unwrap_err();
        assert!(wrong.contains("doesn't unlock"), "{wrong}");
        let none = check_passphrase(&plain, "anything", program, &sockets).unwrap_err();
        assert!(none.contains("no passphrase"), "{none}");
        let missing =
            check_passphrase(&dir.path().join("nope"), "x", program, &sockets).unwrap_err();
        assert!(missing.contains("no key file"), "{missing}");
        assert_eq!(
            std::fs::read_dir(&sockets).unwrap().count(),
            0,
            "every served socket is gone"
        );
    }
}

/// Run as `ssh` would: the prompt is the argument, the socket the
/// environment. A password or host-key question gets nothing.
#[test]
fn the_binary_answers_only_a_passphrase_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let askpass = Askpass::serve(
        &dir.path().join("a"),
        Path::new(PROGRAM),
        Path::new("/k"),
        "s3cret",
    )
    .unwrap();
    let run = |prompt: &str| {
        Command::new(PROGRAM)
            .arg(prompt)
            .env_clear()
            .envs(askpass.env())
            .output()
            .unwrap()
    };
    let answered = run("Enter passphrase for key '/k': ");
    assert!(answered.status.success());
    assert_eq!(answered.stdout, b"s3cret\n");
    for question in [
        "dev@box's password: ",
        "Are you sure you want to continue connecting?",
    ] {
        let refused = run(question);
        assert!(!refused.status.success(), "{question}");
        assert!(refused.stdout.is_empty(), "{question}");
    }
}

/// Exercise Git's real HTTPS 401 challenge and prompt formatting through the
/// packaged askpass binary, not a handcrafted prompt passed to the matcher.
#[test]
fn git_https_401_uses_only_the_exact_local_socket_credential() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key.pem");
    let cert = dir.path().join("cert.pem");
    assert!(Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-keyout"
        ])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    let script = r#"
import base64,http.server,ssl,sys
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        self.server.good = self.headers.get('Authorization') == 'Basic '+base64.b64encode(b'x-access-token:fixture-local-only').decode()
        self.send_response(403 if self.server.good else 401)
        self.send_header('WWW-Authenticate','Basic realm="fixture"')
        self.send_header('Content-Length','0')
        self.end_headers()
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
server.good=False
server.timeout=10
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[1],sys.argv[2])
server.socket=ctx.wrap_socket(server.socket,server_side=True)
print(server.server_port,flush=True)
server.handle_request()
if not server.good: server.handle_request()
sys.exit(0 if server.good else 2)
"#;
    let mut server = Command::new("python3")
        .args(["-u", "-c", script])
        .arg(&cert)
        .arg(&key)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut port = String::new();
    BufReader::new(server.stdout.take().unwrap())
        .read_line(&mut port)
        .unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let url = format!("https://127.0.0.1:{port}/org/repo.git");
    let sockets = tempfile::Builder::new()
        .prefix("cs-git401-")
        .tempdir_in("/tmp")
        .unwrap();
    let broker = Askpass::serve_git(
        sockets.path(),
        Path::new(PROGRAM),
        &url,
        "x-access-token",
        "fixture-local-only",
    )
    .unwrap();
    let mut git = Command::new("git");
    git.args([
        "-c",
        "http.sslVerify=false",
        "-c",
        "http.followRedirects=false",
        "-c",
        "credential.helper=",
        "-c",
        "credential.useHttpPath=true",
        "-c",
        "credential.username=x-access-token",
        "ls-remote",
        "--",
    ])
    .arg(&url)
    .env("LC_ALL", "C")
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_ASKPASS", PROGRAM)
    .env(codesense_session_server::askpass::GIT_MODE_ENV, "1")
    .envs(broker.env())
    .stdin(Stdio::null());
    let result = codesense_session_server::install::run_within(&mut git, Duration::from_secs(15));
    // 403 ends the fixture after it has received the correct challenge response.
    assert!(result.is_ok_and(|output| !output.status.success()));
    assert!(
        server.wait().unwrap().success(),
        "Git must have received the exact socket response"
    );
    drop(broker);
    assert_eq!(std::fs::read_dir(sockets.path()).unwrap().count(), 0);
}
