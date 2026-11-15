// SPDX-License-Identifier: MIT
//! A running session's assistant prose, streamed to the pages that ask for it
//! (`onSessionText`): its assistant prose as it is written, never its thinking or reasoning,
//! tool calls or tool results, and one turn end per turn. It tails the session log the
//! conversation capture reads, redacting each line the same way, but as rows arrive instead of
//! after the capture's 60 s debounce. What a line says comes from the adapter's parser for the
//! log's transcript format (`agent_cli::prose`), so any CLI whose log has one streams.
//!
//! The pure parts (the tail, a session's stream) are here with their tests; the watch registry
//! wires them to a file watcher, the turn-end hook and the app event.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use codesense_pty_core::agent_cli::prose::{self, ProseEvent};
use codesense_pty_core::agent_cli::TranscriptFormat;

use crate::shared::secret_scan::redact_secrets;

/// The app event a page's stream is fed from (`live-hub.ts` routes it to the frames that asked).
pub const EVENT: &str = "session-text";

/// A session log read from a byte offset: each read returns the complete lines written since,
/// redacted, and keeps a trailing partial line for the next read. A log that shrank (rewritten)
/// is read again from its start. A link or anything but a regular file reads as nothing.
#[derive(Debug)]
pub struct Tail {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl Tail {
    pub fn at(path: PathBuf, offset: u64) -> Self {
        Tail {
            path,
            offset,
            partial: vec![],
        }
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn read(&mut self) -> std::io::Result<Vec<String>> {
        let Some((mut file, len)) = open_log(&self.path)? else {
            return Ok(vec![]);
        };
        if len < self.offset {
            self.offset = 0;
            self.partial = vec![];
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut fresh: Vec<u8> = vec![];
        file.read_to_end(&mut fresh)?;
        self.offset += fresh.len() as u64;
        self.partial.extend_from_slice(&fresh);
        let Some(last_newline) = self.partial.iter().rposition(|b| *b == b'\n') else {
            return Ok(vec![]);
        };
        let rest = self.partial.split_off(last_newline + 1);
        let complete = std::mem::replace(&mut self.partial, rest);
        let lines = complete
            .split(|b| *b == b'\n')
            .filter(|line| line.first().is_some())
            .map(|line| redact_secrets(&String::from_utf8_lossy(line)));
        Ok(Iterator::collect(lines))
    }
}

/// `path` opened for reading without following a link, with its length; `None` for anything but
/// a regular file.
fn open_log(path: &Path) -> std::io::Result<Option<(std::fs::File, u64)>> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = std::fs::File::metadata(&file)?;
    Ok(meta.is_file().then(|| (file, meta.len())))
}

/// How much of a log's end a new watch scans for the current turn's start.
const START_WINDOW: u64 = 4 * 1024 * 1024;

/// Where a new watch starts reading `path`: the start of the line that opened the current turn,
/// so a page that subscribes mid-turn still hears that turn's prose and its end. Only the log's
/// last `START_WINDOW` bytes are scanned: a turn that opened before them starts at the window's
/// first whole line. 0 when the log can't be read.
pub fn start_offset(path: &Path, format: TranscriptFormat) -> u64 {
    start_offset_within(path, format, START_WINDOW)
}

fn start_offset_within(path: &Path, format: TranscriptFormat, window: u64) -> u64 {
    let Ok(Some((mut file, len))) = open_log(path) else {
        return 0;
    };
    let from = len.saturating_sub(window);
    let mut bytes: Vec<u8> = vec![];
    if file.seek(SeekFrom::Start(from)).is_err() || file.read_to_end(&mut bytes).is_err() {
        return 0;
    }
    // A window that starts mid-line starts at its first whole line.
    let first_newline = Iterator::position(&mut bytes.iter(), |b| *b == b'\n');
    let skip = match from {
        0 => 0,
        _ => first_newline.map_or(bytes.len(), |i| i + 1),
    };
    let mut at: u64 = from + skip as u64;
    let mut turn_at: u64 = at;
    for line in bytes[skip..].split_inclusive(|b| *b == b'\n') {
        let text = String::from_utf8_lossy(line);
        if prose::events(format, str::trim(&text))
            .iter()
            .any(|e| matches!(e, ProseEvent::Turn { .. }))
        {
            turn_at = at;
        }
        at += line.len() as u64;
    }
    turn_at
}

/// What a page hears from a session's stream: prose as it is written, a tool marker (no text),
/// and the turn's end.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StreamEvent {
    #[serde(rename = "prose")]
    Prose {
        turn: String,
        key: String,
        text: String,
    },
    #[serde(rename = "tool")]
    Tool { turn: String },
    #[serde(rename = "end")]
    End { turn: String },
}

/// The most of a turn's events a stream keeps to replay to a watcher that joins mid-turn.
const REPLAY_KEPT: usize = 256;

/// One session's stream: the current turn, the prose already sent (a re-read never repeats it),
/// the turn's events so far (replayed to a watcher that joins mid-turn) and whether the turn has
/// ended (it ends once).
#[derive(Debug, Default)]
pub struct Stream {
    turn: String,
    ended: bool,
    sent: HashSet<String>,
    so_far: Vec<StreamEvent>,
}

impl Stream {
    pub fn feed(&mut self, event: ProseEvent) -> Option<StreamEvent> {
        let event = match event {
            ProseEvent::Turn { key } => {
                self.turn = key;
                self.ended = false;
                self.so_far = vec![];
                return None;
            }
            ProseEvent::Prose { key, text } => {
                if !self.sent.insert(key.clone()) {
                    return None;
                }
                StreamEvent::Prose {
                    turn: self.turn.clone(),
                    key,
                    text,
                }
            }
            ProseEvent::Tool => StreamEvent::Tool {
                turn: self.turn.clone(),
            },
        };
        if self.so_far.len() == REPLAY_KEPT {
            self.so_far.remove(0);
        }
        self.so_far.push(event.clone());
        Some(event)
    }

