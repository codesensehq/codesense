// SPDX-License-Identifier: MIT
//! Answering `ssh`'s key-passphrase prompt without the passphrase ever
//! reaching an argument list, an environment or a file.
//!
//! `ssh` asks an `SSH_ASKPASS` program for a passphrase. That program is this
//! binary: with [`SOCKET_ENV`] set it is the askpass client, which hands the
//! prompt to a local endpoint the process running `ssh` serves for the length
//! of one operation ([`Askpass::serve`]) and prints the answer. On unix the
//! endpoint is a socket, mode 0600, in an owner-only directory; on Windows a
//! named pipe only the current user may open. Either way only this user's
//! processes can connect, and the endpoint vanishes when the operation ends.
//! The environment names the endpoint (its wire form), never the secret.
//!
//! A prompt goes over as a 4-byte big-endian length and then its bytes, at
//! most `MAX_PROMPT`; the answer is the secret, then the end of the stream.
//! A named pipe cannot be half-closed, so the length, not the end of the
//! stream, tells the server the prompt is whole.
//!
//! The server answers only a prompt for **its own key's** passphrase — the
//! prompt must name that key file. A password, a PIN, a host-key question, or
//! a jump host asking about anything else gets nothing. The one exception is
//! [`check_passphrase`]: there the only asker is the `ssh-keygen -f <key>` it
//! starts, so `ssh-keygen`'s bare "Enter passphrase: " (Linux names no file)
//! is that key's prompt too.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use codesense_platform::ipc::blocking::{LocalListener, LocalStream};
use codesense_platform::ipc::Endpoint;

/// The environment variable holding the wire form of the endpoint an askpass
/// client asks. Set, it turns this binary into the askpass client.
pub const SOCKET_ENV: &str = "CODESENSE_ASKPASS_SOCK";
pub const GIT_MODE_ENV: &str = "CODESENSE_ASKPASS_GIT";

/// How long either side waits on the endpoint (a second in unit tests).
const SOCKET_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};

/// The longest prompt the server reads.
const MAX_PROMPT: usize = 4096;

/// Which prompts a served secret answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Asks {
    /// Git's password prompt for one credential, byte for byte.
    GitExact,
    /// `ssh`'s or `ssh-keygen`'s prompt naming the key ([`asks_for_key`]).
    SignInKey,
    /// The named prompts for the key, or exactly [`BARE_PROMPT`]. Only
    /// [`check_passphrase`] serves it: the process asking is the
    /// `ssh-keygen -f <key>` it started, and the endpoint lives only for that
    /// call.
    CheckKey,
}

/// `ssh-keygen`'s prompt when it names no file, as Linux's OpenSSH asks it.
const BARE_PROMPT: &[u8] = b"Enter passphrase: ";

impl Asks {
    /// Whether `prompt` is a question this secret answers; `expected` is the
    /// key file, or Git's whole prompt.
    fn admits(self, prompt: &[u8], expected: &[u8]) -> bool {
        match self {
            Self::GitExact => prompt == expected,
            Self::SignInKey => asks_for_key(prompt, expected),
            Self::CheckKey => prompt == BARE_PROMPT || asks_for_key(prompt, expected),
        }
    }
}

/// A secret whose `Debug` never shows it.
struct Hidden(Vec<u8>);

