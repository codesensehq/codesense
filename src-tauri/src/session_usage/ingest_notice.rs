// SPDX-License-Identifier: MIT
//! Tells the app which sessions just got usage, so a page showing one agent's record
//! (`sessionRecord`) rereads it. A burst of calls folds into one notice per debounce window that
//! names every session it touched.
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// How long a burst of ingests settles before the notice goes out.
pub(crate) const DEBOUNCE: Duration = Duration::from_secs(2);

/// The event the app emits, with `{"sessionIds": [...]}`.
pub(crate) const EVENT: &str = "session-usage-changed";

type Sink = Arc<dyn Fn(Vec<String>) + Send + Sync>;

#[derive(Default)]
struct Pending {
    ids: BTreeSet<String>,
    armed: bool,
}

/// Collects session ids and hands them to `sink` once, `delay` after the first of a burst.
pub(crate) struct Debouncer {
    delay: Duration,
    sink: Sink,
    pending: Arc<Mutex<Pending>>,
}

impl Debouncer {
    pub(crate) fn new(delay: Duration, sink: Sink) -> Self {
        Self {
            delay,
            sink,
            pending: Arc::default(),
        }
    }

    pub(crate) fn note(&self, ids: impl IntoIterator<Item = String>) {
        let mut pending = match self.pending.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        pending.ids.extend(ids);
        if pending.armed || pending.ids.is_empty() {
            return;
        }
        pending.armed = true;
        let (delay, sink, shared) = (self.delay, Arc::clone(&self.sink), Arc::clone(&self.pending));
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let ids = {
                let mut pending = match shared.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                pending.armed = false;
                std::mem::take(&mut pending.ids)
            };
            sink(ids.into_iter().collect());
        });
    }
}

static GLOBAL: OnceLock<Debouncer> = OnceLock::new();

/// Emit [`EVENT`] on `app` from now on.
pub fn install_app_emitter(app: tauri::AppHandle) {
    use tauri::Emitter;
    let sink: Sink = Arc::new(move |ids| {
        if let Err(e) = app.emit(EVENT, serde_json::json!({ "sessionIds": ids })) {
            log::debug!(target: "session_usage", "{EVENT} emit failed: {e}");
        }
    });
    let _ = GLOBAL.set(Debouncer::new(DEBOUNCE, sink));
}

/// Usage was stored for these sessions. Does nothing before the app installs its emitter.
pub(crate) fn ingested<'a>(ids: impl IntoIterator<Item = &'a str>) {
    if let Some(debouncer) = GLOBAL.get() {
        debouncer.note(ids.into_iter().map(str::to_owned));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_burst_of_ingests_is_one_notice_naming_each_session() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: Sink = Arc::new(move |ids| {
            tx.lock().unwrap().send(ids).unwrap();
        });
        let debouncer = Debouncer::new(Duration::from_millis(60), sink);
        debouncer.note(["s1".to_owned()]);
        debouncer.note(["s2".to_owned(), "s1".to_owned()]);
        let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first, ["s1", "s2"]);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        // The next ingest after a notice starts a new window.
        debouncer.note(["s3".to_owned()]);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), ["s3"]);
    }

    #[test]
    fn no_session_means_no_notice() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: Sink = Arc::new(move |ids| {
            tx.lock().unwrap().send(ids).unwrap();
        });
        Debouncer::new(Duration::from_millis(20), sink).note(Vec::new());
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }
}
