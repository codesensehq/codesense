// SPDX-License-Identifier: MIT
//! Claude's status hook: posts a lifecycle event to the running CodeSense app, so terminal
//! status dots and the agent list stay live. A port of the bash status script earlier releases
//! installed, step for step, over a plain `TcpStream`.
//!
//! When the app isn't running (no port to reach) it says so in one line on stderr. When a
//! CodeSense tab's post fails (no port, a connect error, non-200, or a post the app dropped as
//! an unknown session) it appends one timestamped line to `~/.codesense/logs/notify-hook.log`;
//! a hook running outside a CodeSense tab is expected and is not logged. It never fails the
//! lifecycle event.

use std::fs;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long one post may take, connect to last byte (curl's `--max-time 3`).
const TIMEOUT: Duration = Duration::from_secs(3);
/// The log rotates to `.1` once it is past this size.
const LOG_CAP: u64 = 512 * 1024;
/// The most of a response the hook reads; it needs the status and the body's start.
const RESPONSE_CAP: usize = 64 * 1024;

/// What the hook reads from its environment, so tests can inject it.
#[derive(Debug, Clone, Default)]
pub struct HookEnv {
    /// `CODESENSE_API_PORT`: the app instance that spawned the tab.
    pub api_port: Option<String>,
    /// `CODESENSE_STATUS_URL`: the full status endpoint, when injected.
    pub status_url: Option<String>,
    /// `CODESENSE_TAB_SESSION_ID`: set only in a CodeSense terminal tab.
    pub tab_session: Option<String>,
    /// `~/.codesense`, holding `http.port` and `logs/`.
    pub codesense_home: Option<PathBuf>,
}

impl HookEnv {
    /// This process's environment. An empty variable counts as unset, as in the script.
    pub fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Self {
            api_port: var("CODESENSE_API_PORT"),
            status_url: var("CODESENSE_STATUS_URL"),
            tab_session: var("CODESENSE_TAB_SESSION_ID"),
            codesense_home: codesense_platform::dirs::codesense_home(),
        }
    }

    /// The running app's port as it wrote it at its last start.
    pub(super) fn port_file(&self) -> Option<String> {
        let home = self.codesense_home.as_ref()?;
        let port = fs::read_to_string(home.join("http.port")).ok()?;
        Some(port.trim().to_string()).filter(|p| !p.is_empty())
    }
}

/// What the hook did. It exits 0 whatever it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// No port and no status URL: the app isn't running.
    NotRunning,
    /// Not a CodeSense terminal tab.
    NotATab,
    /// The app took the event.
    Posted,
    /// The post failed and was logged.
    Failed,
}

/// Why a post got no answer: the field curl's exit code held in the script's log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PostError {
    Connect,
    Timeout,
    Io,
    UnsupportedUrl,
}

impl PostError {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Timeout => "timeout",
            Self::Io => "io",
            Self::UnsupportedUrl => "unsupported-url",
        }
    }
}

pub(super) struct Response {
    pub(super) code: u16,
    pub(super) body: Vec<u8>,
}

/// Post one hook event (`input`, Claude's hook JSON, sent unchanged) as the script does.
pub fn notify(input: &[u8], env: &HookEnv) -> Outcome {
    // Prefer the per-instance port (set by the PTY); fall back to the port file.
    let port = env.api_port.clone().or_else(|| env.port_file());
    if port.is_none() && env.status_url.is_none() {
        eprintln!("codesense not running — skipping (start the app to re-enable)");
        // Only a CodeSense tab expects a post; elsewhere this is the normal case.
        if env.tab_session.is_some() {
            log_fail(
                env,
                "no-port: CODESENSE_API_PORT unset and no ~/.codesense/http.port",
            );
        }
        return Outcome::NotRunning;
    }
    let Some(session) = env.tab_session.as_deref() else {
        return Outcome::NotATab;
    };

    let mut url = env
        .status_url
        .clone()
        .unwrap_or_else(|| local_url(port.as_deref().unwrap_or_default(), STATUS_PATH));
    let mut result = post(&url, session, input);
    // The session outlived the app that spawned it (an app restart or update keeps the
    // terminal sessions): its port is that old instance's. The running app rewrites the port
    // file at every start, so retry there once.
    if matches!(result, Err(PostError::Connect)) && env.status_url.is_none() {
        if let Some(current) = env.port_file().filter(|c| Some(c) != port.as_ref()) {
            url = local_url(&current, STATUS_PATH);
            result = post(&url, session, input);
        }
    }

    let (error, code, body) = match &result {
        Ok(response) => ("none", Some(response.code), response.body.as_slice()),
        Err(e) => (e.as_str(), None, &[][..]),
    };
    let body = String::from_utf8_lossy(body);
    if result.is_ok() && code == Some(200) && !body.contains("\"unknown-session\"") {
        return Outcome::Posted;
    }
    let event = serde_json::from_slice::<serde_json::Value>(input)
        .ok()
        .and_then(|v| v["hook_event_name"].as_str().map(str::to_string))
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "?".to_string());
    let code = code.map_or_else(|| "none".to_string(), |c| c.to_string());
    let body: String = body.chars().take(200).collect();
    let (event, session, url, body) = (
        one_line(&event),
        one_line(session),
        one_line(&url),
        one_line(&body),
    );
    log_fail(
        env,
        &format!(
            "post-failed: event={event} session={session} url={url} error={error} http={code} body={body}"
        ),
    );
    Outcome::Failed
}