impl std::fmt::Debug for Hidden {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl Drop for Hidden {
    fn drop(&mut self) {
        self.0.iter_mut().for_each(|byte| *byte = 0);
    }
}

/// A key's passphrase served to the askpass clients of one operation.
/// Dropping it stops serving and removes the endpoint.
#[derive(Debug)]
pub struct Askpass {
    program: PathBuf,
    endpoint: Endpoint,
    /// The endpoint's wire form, for [`SOCKET_ENV`].
    wire: OsString,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Askpass {
    /// Serve `secret`, the passphrase of the key file `key`, on a fresh
    /// endpoint under `parent` (made owner-only), to be asked for by
    /// `program`: this binary.
    pub fn serve(parent: &Path, program: &Path, key: &Path, secret: &str) -> std::io::Result<Self> {
        Self::serve_key(parent, program, key, secret, Asks::SignInKey)
    }

    fn serve_key(
        parent: &Path,
        program: &Path,
        key: &Path,
        secret: &str,
        asks: Asks,
    ) -> std::io::Result<Self> {
        Self::serve_prompt(
            parent,
            program,
            key.as_os_str().as_encoded_bytes().to_vec(),
            secret,
            asks,
        )
    }

    /// Serve only Git's password prompt for this exact credential-free HTTPS URL.
    /// The caller fixes credential.username and credential.useHttpPath; redirects
    /// asking for another origin/path receive no secret.
    pub fn serve_git(
        parent: &Path,
        program: &Path,
        url: &str,
        username: &str,
        secret: &str,
    ) -> std::io::Result<Self> {
        let remote = url
            .strip_prefix("https://")
            .filter(|value| !value.contains(['@', '\n', '\r', '\0', '\'']))
            .ok_or_else(|| std::io::Error::other("invalid Git origin"))?;
        if username.is_empty()
            || !username
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
        {
            return Err(std::io::Error::other("invalid Git username"));
        }
        let prompt = format!("Password for 'https://{username}@{remote}': ");
        Self::serve_prompt(parent, program, prompt.into_bytes(), secret, Asks::GitExact)
    }

    fn serve_prompt(
        parent: &Path,
        program: &Path,
        key: Vec<u8>,
        secret: &str,
        asks: Asks,
    ) -> std::io::Result<Self> {
        codesense_platform::fs::create_dir_owner_only(parent)?;
        codesense_platform::fs::set_owner_only(parent)?;
        // A name no other operation uses: on Windows it is the whole pipe
        // name, since a pipe has no directory.
        let endpoint = Endpoint::Ephemeral {
            dir: parent.to_path_buf(),
            name: nonce(),
        };
        let wire = endpoint.to_wire()?;
        let mut listener = LocalListener::bind(&endpoint)?;
        let stop = Arc::new(AtomicBool::new(false));
        let secret = Arc::new(Hidden(secret.as_bytes().to_vec()));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || loop {
                let stream = listener.accept();
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(stream) = stream {
                    let key = key.clone();
                    let secret = secret.clone();
                    // A local process can connect and never finish its
                    // prompt. Serve clients independently so it cannot
                    // starve ssh's real askpass request.
                    let stopped = stop.clone();
                    std::thread::spawn(move || answer_one(stream, &key, &secret, asks, &stopped));
                }
            })
        };
        Ok(Self {
            program: program.to_path_buf(),
            endpoint,
            wire,
            stop,
            thread: Some(thread),
        })
    }

