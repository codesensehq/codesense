// SPDX-License-Identifier: MIT
//! The answer to a Windows pseudo console's startup cursor query.
//!
//! portable-pty creates the console with `PSEUDOCONSOLE_INHERIT_CURSOR`, so
//! ConPTY's first output asks the terminal where its cursor is (`ESC [ 6 n`)
//! and serves the child's console only once the answer comes. A session with
//! no viewer, or whose viewer attached later and painted from a snapshot, would
//! never answer. [`CursorReply`] wraps a session's reader: it takes the first
//! query out of the stream and answers it once, at the top-left corner, where
//! a new console's cursor is. No viewer sees the query, so none answers it
//! again: a second answer, read after ConPTY stopped waiting, would reach the
//! child as input.
//!
//! Without passthrough mode, ConPTY answers a child's own queries itself, so
//! the startup query is the only one that reaches the reader. Only the first
//! [`WINDOW`] bytes are searched; past them, or once answered, every byte
//! passes through unchanged.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

use log::warn;

/// The cursor position query.
const QUERY: &[u8] = b"\x1b[6n";
/// The answer: row 1, column 1.
const ANSWER: &[u8] = b"\x1b[1;1R";
/// How far into the output a query may start. ConPTY may set modes first.
pub(super) const WINDOW: usize = 512;

/// The session's writer, as [`super::PtySession::writer`] shares it.
type SessionWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// A session's reader that answers the startup cursor query (see the module
/// docs). It returns `Ok(0)` only once the inner reader has.
pub(super) struct CursorReply {
    inner: Box<dyn Read + Send>,
    /// Where the answer goes; `None` once answered or once the window passed,
    /// and from then on every read goes straight to `inner`.
    writer: Option<SessionWriter>,
    /// How many bytes `inner` has returned.
    consumed: usize,
    /// The start of a query, held until the next read tells whether it is one.
    held: Vec<u8>,
    /// Bytes ready for the caller that did not fit its buffer.
    pending: Vec<u8>,
    /// An error from `inner`, returned after the held bytes it flushed.
    error: Option<io::Error>,
}

impl CursorReply {
    pub(super) fn new(inner: Box<dyn Read + Send>, writer: SessionWriter) -> Self {
        Self {
            inner,
            writer: Some(writer),
            consumed: 0,
            held: Vec::new(),
            pending: Vec::new(),
            error: None,
        }
    }

    /// Hand the caller what is pending, keeping what does not fit.
    fn give(&mut self, buf: &mut [u8]) -> usize {
        let n = self.pending.len().min(buf.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        n
    }

    /// Search `data` (the held bytes, then a fresh read) and queue what passes
    /// through.
    fn scan(&mut self, data: Vec<u8>) {
        // The stream offset of `data[0]`: the held bytes were read before.
        let start = self.consumed - data.len();
        let in_window = |at: usize| start + at < WINDOW;
        let found = data
            .windows(QUERY.len())
            .position(|bytes| bytes == QUERY)
            .filter(|&at| in_window(at));
        if let Some(at) = found {
            self.answer();
            self.pending.extend_from_slice(&data[..at]);
            self.pending.extend_from_slice(&data[at + QUERY.len()..]);
            return;
        }
        // A read may end partway through a query: hold its start.
        let partial = (1..QUERY.len())
            .rev()
            .find(|&len| data.ends_with(&QUERY[..len]) && in_window(data.len() - len));
        match partial {
            Some(len) => {
                let cut = data.len() - len;
                self.pending.extend_from_slice(&data[..cut]);
                self.held = data[cut..].to_vec();
            }
            None => {
                self.pending.extend_from_slice(&data);
                if self.consumed >= WINDOW {
                    self.writer = None;
                }
            }
        }
    }

    /// Write the answer, once, and let the writer go.
    fn answer(&mut self) {
        let Some(shared) = self.writer.take() else {
            return;
        };
        let mut writer = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(error) = writer.write_all(ANSWER).and_then(|()| writer.flush()) {
            warn!(target: "pty", "cursor query not answered: {error}");
        }
    }
}

impl Read for CursorReply {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if !self.pending.is_empty() {
                return Ok(self.give(buf));
            }
            if let Some(error) = self.error.take() {
                return Err(error);
            }
            if self.writer.is_none() && self.held.is_empty() {
                return self.inner.read(buf);
            }
            let mut chunk = [0u8; 4096];
            match self.inner.read(&mut chunk) {
                Ok(0) => {
                    // End of stream: what was held was not a query.
                    self.writer = None;
                    if self.held.is_empty() {
                        return Ok(0);
                    }
                    self.pending = std::mem::take(&mut self.held);
                }
                Ok(n) => {
                    self.consumed += n;
                    let mut data = std::mem::take(&mut self.held);
                    data.extend_from_slice(&chunk[..n]);
                    self.scan(data);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    if self.held.is_empty() {
                        return Err(error);
                    }
                    self.pending = std::mem::take(&mut self.held);
                    self.error = Some(error);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Hands out `reads` one per call, then end of stream.
    struct Script(VecDeque<io::Result<Vec<u8>>>);

    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(Err(error)) => Err(error),
                Some(Ok(bytes)) => {
                    assert!(bytes.len() <= buf.len(), "a scripted read fits the buffer");
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
            }
        }
    }

    /// Keeps what is written to it.
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A wrapper over `reads`, the writer it holds, and what was written.
    fn wrap(reads: &[&[u8]]) -> (CursorReply, SessionWriter, Arc<Mutex<Vec<u8>>>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        let writer: SessionWriter = Arc::new(Mutex::new(Box::new(Sink(written.clone()))));
        let script = Script(reads.iter().map(|bytes| Ok(bytes.to_vec())).collect());
        let reply = CursorReply::new(Box::new(script), writer.clone());
        (reply, writer, written)
    }

