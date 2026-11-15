// SPDX-License-Identifier: MIT
//! A running Claude session's assistant prose, streamed to the pages that ask for it
//! (`onSessionText`): the `text` blocks of its assistant rows as they are written, never its
//! thinking, tool calls or tool results, and one turn end per turn. It tails the session log the
//! conversation capture reads, redacting each line the same way, but as rows arrive instead of
//! after the capture's 60 s debounce.
//!
//! The pure parts (a line's events, the tail, a session's stream) are here with their tests; the
//! watch registry wires them to a file watcher, the turn-end hook and the app event.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::shared::secret_scan::redact_secrets;

/// The app event a page's stream is fed from (`live-hub.ts` routes it to the frames that asked).
pub const EVENT: &str = "session-text";

/// What one session-log line says for the stream, in the order it says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogEvent {
    /// The person's request: a new turn starts. `key` is the row's uuid.
    Turn { key: String },
    /// Assistant prose: the joined `text` blocks of an assistant row. `key` is the row's uuid.
    Prose { key: String, text: String },
    /// An assistant row that calls a tool: prose before it is progress, not the turn's final.
    Tool,
}

fn text_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

fn flag(row: &Value, key: &str) -> bool {
    row.get(key).and_then(Value::as_bool) == Some(true)
}

/// The events of one redacted Claude session-log line. A line that isn't JSON, a meta or
/// sidechain (subagent) row, a tool result, or a row with no prose says nothing.
pub fn classify(line: &str) -> Vec<LogEvent> {
    let Ok(row) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    if flag(&row, "isMeta") || flag(&row, "isSidechain") {
        return vec![];
    }
    let key = text_of(row.get("uuid")).unwrap_or_default().to_owned();
    let message = row.get("message").unwrap_or(&row);
    let content: Option<&Value> = message.get("content");
    match text_of(row.get("type")) {
        Some("user") => {
            if row.get("toolUseResult").is_some_and(|v| !Value::is_null(v)) {
                return vec![];
            }
            if text_of(row.pointer("/origin/kind")).is_some_and(|kind| kind != "human") {
                return vec![];
            }
            let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], |a| &a[..]);
            let answers_a_tool = blocks
                .iter()
                .any(|b| text_of(b.get("type")) == Some("tool_result"));
            let said = content.and_then(Value::as_str).is_some()
                || blocks
                    .iter()
                    .any(|b| text_of(b.get("type")) == Some("text"));
            if answers_a_tool || !said {
                return vec![];
            }
            vec![LogEvent::Turn { key }]
        }
        Some("assistant") => {
            let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], |a| &a[..]);
            let mut prose: Vec<&str> = vec![];
            let mut tool = false;
            for block in blocks {
                match text_of(block.get("type")) {
                    Some("text") => {
                        if let Some(text) = text_of(block.get("text")) {
                            let trimmed: &str = str::trim(text);
                            if !str::is_empty(trimmed) {
                                prose.push(text);
                            }
                        }
                    }
                    Some("tool_use") => tool = true,
                    _ => {}
                }
            }
            let mut out = vec![];
            if prose.first().is_some() {
                out.push(LogEvent::Prose {
                    key,
                    text: prose.join("\n\n"),
                });
            }
            if tool {
                out.push(LogEvent::Tool);
            }
            out
        }
        _ => vec![],
    }
}

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
        Ok(complete
            .split(|b| *b == b'\n')
            .filter(|line| line.first().is_some())
            .map(|line| redact_secrets(&String::from_utf8_lossy(line)))
            .collect())
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
pub fn start_offset(path: &Path) -> u64 {
    start_offset_within(path, START_WINDOW)
}