/// `text` with each control character as a space, so a failure is one log line whatever the
/// event, session, URL or body holds.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// The status route's path; the app's other hook routes sit beside it.
pub(super) const STATUS_PATH: &str = "/api/v1/terminal/status";

/// The app's route at `path` on this host's `port`.
pub(super) fn local_url(port: &str, path: &str) -> String {
    format!("http://127.0.0.1:{port}{path}")
}

/// `http://host:port/path` as `(host:port, addresses, port, path)`; any other form is
/// unsupported. The host is an IP address or `localhost`: a name to look up could take longer
/// than the whole post may.
fn parse_url(url: &str) -> Option<(&str, Vec<IpAddr>, u16, &str)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, "/"),
    };
    let (host, port) = authority.rsplit_once(':')?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let valid =
        |s: &str| !s.is_empty() && !s.contains(|c: char| c.is_whitespace() || c.is_control());
    if !valid(host) || !valid(path) || authority.contains('@') {
        return None;
    }
    let addrs = if host.eq_ignore_ascii_case("localhost") {
        vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()]
    } else {
        vec![host.parse().ok()?]
    };
    Some((authority, addrs, port.parse().ok()?, path))
}

/// POST `body` to `url` within [`TIMEOUT`] and read the whole answer.
pub(super) fn post(url: &str, session: &str, body: &[u8]) -> Result<Response, PostError> {
    let (authority, addrs, port, path) = parse_url(url).ok_or(PostError::UnsupportedUrl)?;
    let deadline = Instant::now() + TIMEOUT;
    let left = || {
        let left = deadline.saturating_duration_since(Instant::now());
        (!left.is_zero()).then_some(left).ok_or(PostError::Timeout)
    };
    let mut failure = PostError::Connect;
    let mut stream = None;
    for ip in addrs {
        match TcpStream::connect_timeout(&SocketAddr::new(ip, port), left()?) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) if is_timeout(&e) => failure = PostError::Timeout,
            Err(_) => {}
        }
    }
    let mut stream = stream.ok_or(failure)?;
    let failed = |e: io::Error| {
        if is_timeout(&e) {
            PostError::Timeout
        } else {
            PostError::Io
        }
    };

    // A header value never carries a line break into the request.
    let session: String = session.chars().filter(|c| !c.is_control()).collect();
    let mut request = format!(
        "POST {path} HTTP/1.0\r\nHost: {authority}\r\nContent-Type: application/json\r\nX-Codesense-Tab-Session-Id: {session}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(body);
    stream.set_write_timeout(Some(left()?)).map_err(failed)?;
    stream.write_all(&request).map_err(failed)?;

    let mut response = Vec::new();
    let mut chunk = [0u8; 8192];
    while response.len() < RESPONSE_CAP {
        stream.set_read_timeout(Some(left()?)).map_err(failed)?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(failed(e)),
        }
    }
    parse_response(&response).ok_or(PostError::Io)
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

/// The status code and body of an HTTP/1.x response read to its end.
fn parse_response(raw: &[u8]) -> Option<Response> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..end]).ok()?;
    let status = head.lines().next()?;
    let mut parts = status.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    let code = parts.next()?.parse().ok()?;
    Some(Response {
        code,
        body: raw[end + 4..].to_vec(),
    })
}