    /// The current turn's prose and tool markers so far, for a watcher that joins mid-turn;
    /// nothing once the turn has ended.
    pub fn replay(&self) -> Vec<StreamEvent> {
        match self.ended {
            true => vec![],
            false => self.so_far.clone(),
        }
    }

    /// The turn ended (the Stop hook, a failure or an interrupt): once per turn.
    pub fn end(&mut self) -> Option<StreamEvent> {
        if self.ended {
            return None;
        }
        self.ended = true;
        Some(StreamEvent::End {
            turn: self.turn.clone(),
        })
    }
}

/// A watched session: its log's tail, the log's transcript format and its stream.
#[derive(Debug)]
pub struct Watched {
    tail: Tail,
    format: TranscriptFormat,
    stream: Stream,
}

impl Watched {
    pub fn new(path: PathBuf, format: TranscriptFormat) -> Self {
        let offset = start_offset(&path, format);
        Watched {
            tail: Tail::at(path, offset),
            format,
            stream: Default::default(),
        }
    }

    /// The stream events of everything written since the last read.
    pub fn pump(&mut self) -> Vec<StreamEvent> {
        let lines = self.tail.read().unwrap_or_default();
        let mut out = vec![];
        for line in lines {
            for event in prose::events(self.format, &line) {
                out.extend(Stream::feed(&mut self.stream, event));
            }
        }
        out
    }

    /// The turn ended: what was written since the last read, then its end.
    pub fn end_turn(&mut self) -> Vec<StreamEvent> {
        let mut out = Watched::pump(self);
        out.extend(Stream::end(&mut self.stream));
        out
    }
}

// ---------------------------------------------------------------------------
// The watch registry: one file watcher per watched session, counted by its watchers.
// ---------------------------------------------------------------------------

type Emit = Box<dyn Fn(&str, &StreamEvent) + Send + Sync>;
static EMIT: OnceLock<Emit> = OnceLock::new();

struct Entry {
    watched: Watched,
    watchers: usize,
    _file_watch: Option<notify::RecommendedWatcher>,
}

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where the app event goes: installed once at startup.
pub fn install_app_emitter(app: tauri::AppHandle) {
    use tauri::Emitter;
    let _ = EMIT.set(Box::new(move |session_id, event| {
        let payload = serde_json::json!({ "sessionId": session_id, "event": event });
        if let Err(e) = Emitter::emit(&app, EVENT, payload) {
            log::debug!(target: "session_text", "session text not emitted: {e}");
        }
    }));
}

fn emit(session_id: &str, events: Vec<StreamEvent>) {
    let Some(sink) = EMIT.get() else { return };
    for event in &events {
        crate::shared::invoke_stats::metric_count("session_text.emit");
        sink(session_id, event);
    }
}

/// Read what `session_id`'s log gained and send it.
fn pump(session_id: &str) {
    let events = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(session_id) else {
            return;
        };
        Watched::pump(&mut entry.watched)
    };
    emit(session_id, events);
}