    /// The environment that makes `ssh` ask this server: the askpass program,
    /// forced even without a display, and the endpoint. Never the secret.
    pub fn env(&self) -> Vec<(String, OsString)> {
        vec![
            ("SSH_ASKPASS".into(), self.program.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (SOCKET_ENV.into(), self.wire.clone()),
        ]
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop so it sees the stop and drops the listener,
        // which removes the endpoint; if nothing can wake it, leave it parked
        // rather than hang here.
        let woken = LocalStream::connect(&self.endpoint).is_ok();
        if let Some(thread) = self.thread.take() {
            if woken {
                let _ = thread.join();
            }
        }
        if !woken {
            // The parked listener keeps its socket file on unix: remove it
            // anyway. A Windows pipe has no file, and this does nothing there.
            if let Ok(path) = self.endpoint.address() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Serve one client: read its prompt, and answer it only when `asks` admits
/// it for `key`. A client that stalls past `SOCKET_TIMEOUT`, or
/// sends a prompt longer than `MAX_PROMPT`, gets nothing.
fn answer_one(
    mut stream: LocalStream,
    key: &[u8],
    secret: &Hidden,
    asks: Asks,
    stopped: &AtomicBool,
) {
    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
    // Bytes, not text: `ssh` may cut a non-ASCII path mid-character.
    let Some(prompt) = read_prompt(&mut stream) else {
        return;
    };
    if asks.admits(&prompt, key) && !stopped.load(Ordering::SeqCst) {
        let _ = stream.write_all(&secret.0);
    }
}

/// A prompt as the client frames it: its length, then its bytes. `None` when
/// it is longer than `MAX_PROMPT` or does not arrive whole.
fn read_prompt(stream: &mut impl Read) -> Option<Vec<u8>> {
    let mut length = [0; 4];
    stream.read_exact(&mut length).ok()?;
    let length = usize::try_from(u32::from_be_bytes(length)).ok()?;
    if length > MAX_PROMPT {
        return None;
    }
    let mut prompt = vec![0; length];
    stream.read_exact(&mut prompt).ok()?;
    Some(prompt)
}

/// `prompt` framed for the server: its length, then its bytes.
fn framed(prompt: &[u8]) -> Result<Vec<u8>, String> {
    let length = u32::try_from(prompt.len()).map_err(|_| "the prompt is too long".to_string())?;
    let mut framed = length.to_be_bytes().to_vec();
    framed.extend_from_slice(prompt);
    Ok(framed)
}

/// Whether `prompt` is `ssh`'s or `ssh-keygen`'s own question for the
/// passphrase of `key` — never a server's keyboard-interactive text, which
/// `ssh` shows prefixed with `(user@host)`. `ssh` quotes at most the first 100
/// bytes of the path. Linux's `ssh-keygen` names no file (`BARE_PROMPT`),
/// which only the check path admits.
pub fn asks_for_key(prompt: &[u8], key: &[u8]) -> bool {
    let named = prompt
        .strip_prefix(b"Enter passphrase for key '".as_slice())
        .and_then(|rest| rest.strip_suffix(b"': ".as_slice()))
        .or_else(|| {
            prompt
                .strip_prefix(b"Enter passphrase for \"".as_slice())
                .and_then(|rest| rest.strip_suffix(b"\": ".as_slice()))
        });
    match named {
        Some(path) => {
            path == key || (key.len() > 100 && path.len() == 100 && key.starts_with(path))
        }
        // A bare prompt cannot be tied to the configured key and could be a
        // different key or remote keyboard-interactive question.
        None => false,
    }
}

/// Whether `prompt` asks for a key's passphrase — the only question the
/// client passes on.
pub fn is_passphrase_prompt(prompt: &str) -> bool {
    prompt.to_ascii_lowercase().contains("passphrase")
}

/// The askpass client: pass `prompt` to the server on `endpoint` and write
/// its answer to `out`, followed by a newline.
pub fn answer(prompt: &[u8], endpoint: &Endpoint, out: &mut impl Write) -> Result<(), String> {
    let text = String::from_utf8_lossy(prompt);
    if !is_passphrase_prompt(&text) {
        return Err(format!("not a key passphrase prompt: {text:?}"));
    }
    answer_prompt(prompt, endpoint, out)
}
fn answer_prompt(prompt: &[u8], endpoint: &Endpoint, out: &mut impl Write) -> Result<(), String> {
    let mut stream =
        LocalStream::connect(endpoint).map_err(|e| format!("connect {endpoint:?}: {e}"))?;
    // macOS refuses a timeout (EINVAL) on a socket the server already closed;
    // the read then returns at once anyway.
    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));
    stream
        .write_all(&framed(prompt)?)
        .map_err(|e| format!("ask {endpoint:?}: {e}"))?;
    let mut secret = Hidden(Vec::new());
    stream
        .read_to_end(&mut secret.0)
        .map_err(|e| format!("read {endpoint:?}: {e}"))?;
    if secret.0.is_empty() {
        return Err("no passphrase for this prompt".into());
    }
    out.write_all(&secret.0)
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush())
        .map_err(|e| format!("answer: {e}"))
}

fn answer_with_mode(
    prompt: &[u8],
    endpoint: &Endpoint,
    out: &mut impl Write,
    git: bool,
) -> Result<(), String> {
    if git && prompt.starts_with(b"Password for 'https://") {
        answer_prompt(prompt, endpoint, out)
    } else {
        answer(prompt, endpoint, out)
    }
}

/// The askpass client as a process: `args` are its arguments (the prompt
/// first), `endpoint` the server [`SOCKET_ENV`] names. Returns the exit code.
pub fn run_client(args: &[OsString], endpoint: &Endpoint) -> i32 {
    let prompt = args
        .first()
        .map(|a| a.as_encoded_bytes())
        .unwrap_or_default();
    let git = std::env::var_os(GIT_MODE_ENV).is_some_and(|value| value == "1");
    let mut stdout = std::io::stdout().lock();
    let result = answer_with_mode(prompt, endpoint, &mut stdout, git);
    match result {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("codesense-session-server askpass: {err}");
            1
        }
    }
}