    /// Every byte up to end of stream, failing on an `Ok(0)` before it.
    fn drain(reply: &mut CursorReply) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reply.read(&mut buf).expect("a read") {
                0 => return out,
                n => out.extend_from_slice(&buf[..n]),
            }
        }
    }

    #[test]
    fn a_query_split_across_reads_is_answered_and_removed() {
        let (mut reply, _writer, written) = wrap(&[&b"\x1b"[..], &b"[6"[..], &b"nhello"[..]]);
        assert_eq!(drain(&mut reply), b"hello");
        assert_eq!(*written.lock().unwrap(), ANSWER);
    }

    #[test]
    fn mode_sets_before_the_query_pass_through() {
        let (mut reply, _writer, written) = wrap(&[&b"\x1b[?9001h\x1b[?1004h\x1b[6nrest"[..]]);
        assert_eq!(drain(&mut reply), b"\x1b[?9001h\x1b[?1004hrest");
        assert_eq!(*written.lock().unwrap(), ANSWER);
    }

    #[test]
    fn a_read_of_only_the_query_reads_again_rather_than_ending() {
        let (mut reply, _writer, written) = wrap(&[QUERY, &b"x"[..]]);
        let mut buf = [0u8; 16];
        assert_eq!(reply.read(&mut buf).unwrap(), 1, "never Ok(0) mid-stream");
        assert_eq!(&buf[..1], b"x");
        assert_eq!(reply.read(&mut buf).unwrap(), 0);
        assert_eq!(*written.lock().unwrap(), ANSWER);
    }

    #[test]
    fn a_held_query_start_is_flushed_at_end_of_stream_or_on_an_error() {
        let (mut reply, _writer, written) = wrap(&[&b"ab\x1b["[..]]);
        assert_eq!(drain(&mut reply), b"ab\x1b[");
        assert!(written.lock().unwrap().is_empty());

        let writer: SessionWriter = Arc::new(Mutex::new(Box::new(io::sink())));
        let script = Script(VecDeque::from([
            Ok(b"\x1b[6".to_vec()),
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "gone")),
        ]));
        let mut reply = CursorReply::new(Box::new(script), writer);
        let mut buf = [0u8; 16];
        assert_eq!(reply.read(&mut buf).unwrap(), 3);
        assert_eq!(&buf[..3], b"\x1b[6");
        let error = reply.read(&mut buf).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn the_answer_is_written_once_and_the_writer_let_go() {
        let (mut reply, writer, written) = wrap(&[&b"a\x1b[6n"[..], &b"b\x1b[6nc"[..]]);
        let mut buf = [0u8; 16];
        let n = reply.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"a");
        assert_eq!(*written.lock().unwrap(), ANSWER);
        assert_eq!(Arc::strong_count(&writer), 1, "the wrapper keeps no writer");
        assert_eq!(drain(&mut reply), b"b\x1b[6nc");
        assert_eq!(*written.lock().unwrap(), ANSWER, "one answer only");
    }

    #[test]
    fn every_other_byte_passes_through_exactly() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(3000).collect();
        let chunks: Vec<&[u8]> = bytes.chunks(700).collect();
        let (mut reply, _writer, written) = wrap(&chunks);
        assert_eq!(drain(&mut reply), bytes);
        assert!(written.lock().unwrap().is_empty());

        let mut with_query = b"\x1b[6n".to_vec();
        with_query.extend_from_slice(&bytes[..1000]);
        let (mut reply, _writer, _written) = wrap(&[&with_query[..]]);
        assert_eq!(drain(&mut reply), &bytes[..1000]);
    }

    #[test]
    fn no_query_in_the_window_is_never_answered() {
        let filler = vec![b'x'; WINDOW];
        let (mut reply, writer, written) = wrap(&[&filler[..], QUERY]);
        let mut buf = [0u8; 4096];
        assert_eq!(reply.read(&mut buf).unwrap(), WINDOW);
        assert_eq!(Arc::strong_count(&writer), 1, "the window passed");
        assert_eq!(drain(&mut reply), QUERY);
        assert!(written.lock().unwrap().is_empty());
    }

    #[test]
    fn a_query_starting_at_the_windows_edge_is_answered() {
        let filler = vec![b'x'; WINDOW - 1];
        let (mut reply, _writer, written) = wrap(&[&filler[..], &b"\x1b["[..], &b"6nok"[..]]);
        let mut expected = filler.clone();
        expected.extend_from_slice(b"ok");
        assert_eq!(drain(&mut reply), expected);
        assert_eq!(*written.lock().unwrap(), ANSWER);

        let filler = vec![b'x'; WINDOW];
        let mut late = filler.clone();
        late.extend_from_slice(QUERY);
        let (mut reply, _writer, written) = wrap(&[&late[..]]);
        assert_eq!(drain(&mut reply), late, "one byte later is outside");
        assert!(written.lock().unwrap().is_empty());
    }

    #[test]
    fn a_later_query_passes_through() {
        let (mut reply, _writer, written) =
            wrap(&[&b"\x1b[6n"[..], &b"one\x1b[6ntwo"[..], &b"\x1b[6n"[..]]);
        assert_eq!(drain(&mut reply), b"one\x1b[6ntwo\x1b[6n");
        assert_eq!(*written.lock().unwrap(), ANSWER);
    }
}