/// The session log of `session_id` and its transcript format, as the conversation capture
/// finds it.
fn session_log_path(session_id: &str) -> Result<(PathBuf, TranscriptFormat), String> {
    crate::session_conversation::prose_session_log(session_id)
        .ok_or_else(|| format!("no session log with prose for {session_id}"))
}

/// Start (or count one more watcher of) `session_id`'s stream. Only a local session whose log has
/// a prose parser (`prose::streams`) has one to tail.
pub fn watch(session_id: &str) -> Result<(), String> {
    let joined = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        map.get_mut(session_id).map(join)
    };
    if let Some(replay) = joined {
        emit(session_id, replay);
        return Ok(());
    }
    let (path, format) = session_log_path(session_id)?;
    let watched = Watched::new(path.clone(), format);
    let owner = session_id.to_owned();
    let started = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            pump(&owner);
        }
    })
    .and_then(|mut w| {
        notify::Watcher::watch(&mut w, &path, notify::RecursiveMode::NonRecursive).map(|_| w)
    });
    let file_watch = match started {
        Ok(w) => Some(w),
        Err(e) => {
            let shown = std::path::Path::display(&path);
            log::warn!(target: "session_text", "no file watch on {shown}: {e}");
            None
        }
    };
    let entry = Entry {
        watched,
        watchers: 1,
        _file_watch: file_watch,
    };
    let joined = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        admit(&mut map, session_id, entry)
    };
    match joined {
        // Another first watch got there while this one opened the log: this one joined it.
        Some(replay) => emit(session_id, replay),
        // The current turn's prose so far.
        None => pump(session_id),
    }
    Ok(())
}

/// One more watcher of an entry: its current turn so far, to replay.
fn join(entry: &mut Entry) -> Vec<StreamEvent> {
    entry.watchers += 1;
    Stream::replay(&entry.watched.stream)
}

/// Keeps `entry` as `session_id`'s stream, or, when another watch already holds one, counts one
/// more watcher of that and drops `entry`: `Some` replay then.
fn admit(
    map: &mut HashMap<String, Entry>,
    session_id: &str,
    entry: Entry,
) -> Option<Vec<StreamEvent>> {
    match HashMap::entry(map, session_id.to_owned()) {
        std::collections::hash_map::Entry::Occupied(mut held) => Some(join(held.get_mut())),
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(entry);
            None
        }
    }
}

/// One watcher of `session_id`'s stream is gone; the last one stops it.
pub fn unwatch(session_id: &str) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    release(&mut map, session_id);
}

fn release(map: &mut HashMap<String, Entry>, session_id: &str) {
    let last = map.get_mut(session_id).is_some_and(|entry| {
        entry.watchers = entry.watchers.saturating_sub(1);
        entry.watchers == 0
    });
    if last {
        map.remove(session_id);
    }
}

/// `session_id`'s turn ended (stopped, failed or interrupted): the rest of its prose, then the end.
pub fn note_turn_end(session_id: &str) {
    let events = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(session_id) else {
            return;
        };
        entry.watched.end_turn()
    };
    emit(session_id, events);
}