/// Whether `passphrase` unlocks the private key at `key`, asked through the
/// askpass (`program`, serving from an endpoint under `dir`) as sign-in asks
/// it, except that `ssh-keygen`'s bare prompt is answered too
/// (`Asks::CheckKey`). A key that needs no passphrase is refused: there is
/// nothing to keep.
pub fn check_passphrase(
    key: &Path,
    passphrase: &str,
    program: &Path,
    dir: &Path,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    if !key.is_file() {
        return Err(format!("There is no key file at {}", key.display()));
    }
    let unlocked = |envs: Vec<(String, OsString)>, args: &[&str]| {
        let mut command = Command::new("ssh-keygen");
        command.args(args).arg(key).envs(envs).stdin(Stdio::null());
        crate::install::run_within(&mut command, Duration::from_secs(15))
            .map(|o| {
                (
                    o.status.success(),
                    String::from_utf8_lossy(&o.stderr).trim().to_string(),
                )
            })
            .map_err(|e| format!("run ssh-keygen: {e}"))
    };
    if unlocked(Vec::new(), &["-y", "-P", "", "-f"])?.0 {
        return Err(format!(
            "{} has no passphrase. Choose \"Key file\" instead.",
            key.display()
        ));
    }
    let askpass = Askpass::serve_key(dir, program, key, passphrase, Asks::CheckKey)
        .map_err(|e| format!("serve the passphrase: {e}"))?;
    match unlocked(askpass.env(), &["-y", "-f"])? {
        (true, _) => Ok(()),
        (false, said) => Err(format!(
            "That passphrase doesn't unlock {} ({said})",
            key.display()
        )),
    }
}