fn start_offset_within(path: &Path, window: u64) -> u64 {
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
        if classify(str::trim(&text))
            .iter()
            .any(|e| matches!(e, LogEvent::Turn { .. }))
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
    pub fn feed(&mut self, event: LogEvent) -> Option<StreamEvent> {
        let event = match event {
            LogEvent::Turn { key } => {
                self.turn = key;
                self.ended = false;
                self.so_far = vec![];
                return None;
            }
            LogEvent::Prose { key, text } => {
                if !self.sent.insert(key.clone()) {
                    return None;
                }
                StreamEvent::Prose {
                    turn: self.turn.clone(),
                    key,
                    text,
                }
            }
            LogEvent::Tool => StreamEvent::Tool {
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

/// A watched session: its log's tail and its stream.
#[derive(Debug)]
pub struct Watched {
    tail: Tail,
    stream: Stream,
}

impl Watched {
    pub fn new(path: PathBuf) -> Self {
        let offset = start_offset(&path);
        Watched {
            tail: Tail::at(path, offset),
            stream: Default::default(),
        }
    }

    /// The stream events of everything written since the last read.
    pub fn pump(&mut self) -> Vec<StreamEvent> {
        let lines = self.tail.read().unwrap_or_default();
        let mut out = vec![];
        for line in lines {
            for event in classify(&line) {
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

/// The Claude session log of `session_id`, as the conversation capture finds it.
fn session_log_path(session_id: &str) -> Result<PathBuf, String> {
    crate::session_conversation::claude_session_log(session_id)
        .ok_or_else(|| format!("no Claude session log for {session_id}"))
}

/// Start (or count one more watcher of) `session_id`'s stream. Only a local Claude session has a
/// log to tail.
pub fn watch(session_id: &str) -> Result<(), String> {
    let joined = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        map.get_mut(session_id).map(join)
    };
    if let Some(replay) = joined {
        emit(session_id, replay);
        return Ok(());
    }
    let path = session_log_path(session_id)?;
    let watched = Watched::new(path.clone());
    let owner = session_id.to_owned();
    let file_watch = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            pump(&owner);
        }
    })
    .and_then(|mut w| {
        notify::Watcher::watch(&mut w, &path, notify::RecursiveMode::NonRecursive).map(|_| w)
    })
    .map_err(|e| {
        let shown = std::path::Path::display(&path);
        log::warn!(target: "session_text", "no file watch on {shown}: {e}");
    })
    .ok();
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

    fn events(lines: &str) -> Vec<LogEvent> {
        lines.lines().flat_map(classify).collect()
    }

    #[test]
    fn a_tool_using_turn_yields_its_prose_and_tool_markers_never_thinking_or_tool_text() {
        let all = events(FIXTURE);
        // The fixture: a request, prose with a tool call (and thinking), two tool calls, the
        // answer, then a new request.
        assert!(matches!(&all[0], LogEvent::Turn { key } if key == "u1"));
        let prose: Vec<&str> = all
            .iter()
            .filter_map(|e| match e {
                LogEvent::Prose { text, .. } => Some(text.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(prose.len(), 2, "{all:?}");
        let tools = all.iter().filter(|e| **e == LogEvent::Tool).count();
        assert_eq!(tools, 2);
        assert!(matches!(all.last(), Some(LogEvent::Turn { key }) if key == "u4"));
        // Nothing of the thinking or tool input or output leaks into prose.
        let raw: Vec<Value> = FIXTURE
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        for row in &raw {
            for block in row
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let hidden = match text_of(block.get("type")) {
                    Some("thinking") => text_of(block.get("thinking")),
                    Some("tool_result") => text_of(block.get("content")),
                    _ => None,
                };
                if let Some(hidden) = hidden.filter(|h| h.len() > 8) {
                    assert!(prose.iter().all(|p| !p.contains(hidden)), "{hidden}");
                }
            }
        }
    }

    #[test]
    fn meta_sidechain_tool_result_and_non_human_rows_say_nothing() {
        for line in [
            r#"{"type":"user","isMeta":true,"uuid":"m","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","isSidechain":true,"uuid":"s","message":{"content":[{"type":"text","text":"sub"}]}}"#,
            r#"{"type":"user","uuid":"r","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}"#,
            r#"{"type":"user","uuid":"o","origin":{"kind":"system"},"message":{"content":"auto"}}"#,
            r#"{"type":"assistant","uuid":"t","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}"#,
            "not json",
        ] {
            assert_eq!(classify(line), vec![], "{line}");
        }
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
        let offset = start_offset(&path);
        let rest = &FIXTURE[offset as usize..];
        assert!(rest.starts_with('{'));
        assert!(
            matches!(classify(rest.lines().next().unwrap()).as_slice(), [LogEvent::Turn { key }] if key == "u4")
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
        let whole = start_offset_within(&path, len);
        assert_eq!(start_offset_within(&path, len - whole + 1), whole);
        // A window that starts after it, mid-line: the watch starts at its first whole line.
        let late = start_offset_within(&path, len - whole - 3);
        assert!(late > whole && FIXTURE.as_bytes()[late as usize - 1] == b'\n');
        assert_eq!(start_offset_within(&dir.path().join("gone"), len), 0);
    }

    fn fixture_stream(lines: usize) -> Stream {
        let mut stream = Stream::default();
        for event in FIXTURE.lines().take(lines).flat_map(classify) {
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