/// Append one timestamped line to the hook's log, best-effort.
fn log_fail(env: &HookEnv, message: &str) {
    let Some(home) = env.codesense_home.as_ref() else {
        return;
    };
    let dir = home.join("logs");
    let log = dir.join("notify-hook.log");
    let _ = (|| -> io::Result<()> {
        fs::create_dir_all(&dir)?;
        // Cap the log so a hook firing outside CodeSense can't grow it without bound.
        if fs::metadata(&log).is_ok_and(|m| m.is_file() && m.len() > LOG_CAP) {
            // A failed rotation still logs the line.
            let _ = fs::rename(&log, dir.join("notify-hook.log.1"));
        }
        let line = format!("{} {message}\n", utc_time(SystemTime::now()));
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)?
            .write_all(line.as_bytes())
    })();
}

/// `time` as `%Y-%m-%dT%H:%M:%SZ` in UTC (`date -u` in the script).
fn utc_time(time: SystemTime) -> String {
    let secs = time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The proleptic Gregorian date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::tests::{closed_port, listener, TempDir};

    /// The hook's log under a test's `~/.codesense`.
    fn log(home: &TempDir) -> String {
        fs::read_to_string(home.0.join("logs/notify-hook.log")).unwrap_or_default()
    }

    const EVENT: &[u8] = br#"{"hook_event_name":"Stop","session_id":"abc"}"#;

    fn env(home: &TempDir, port: Option<u16>) -> HookEnv {
        HookEnv {
            api_port: port.map(|p| p.to_string()),
            status_url: None,
            tab_session: Some("tab-1".to_string()),
            codesense_home: Some(home.0.clone()),
        }
    }

    #[test]
    fn no_port_skips_and_logs_only_in_a_tab() {
        let home = TempDir::new();
        let mut env = env(&home, None);
        env.tab_session = None;
        assert_eq!(notify(EVENT, &env), Outcome::NotRunning);
        assert_eq!(log(&home), "", "outside a tab it is the normal case");
        env.tab_session = Some("tab-1".to_string());
        assert_eq!(notify(EVENT, &env), Outcome::NotRunning);
        let log = log(&home);
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(log.ends_with(" no-port: CODESENSE_API_PORT unset and no ~/.codesense/http.port\n"));
    }

    #[test]
    fn outside_a_tab_nothing_is_posted() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", "{}");
        let mut env = env(&home, Some(port));
        env.tab_session = None;
        assert_eq!(notify(EVENT, &env), Outcome::NotATab);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        assert_eq!(log(&home), "");
    }

    #[test]
    fn an_event_is_posted_unchanged_with_the_tab_session() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", "{\"ok\":true}");
        assert_eq!(notify(EVENT, &env(&home, Some(port))), Outcome::Posted);
        let request = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request
            .head
            .starts_with("POST /api/v1/terminal/status HTTP/1."));
        assert!(request
            .head
            .contains(&format!("\r\nHost: 127.0.0.1:{port}\r\n")));
        assert!(request
            .head
            .contains("\r\nContent-Type: application/json\r\n"));
        assert!(request
            .head
            .contains("\r\nX-Codesense-Tab-Session-Id: tab-1\r\n"));
        assert_eq!(request.body, EVENT);
        assert_eq!(log(&home), "");
    }

    #[test]
    fn the_port_file_is_the_fallback() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", "{}");
        fs::write(home.0.join("http.port"), format!("{port}\n")).unwrap();
        assert_eq!(notify(EVENT, &env(&home, None)), Outcome::Posted);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().body, EVENT);
    }

    #[test]
    fn a_refused_post_retries_once_at_the_current_port() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", "{}");
        fs::write(home.0.join("http.port"), port.to_string()).unwrap();
        assert_eq!(
            notify(EVENT, &env(&home, Some(closed_port()))),
            Outcome::Posted
        );
        let retried = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(retried
            .head
            .starts_with("POST /api/v1/terminal/status HTTP/1."));
        assert_eq!(retried.body, EVENT);
        assert_eq!(log(&home), "");
    }

    #[test]
    fn a_refused_post_with_an_unchanged_port_is_logged() {
        let home = TempDir::new();
        let port = closed_port();
        fs::write(home.0.join("http.port"), port.to_string()).unwrap();
        assert_eq!(notify(EVENT, &env(&home, Some(port))), Outcome::Failed);
        let log = log(&home);
        assert!(
            log.contains(&format!(
                " post-failed: event=Stop session=tab-1 url=http://127.0.0.1:{port}/api/v1/terminal/status error=connect http=none body=\n"
            )),
            "{log}"
        );
    }

    #[test]
    fn a_non_200_is_logged_with_its_body() {
        let home = TempDir::new();
        let (port, _rx) = listener("500 Internal Server Error", "boom\nagain");
        assert_eq!(notify(EVENT, &env(&home, Some(port))), Outcome::Failed);
        let log = log(&home);
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(
            log.ends_with(&format!(
                " post-failed: event=Stop session=tab-1 url=http://127.0.0.1:{port}/api/v1/terminal/status error=none http=500 body=boom again\n"
            )),
            "{log}"
        );
    }

    #[test]
    fn an_unknown_session_is_logged() {
        let home = TempDir::new();
        let body = "{\"status\":\"unknown-session\"}";
        let (port, _rx) = listener("200 OK", body);
        assert_eq!(notify(EVENT, &env(&home, Some(port))), Outcome::Failed);
        assert!(log(&home).ends_with(&format!(" http=200 body={body}\n")));
    }

    #[test]
    fn the_status_url_is_used_as_given() {
        let home = TempDir::new();
        let (port, rx) = listener("200 OK", "{}");
        let mut env = env(&home, None);
        env.status_url = Some(format!("http://127.0.0.1:{port}/remote/status"));
        assert_eq!(notify(EVENT, &env), Outcome::Posted);
        let request = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.head.starts_with("POST /remote/status HTTP/1."));
    }

    #[test]
    fn an_unsupported_status_url_is_logged() {
        let home = TempDir::new();
        let mut env = env(&home, None);
        for url in [
            "https://127.0.0.1:1/x",
            "http://127.0.0.1/x",
            "ftp://h:1/",
            // A name to look up could outlast the post's deadline.
            "http://example.invalid:1/x",
        ] {
            env.status_url = Some(url.to_string());
            assert_eq!(notify(EVENT, &env), Outcome::Failed, "{url}");
            assert!(
                log(&home).ends_with(&format!(
                    " url={url} error=unsupported-url http=none body=\n"
                )),
                "{url}"
            );
        }
    }

    #[test]
    fn the_log_rotates_past_its_cap() {
        let home = TempDir::new();
        let logs = home.0.join("logs");
        fs::create_dir_all(&logs).unwrap();
        let big = vec![b'x'; LOG_CAP as usize + 1];
        fs::write(logs.join("notify-hook.log"), &big).unwrap();
        notify(EVENT, &env(&home, None));
        assert_eq!(fs::read(logs.join("notify-hook.log.1")).unwrap(), big);
        assert_eq!(log(&home).lines().count(), 1);
    }

    #[test]
    fn a_failure_is_one_log_line_whatever_the_event_holds() {
        let home = TempDir::new();
        let mut env = env(&home, None);
        env.tab_session = Some("tab\n1".to_string());
        env.status_url = Some("ftp://h:1/".to_string());
        assert_eq!(
            notify(br#"{"hook_event_name":"Sto\np"}"#, &env),
            Outcome::Failed
        );
        let log = log(&home);
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(
            log.contains(" event=Sto p session=tab 1 url=ftp://h:1/ "),
            "{log}"
        );
    }

    #[test]
    fn a_failed_rotation_still_logs_the_line() {
        let home = TempDir::new();
        let logs = home.0.join("logs");
        // A non-empty directory where the rotated log goes: the rename fails.
        fs::create_dir_all(logs.join("notify-hook.log.1")).unwrap();
        fs::write(logs.join("notify-hook.log.1/x"), "x").unwrap();
        fs::write(
            logs.join("notify-hook.log"),
            vec![b'x'; LOG_CAP as usize + 1],
        )
        .unwrap();
        notify(EVENT, &env(&home, None));
        assert!(log(&home)
            .ends_with(" no-port: CODESENSE_API_PORT unset and no ~/.codesense/http.port\n"));
    }

    #[test]
    fn the_log_time_is_utc_seconds() {
        for (secs, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (951_868_800, "2000-03-01T00:00:00Z"),
            (1_709_251_199, "2024-02-29T23:59:59Z"),
            (1_794_996_823, "2026-11-18T10:13:43Z"),
            (4_102_444_800, "2100-01-01T00:00:00Z"),
        ] {
            assert_eq!(utc_time(UNIX_EPOCH + Duration::from_secs(secs)), expected);
        }
    }
}