/// A name no other served endpoint has.
fn nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{:x}-{nanos:x}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_socket_answers_only_exact_origin_in_explicit_client_mode() {
        let temp = tempfile::tempdir().unwrap();
        let server = Askpass::serve_git(
            temp.path(),
            Path::new("/unused"),
            "https://github.com/owner/repo",
            "x-access-token",
            "local-only-token",
        )
        .unwrap();
        let prompt = b"Password for 'https://x-access-token@github.com/owner/repo': ";
        let mut out = Vec::new();
        assert!(answer_with_mode(prompt, &server.endpoint, &mut out, false).is_err());
        answer_with_mode(prompt, &server.endpoint, &mut out, true).unwrap();
        assert_eq!(out, b"local-only-token\n");
        assert!(answer_with_mode(
            b"Password for 'https://x-access-token@other.example/owner/repo': ",
            &server.endpoint,
            &mut Vec::new(),
            true
        )
        .is_err());
        assert!(answer_with_mode(
            b"Password for 'https://x-access-token@github.com/other/repo': ",
            &server.endpoint,
            &mut Vec::new(),
            true
        )
        .is_err());
    }
    /// A connected client and the server's end of it, on an endpoint of the
    /// test's own under `dir`.
    fn pair(dir: &Path) -> (LocalStream, LocalStream) {
        let endpoint = Endpoint::Ephemeral {
            dir: dir.to_path_buf(),
            name: nonce(),
        };
        let mut listener = LocalListener::bind(&endpoint).unwrap();
        let client = LocalStream::connect(&endpoint).unwrap();
        (client, listener.accept().unwrap())
    }

    #[test]
    fn stopped_git_broker_never_answers_pending_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let (mut client, server) = pair(dir.path());
        let stopped = AtomicBool::new(true);
        let secret = Hidden(b"never-send".to_vec());
        client.write_all(&framed(b"expected").unwrap()).unwrap();
        answer_one(server, b"expected", &secret, Asks::GitExact, &stopped);
        let mut out = Vec::new();
        client.read_to_end(&mut out).unwrap();
        assert!(out.is_empty());
    }

    /// The client finds the server from the environment alone: the endpoint's
    /// wire form in `SOCKET_ENV`.
    #[test]
    fn the_socket_env_names_the_endpoint_by_its_wire_form() {
        let parent = tempfile::tempdir().unwrap();
        let askpass = Askpass::serve(
            parent.path(),
            Path::new("/bin/false"),
            Path::new("/k"),
            "s3cret",
        )
        .unwrap();
        let (_, wire) = askpass
            .env()
            .into_iter()
            .find(|(name, _)| name == SOCKET_ENV)
            .unwrap();
        assert_eq!(wire, askpass.endpoint.to_wire().unwrap());
        let endpoint = Endpoint::from_wire(&wire).unwrap();
        assert_eq!(endpoint.to_wire().unwrap(), wire);
        let mut out = Vec::new();
        answer(b"Enter passphrase for key '/k': ", &endpoint, &mut out).unwrap();
        assert_eq!(out, b"s3cret\n");
    }

    /// A client that connects and sends nothing is dropped after the
    /// timeout, gets nothing, and holds up nobody else meanwhile.
    #[test]
    fn a_stalled_client_is_dropped_after_the_timeout_and_gets_nothing() {
        let parent = tempfile::tempdir().unwrap();
        let askpass = Askpass::serve(
            parent.path(),
            Path::new("/bin/false"),
            Path::new("/k"),
            "s3cret",
        )
        .unwrap();
        let mut stalled = LocalStream::connect(&askpass.endpoint).unwrap();
        let mut out = Vec::new();
        answer(
            b"Enter passphrase for key '/k': ",
            &askpass.endpoint,
            &mut out,
        )
        .unwrap();
        assert_eq!(out, b"s3cret\n", "a stalled client starves no one");

        stalled.set_read_timeout(Some(SOCKET_TIMEOUT * 5)).unwrap();
        let started = std::time::Instant::now();
        let mut heard = Vec::new();
        stalled.read_to_end(&mut heard).unwrap();
        assert!(heard.is_empty(), "a stalled client never gets the secret");
        assert!(
            started.elapsed() < SOCKET_TIMEOUT * 4,
            "dropped at the server's timeout"
        );
    }

    /// A prompt longer than `MAX_PROMPT` is refused unread, even one that
    /// names the key.
    #[test]
    fn a_prompt_over_the_limit_is_refused() {
        let parent = tempfile::tempdir().unwrap();
        let key = format!("/{}", "k".repeat(MAX_PROMPT));
        let askpass = Askpass::serve(
            parent.path(),
            Path::new("/bin/false"),
            Path::new(&key),
            "s3cret",
        )
        .unwrap();
        let prompt = format!("Enter passphrase for key '{key}': ");
        assert!(prompt.len() > MAX_PROMPT);
        let mut out = Vec::new();
        assert!(answer(prompt.as_bytes(), &askpass.endpoint, &mut out).is_err());
        assert!(out.is_empty());

        let fits = vec![b'x'; MAX_PROMPT];
        assert_eq!(
            read_prompt(&mut framed(&fits).unwrap().as_slice()),
            Some(fits)
        );
        let over = vec![b'x'; MAX_PROMPT + 1];
        assert_eq!(read_prompt(&mut framed(&over).unwrap().as_slice()), None);
    }

    #[test]
    fn only_a_passphrase_prompt_is_answered() {
        assert!(is_passphrase_prompt("Enter passphrase for key '/k': "));
        assert!(is_passphrase_prompt("Enter passphrase: "));
        assert!(!is_passphrase_prompt("dev@box's password: "));
        assert!(!is_passphrase_prompt("Enter PIN for ED25519-SK key /k: "));
        assert!(!is_passphrase_prompt(
            "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        ));
    }

    #[test]
    fn only_the_tools_own_prompt_for_the_key_is_answered() {
        let asks = |prompt: &str, key: &str| asks_for_key(prompt.as_bytes(), key.as_bytes());
        let key = "/k/id";
        assert!(asks("Enter passphrase for key '/k/id': ", key));
        assert!(asks("Enter passphrase for \"/k/id\": ", key));
        assert!(!asks("Enter passphrase: ", key));
        assert!(!asks("(u@jump) Enter passphrase for key '/k/id': ", key));
        assert!(!asks("Enter passphrase for key '/k/other': ", key));
        let long = format!("/{}", "d/".repeat(60));
        let shown = format!("Enter passphrase for key '{}': ", &long[..100]);
        assert!(asks(&shown, &long), "ssh cuts the path at 100 bytes");
        assert!(!asks(
            &format!("Enter passphrase for key '{}': ", &long[..99]),
            &long
        ));
        // A cut through a multi-byte character is still the key's prompt.
        let accented = format!("/{}é/id", "a".repeat(98));
        let mut cut = b"Enter passphrase for key '".to_vec();
        cut.extend_from_slice(&accented.as_bytes()[..100]);
        cut.extend_from_slice(b"': ");
        assert!(asks_for_key(&cut, accented.as_bytes()));
    }

    /// The check path admits `ssh-keygen`'s bare prompt, byte for byte; sign-in
    /// never does.
    #[test]
    fn only_the_check_path_admits_the_bare_prompt_exactly() {
        let key = b"/k/id".as_slice();
        assert!(Asks::CheckKey.admits(b"Enter passphrase: ", key));
        assert!(!Asks::SignInKey.admits(b"Enter passphrase: ", key));
        assert!(!Asks::GitExact.admits(b"Enter passphrase: ", key));
        for near in [
            "(u@h) Enter passphrase: ",
            "Enter passphrase: x",
            "Enter passphrase:  ",
            "Enter passphrase: \n",
            "Enter passphrase:",
            "enter passphrase: ",
            " Enter passphrase: ",
            "Enter passphrase (empty for no passphrase): ",
        ] {
            assert!(!Asks::CheckKey.admits(near.as_bytes(), key), "{near:?}");
            assert!(!Asks::SignInKey.admits(near.as_bytes(), key), "{near:?}");
        }
    }

    /// Both key modes answer this key's named prompts and refuse the rest.
    #[test]
    fn both_key_modes_admit_only_this_keys_named_prompts() {
        let key = b"/k/id".as_slice();
        for asks in [Asks::SignInKey, Asks::CheckKey] {
            for named in [
                "Enter passphrase for key '/k/id': ",
                "Enter passphrase for \"/k/id\": ",
            ] {
                assert!(asks.admits(named.as_bytes(), key), "{asks:?} {named}");
            }
            for other in [
                "Enter passphrase for key '/k/other': ",
                "Enter passphrase for \"/k/other\": ",
                "(dev@box) Enter passphrase for key '/k/id': ",
                "(dev@box) Enter passphrase: ",
                "(dev@box) Password: ",
                "dev@box's password: ",
                "Enter PIN for ED25519-SK key /k/id: ",
            ] {
                assert!(!asks.admits(other.as_bytes(), key), "{asks:?} {other}");
            }
        }
    }

    /// Sign-in's server, through the real client, gives a bare prompt nothing;
    /// the check path's server answers it.
    #[test]
    fn a_bare_prompt_gets_nothing_from_sign_in_and_its_answer_from_a_check() {
        let parent = tempfile::tempdir().unwrap();
        let key = Path::new("/k");
        let sign_in =
            Askpass::serve(parent.path(), Path::new("/bin/false"), key, "s3cret").unwrap();
        let mut out = Vec::new();
        assert!(answer(b"Enter passphrase: ", &sign_in.endpoint, &mut out).is_err());
        assert!(out.is_empty(), "sign-in never answers a bare prompt");

        let check = Askpass::serve_key(
            parent.path(),
            Path::new("/bin/false"),
            key,
            "s3cret",
            Asks::CheckKey,
        )
        .unwrap();
        answer(b"Enter passphrase: ", &check.endpoint, &mut out).unwrap();
        assert_eq!(out, b"s3cret\n");
    }

    // Unix only: it reads the socket file's and its directory's mode bits.
    #[cfg(unix)]
    #[test]
    fn a_served_secret_answers_only_its_own_keys_prompt_and_is_gone_after() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        // A parent others may enter: serving makes it owner-only.
        let parent = temp.path().join("askpass");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let key = Path::new("/keys/id_work");
        let askpass = Askpass::serve(&parent, Path::new("/bin/false"), key, "s3cret").unwrap();
        let env = askpass.env();
        assert!(env
            .iter()
            .all(|(_, value)| !value.to_string_lossy().contains("s3cret")));
        let endpoint = Endpoint::from_wire(&env[2].1).unwrap();
        let socket = endpoint.address().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(socket.parent().unwrap()), 0o700);
        assert_eq!(mode(&socket), 0o600);

        for _ in 0..6 {
            let mut out = Vec::new();
            answer(
                b"Enter passphrase for key '/keys/id_work': ",
                &endpoint,
                &mut out,
            )
            .unwrap();
            assert_eq!(out, b"s3cret\n", "every prompt for the key is answered");
        }
        for other in [
            "Enter passphrase for key '/keys/id_other': ",
            "(dev@jump) passphrase: ",
            "(dev@jump) Enter passphrase for key '/keys/id_work': ",
            "Enter passphrase for key '/keys/id_work': and more",
            "dev@box's password: ",
        ] {
            let mut refused = Vec::new();
            assert!(
                answer(other.as_bytes(), &endpoint, &mut refused).is_err(),
                "{other}"
            );
            assert!(refused.is_empty(), "{other} gets nothing");
        }

        drop(askpass);
        assert!(!socket.exists(), "the socket is gone with the operation");
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
    }
}
