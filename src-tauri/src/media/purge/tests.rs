// SPDX-License-Identifier: MIT
use super::*;
use crate::media::{Config, FakeFetch};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn gif(n: u8) -> Vec<u8> {
    let mut bytes = b"GIF89a\x02\x00\x03\x00".to_vec();
    bytes.push(n);
    bytes
}

fn sha(n: u8) -> String {
    format!("{:x}", Sha256::digest(gif(n)))
}

fn team(name: &str) -> LaunchTeam {
    LaunchTeam {
        org: "acme".into(),
        team: name.into(),
    }
}

/// A cached image of `sha(n)` fetched from `url`; `provider` as stored (missing on an
/// old message).
fn image(n: u8, url: &str, provider: Option<MediaProvider>, own: bool) -> Attachment {
    let mut a = Attachment::empty("cat");
    a.sha256 = Some(sha(n));
    a.mime = Some("image/gif".into());
    a.bytes = Some(11);
    a.source_host = url::Url::parse(url).unwrap().host_str().map(String::from);
    a.source_url = Some(url.into());
    a.state = "cached".into();
    a.media_provider = provider;
    a.own_sender = own;
    a
}

struct Fixture {
    dir: tempfile::TempDir,
    state: Arc<MediaState>,
    fetch: Arc<FakeFetch>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let fetch = Arc::new(FakeFetch::default());
        let state = MediaState::for_test(dir.path().join("inbox-media"), fetch.clone());
        std::fs::create_dir_all(state.dir()).unwrap();
        Self { dir, state, fetch }
    }
    fn store(&self, name: &str) -> PathBuf {
        let path = self
            .dir
            .path()
            .join("stores")
            .join(name)
            .join("weft.sqlite3");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        path
    }
    fn stores(&self) -> Vec<(LaunchTeam, PathBuf)> {
        ["a", "b"].map(|t| (team(t), self.store(t))).into()
    }
    fn send(&self, name: &str, attachments: &[Attachment]) -> i64 {
        let store = WeftStore::open(self.store(name)).unwrap();
        let id = inbox::inbox_insert(&store, "agent", "human", "hi", None, None, None, None, None)
            .unwrap();
        inbox::inbox_set_attachments(&store, id, attachments).unwrap();
        id
    }
    /// Write a disk cache file for `sha(n)`.
    fn cache(&self, n: u8) {
        std::fs::write(self.state.dir().join(sha(n)), gif(n)).unwrap();
    }
    fn cached(&self, n: u8) -> bool {
        self.state.dir().join(sha(n)).exists()
    }
    fn data(&self) -> PathBuf {
        self.dir.path().join("data")
    }
    /// A start: every team is indexed (as `synced_teams` does), then the purge runs.
    fn run(&self) -> Result<Purged, String> {
        for (team, path) in self.stores() {
            index_store(&self.state, &team, &path).unwrap();
        }
        run(&self.state, &self.stores(), &self.data())
    }
    /// Every column of every message in team `name`, as stored.
    fn records(&self, name: &str) -> Vec<Vec<String>> {
        let store = WeftStore::open(self.store(name)).unwrap();
        let conn = store.conn().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM wv_inbox ORDER BY id").unwrap();
        let columns = stmt.column_count();
        let records = stmt
            .query_map([], |r| {
                Ok((0..columns)
                    .map(|i| match r.get_ref(i).unwrap() {
                        rusqlite::types::ValueRef::Text(t) => {
                            String::from_utf8_lossy(t).into_owned()
                        }
                        other => format!("{other:?}"),
                    })
                    .collect::<Vec<String>>())
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        records
    }
}

#[tokio::test]
async fn the_purge_deletes_provider_files_once_and_backfills_only_media_provider() {
    let f = Fixture::new();
    let giphy = Some(MediaProvider::Giphy);
    let plain = Some(MediaProvider::None);
    // 1: provider only, an old message (no `mediaProvider`), sent from this machine.
    f.send("a", &[image(1, "https://i.giphy.com/one.gif", None, false)]);
    // 2: non-provider only.
    f.send("a", &[image(2, "https://example.com/two.gif", None, false)]);
    // 3: shared across teams by a non-provider and an old KLIPY attachment.
    f.send(
        "a",
        &[image(3, "https://example.com/three.gif", None, false)],
    );
    f.send(
        "b",
        &[image(3, "https://static.klipy.com/three.gif", None, false)],
    );
    // 4: a post-upgrade GIPHY reference sharing a sha with an old non-provider file.
    f.send(
        "a",
        &[image(4, "https://example.com/four.gif", plain, false)],
    );
    f.send(
        "b",
        &[image(4, "https://media.giphy.com/four.gif", giphy, true)],
    );
    for n in 1..=4 {
        f.cache(n);
    }
    let before = (f.records("a"), f.records("b"));

    assert!(matches!(
        f.run().unwrap(),
        Purged::Done { backfilled: 2, .. }
    ));
    assert!(
        !f.cached(1) && !f.cached(3) && !f.cached(4),
        "provider files go, shared ones too"
    );
    assert!(f.cached(2), "non-provider-only files are kept");
    assert!(f.data().join(MARKER).exists());

    // The backfill changed only `mediaProvider`: every other byte of every record is the same.
    let after = (f.records("a"), f.records("b"));
    for (before, after) in [(&before.0, &after.0), (&before.1, &after.1)] {
        assert_eq!(before.len(), after.len());
        for (b, a) in before.iter().zip(after) {
            let stripped: Vec<String> = a
                .iter()
                .map(|c| {
                    c.replace(r#","mediaProvider":"giphy""#, "")
                        .replace(r#","mediaProvider":"klipy""#, "")
                })
                .collect();
            assert_eq!(b, &stripped);
        }
    }
    let joined: String = after
        .0
        .iter()
        .chain(&after.1)
        .flatten()
        .map(String::as_str)
        .collect();
    assert_eq!(
        joined.matches(r#""mediaProvider":"giphy""#).count(),
        2,
        "1 backfilled, 4 kept"
    );
    assert_eq!(joined.matches(r#""mediaProvider":"klipy""#).count(), 1);
    assert_eq!(
        joined.matches(r#""mediaProvider":"none""#).count(),
        1,
        "never overwritten"
    );

    // A completed purge does nothing on the next start.
    f.cache(1);
    assert_eq!(
        run(&f.state, &f.stores(), &f.data()).unwrap(),
        Purged::AlreadyDone
    );
    assert!(f.cached(1), "the purge itself deletes nothing more");
}

#[tokio::test]
async fn an_old_own_machine_gif_lists_as_tap_to_load_and_a_tap_fetches_it_into_memory() {
    let f = Fixture::new();
    let url = "https://i.giphy.com/old.gif";
    let id = f.send("a", &[image(5, url, None, false)]);
    f.cache(5);
    f.run().unwrap();
    let store = WeftStore::open(f.store("a")).unwrap();
    let mut listed = inbox::inbox_get(&store, id).unwrap().unwrap().attachments;
    assert_eq!(listed[0].media_provider, Some(MediaProvider::Giphy));
    let config = Config::default();
    f.state.present(&config, &mut listed);
    assert_eq!(
        listed[0].state, "pending",
        "tap-to-load: no saved own sender"
    );
    assert_eq!(listed[0].reason.as_deref(), Some("sender"));
    f.fetch.serve(url, &gif(5), url, None);
    let tapped = f
        .state
        .fetch(&config, listed.remove(0), false)
        .await
        .unwrap();
    assert_eq!(tapped.state, "cached");
    assert!(!f.cached(5), "into memory, not onto disk");
    assert!(f.state.memory.contains(&sha(5), std::time::Instant::now()));
}

#[tokio::test]
async fn an_interrupted_purge_writes_no_marker_and_reruns() {
    let f = Fixture::new();
    f.send("a", &[image(6, "https://i.giphy.com/six.gif", None, false)]);
    // Backfilled by an earlier run that was interrupted before its marker.
    f.send(
        "b",
        &[image(
            7,
            "https://i.giphy.com/seven.gif",
            Some(MediaProvider::Giphy),
            false,
        )],
    );
    f.cache(7);
    // A deletion that fails: a directory where the file of sha 6 would be.
    std::fs::create_dir(f.state.dir().join(sha(6))).unwrap();
    assert!(f.run().is_err());
    assert!(!f.data().join(MARKER).exists());
    assert!(
        !format!("{:?}", f.records("a")).contains("mediaProvider"),
        "no backfill before every deletion succeeds"
    );
    std::fs::remove_dir(f.state.dir().join(sha(6))).unwrap();
    f.cache(6);
    // The next start, with a fresh index.
    let rerun = Fixture {
        dir: f.dir,
        state: MediaState::for_test(f.state.dir().to_path_buf(), f.fetch.clone()),
        fetch: f.fetch,
    };
    rerun.cache(7);
    assert!(matches!(rerun.run().unwrap(), Purged::Done { .. }));
    assert!(!rerun.cached(6) && !rerun.cached(7));
    assert!(rerun.data().join(MARKER).exists());
}

#[test]
fn no_marker_until_every_team_is_indexed() {
    let f = Fixture::new();
    f.send(
        "a",
        &[image(8, "https://i.giphy.com/eight.gif", None, false)],
    );
    index_store(&f.state, &team("a"), &f.store("a")).unwrap();
    // Team b's store is not in the index yet.
    assert!(run(&f.state, &f.stores(), &f.data()).is_err());
    assert!(!f.data().join(MARKER).exists());
}

#[test]
fn backfill_keeps_every_other_byte_and_never_overwrites() {
    let old = r#"[{"kind":"image","sha256":"ab","alt":"cat","sourceHost":"i.giphy.com","state":"cached","retryable":false}]"#;
    assert_eq!(
        backfill(old).unwrap(),
        old.replace(
            r#""retryable":false}"#,
            r#""retryable":false,"mediaProvider":"giphy"}"#
        )
    );
    let set = r#"[{"kind":"image","sha256":"ab","alt":"cat","sourceHost":"i.giphy.com","state":"cached","retryable":false,"mediaProvider":"none"}]"#;
    assert_eq!(backfill(set), None);
    let plain = r#"[{"kind":"image","sha256":"ab","alt":"cat","sourceHost":"example.com","state":"cached","retryable":false}]"#;
    assert_eq!(backfill(plain), None);
    let pending = r#"[{"kind":"image","alt":"cat","sourceHost":"i.giphy.com","state":"pending","retryable":false}]"#;
    assert_eq!(backfill(pending), None, "only attachments with a sha");
}