/// `session_id` ended: its stream stops for every watcher.
pub fn note_end(session_id: &str) {
    note_turn_end(session_id);
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const FIXTURE: &str =
        include_str!("../crates/codesense-pty-core/tests/fixtures/claude/session-2.1.296.jsonl");
    const ROLLOUT: &str =
        include_str!("../crates/codesense-pty-core/tests/fixtures/codex/rollout-0.164.0.jsonl");
    const CLAUDE_LOG: TranscriptFormat = TranscriptFormat::AnthropicSessionJsonl;
    const CODEX_LOG: TranscriptFormat = TranscriptFormat::CodexSessionJsonl;

    fn events(format: TranscriptFormat, line: &str) -> Vec<ProseEvent> {
        prose::events(format, line)
    }

    #[test]
    fn the_tail_returns_complete_lines_once_keeps_a_partial_one_and_rereads_a_rewritten_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        let mut tail = Tail::at(path.clone(), 0);
        write!(file, "one\ntw").unwrap();
        assert_eq!(tail.read().unwrap(), vec!["one"]);
        assert_eq!(tail.read().unwrap(), Vec::<String>::new());
        write!(file, "o\nthree\n").unwrap();
        assert_eq!(tail.read().unwrap(), vec!["two", "three"]);
        std::fs::write(&path, "new\n").unwrap();
        assert_eq!(tail.read().unwrap(), vec!["new"]);
    }

    #[test]
    fn the_tail_redacts_each_line_and_refuses_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        // A fake key, built at run time as the secret scanner's own tests do.
        let key = ["sk-", "abcdefghijklmnopqrstuvwxyz"].concat();
        std::fs::write(&path, format!("key {key} here\n")).unwrap();
        let line = Tail::at(path.clone(), 0).read().unwrap().remove(0);
        assert!(!line.contains(&key), "{line}");
        let link = dir.path().join("link.jsonl");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(Tail::at(link, 0).read().is_err());
    }

    #[test]
    fn a_watch_starts_at_the_current_turn() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();
        let offset = start_offset(&path, CLAUDE_LOG);
        let rest = &FIXTURE[offset as usize..];
        assert!(rest.starts_with('{'));
        assert!(
            matches!(events(CLAUDE_LOG, rest.lines().next().unwrap()).as_slice(), [ProseEvent::Turn { key }] if key == "u4")
        );
    }

    #[test]
    fn the_stream_sends_each_prose_once_and_ends_each_turn_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let first_turn: String = FIXTURE.lines().take(9).map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, &first_turn).unwrap();
        let mut watched = Watched {
            tail: Tail::at(path.clone(), 0),
            format: CLAUDE_LOG,
            stream: Stream::default(),
        };
        let sent = watched.pump();
        let prose = sent
            .iter()
            .filter(|e| matches!(e, StreamEvent::Prose { .. }))
            .count();
        assert_eq!(prose, 2);
        assert!(sent.iter().all(|e| !matches!(e, StreamEvent::End { .. })));
        let ended = watched.end_turn();
        assert_eq!(ended, vec![StreamEvent::End { turn: "u1".into() }]);
        // A second Stop for the same turn ends nothing.
        assert_eq!(watched.end_turn(), vec![]);
        // A tail read again from the start (a rewritten log) repeats no prose.
        watched.tail = Tail::at(path.clone(), 0);
        assert!(watched
            .pump()
            .iter()
            .all(|e| !matches!(e, StreamEvent::Prose { .. })));
        // A new turn ends once again.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{}", FIXTURE.lines().nth(9).unwrap()).unwrap();
        watched.pump();
        assert_eq!(
            watched.end_turn(),
            vec![StreamEvent::End { turn: "u4".into() }]
        );
    }

    #[test]
    fn a_watch_scans_only_the_logs_end_for_the_current_turn() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();
        let len = FIXTURE.len() as u64;
        // The window holds the current turn's opening line: the watch starts there.
        let whole = start_offset_within(&path, CLAUDE_LOG, len);
        assert_eq!(
            start_offset_within(&path, CLAUDE_LOG, len - whole + 1),
            whole
        );
        // A window that starts after it, mid-line: the watch starts at its first whole line.
        let late = start_offset_within(&path, CLAUDE_LOG, len - whole - 3);
        assert!(late > whole && FIXTURE.as_bytes()[late as usize - 1] == b'\n');
        assert_eq!(
            start_offset_within(&dir.path().join("gone"), CLAUDE_LOG, len),
            0
        );
    }

    fn fixture_stream(lines: usize) -> Stream {
        let mut stream = Stream::default();
        for event in FIXTURE
            .lines()
            .take(lines)
            .flat_map(|l| events(CLAUDE_LOG, l))
        {
            stream.feed(event);
        }
        stream
    }

    #[test]
    fn a_watcher_that_joins_mid_turn_is_replayed_the_turn_so_far_and_nothing_after_its_end() {
        let mut stream = fixture_stream(9);
        let replay = stream.replay();
        let kinds: Vec<&str> = replay
            .iter()
            .map(|e| match e {
                StreamEvent::Prose { .. } => "prose",
                StreamEvent::Tool { .. } => "tool",
                StreamEvent::End { .. } => "end",
            })
            .collect();
        assert_eq!(kinds, ["prose", "tool", "tool", "prose"], "{replay:?}");
        stream.end();
        assert_eq!(stream.replay(), vec![]);
        // A new turn replays only itself.
        assert_eq!(fixture_stream(10).replay(), vec![]);
    }

    fn entry(path: &Path) -> Entry {
        Entry {
            watched: Watched {
                tail: Tail::at(path.to_owned(), 0),
                format: CLAUDE_LOG,
                stream: fixture_stream(9),
            },
            watchers: 1,
            _file_watch: None,
        }
    }

    #[test]
    fn a_second_first_watch_joins_the_first_and_one_unwatch_leaves_the_other_streaming() {
        let mut map = HashMap::new();
        assert_eq!(admit(&mut map, "s1", entry(Path::new("/first"))), None);
        // Another watch that opened the log at the same time joins instead of replacing it.
        let replay = admit(&mut map, "s1", entry(Path::new("/second"))).unwrap();
        assert_eq!(replay.len(), 4);
        assert_eq!(map["s1"].watchers, 2);
        assert_eq!(map["s1"].watched.tail.path, Path::new("/first"));
        release(&mut map, "s1");
        assert_eq!(map["s1"].watchers, 1);
        release(&mut map, "s1");
        assert!(map.is_empty());
    }

    #[test]
    fn a_codex_rollout_streams_its_turn_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        // The rollout up to the answer: the request, a preamble, three tool calls, the answer.
        let turn: String = ROLLOUT.lines().take(14).map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, &turn).unwrap();
        let mut watched = Watched::new(path.clone(), CODEX_LOG);
        let sent = watched.end_turn();
        let kinds: Vec<&str> = sent
            .iter()
            .map(|e| match e {
                StreamEvent::Prose { .. } => "prose",
                StreamEvent::Tool { .. } => "tool",
                StreamEvent::End { .. } => "end",
            })
            .collect();
        assert_eq!(
            kinds,
            ["prose", "tool", "tool", "tool", "prose", "end"],
            "{sent:?}"
        );
        // The turn the events belong to is the request's row, the same on each read.
        let turn_key = match &sent[0] {
            StreamEvent::Prose { turn, .. } => turn.clone(),
            other => panic!("{other:?}"),
        };
        assert!(!turn_key.is_empty());
        assert!(sent.iter().all(|e| match e {
            StreamEvent::Prose { turn, .. }
            | StreamEvent::Tool { turn }
            | StreamEvent::End { turn } => *turn == turn_key,
        }));
        // A watch opened on the whole rollout starts at its latest request.
        std::fs::write(&path, ROLLOUT).unwrap();
        let offset = start_offset(&path, CODEX_LOG);
        let first = ROLLOUT[offset as usize..].lines().next().unwrap();
        assert!(matches!(
            events(CODEX_LOG, first).as_slice(),
            [ProseEvent::Turn { .. }]
        ));
        assert!(ROLLOUT[offset as usize..].lines().count() == 1);
    }

    #[test]
    fn a_stream_event_serializes_as_the_page_reads_it() {
        let prose = StreamEvent::Prose {
            turn: "u1".into(),
            key: "a3".into(),
            text: "Done.".into(),
        };
        assert_eq!(
            serde_json::to_value(&prose).unwrap(),
            serde_json::json!({"kind":"prose","turn":"u1","key":"a3","text":"Done."})
        );
        assert_eq!(
            serde_json::to_value(StreamEvent::Tool { turn: "u1".into() }).unwrap(),
            serde_json::json!({"kind":"tool","turn":"u1"})
        );
    }
}
