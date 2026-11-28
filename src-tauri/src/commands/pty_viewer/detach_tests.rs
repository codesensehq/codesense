// SPDX-License-Identifier: MIT
//! A closed window's viewer is forgotten off the caller's thread, and a sweep on connect
//! forgets the viewers a crash or a disconnect left behind, under this install's prefix only.

use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug, PartialEq)]
enum Sent {
    Detach(ViewerId),
    Retain(Vec<ViewerId>, String),
}

/// A host that records what it is sent, optionally holding each detach until released.
struct FakeHost {
    forgets: bool,
    sent: Mutex<mpsc::Sender<Sent>>,
    hold: Mutex<Option<mpsc::Receiver<()>>>,
}

impl ViewerHost for FakeHost {
    fn forgets_viewers(&self) -> bool {
        self.forgets
    }

    fn forget_viewer(&self, viewer: &ViewerId) -> Result<(), String> {
        if let Some(hold) = self.hold.lock().unwrap().take() {
            hold.recv().unwrap();
        }
        self.sent
            .lock()
            .unwrap()
            .send(Sent::Detach(viewer.clone()))
            .unwrap();
        Ok(())
    }

    fn forget_viewers_but(&self, keep: &[ViewerId], prefix: &str) -> Result<(), String> {
        self.sent
            .lock()
            .unwrap()
            .send(Sent::Retain(keep.to_vec(), prefix.to_string()))
            .unwrap();
        Ok(())
    }
}

fn host(forgets: bool) -> (Arc<FakeHost>, mpsc::Receiver<Sent>) {
    let (sent, heard) = mpsc::channel();
    let host = FakeHost {
        forgets,
        sent: Mutex::new(sent),
        hold: Mutex::new(None),
    };
    (Arc::new(host), heard)
}

fn hosts(host: &Arc<FakeHost>) -> Vec<Arc<dyn ViewerHost>> {
    vec![host.clone() as Arc<dyn ViewerHost>]
}

fn viewer(label: &str) -> ViewerId {
    viewer_for(label, &InstallId::new("i1")).unwrap()
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn closing_a_window_forgets_its_viewer_off_the_callers_thread() {
    let boots = Boots::default();
    boots.adopt(&viewer("pane-x"), &ClientBootId::new("pane"));
    let (host, heard) = host(true);
    let (release, hold) = mpsc::channel();
    *host.hold.lock().unwrap() = Some(hold);

    // The host holds the request, and the caller still returns.
    let started = forget_window(&boots, hosts(&host), "pane-x", &InstallId::new("i1"));
    assert_eq!(started, 1);
    assert_eq!(boots.of(&viewer("pane-x")), None, "its boot slot is gone");
    assert!(heard.try_recv().is_err(), "not sent on the caller's thread");

    release.send(()).unwrap();
    assert_eq!(
        heard.recv_timeout(WAIT).unwrap(),
        Sent::Detach(viewer("pane-x"))
    );
}

#[test]
fn closing_a_window_asks_each_connected_host_once() {
    let (first, first_heard) = host(true);
    let (second, second_heard) = host(true);
    let both = vec![
        first.clone() as Arc<dyn ViewerHost>,
        second.clone() as Arc<dyn ViewerHost>,
    ];
    assert_eq!(
        forget_window(&Boots::default(), both, "pane-x", &InstallId::new("i1")),
        2
    );
    for heard in [first_heard, second_heard] {
        assert_eq!(
            heard.recv_timeout(WAIT).unwrap(),
            Sent::Detach(viewer("pane-x"))
        );
        assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
    }
}

#[test]
fn main_keeps_its_viewer() {
    let boots = Boots::default();
    boots.adopt(&main_viewer(), &ClientBootId::new("main"));
    let (host, heard) = host(true);
    assert_eq!(
        forget_window(&boots, hosts(&host), "main", &InstallId::new("i1")),
        0
    );
    assert_eq!(boots.of(&main_viewer()), Some(ClientBootId::new("main")));
    assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn an_unreadable_install_id_sends_nothing() {
    let (host, heard) = host(true);
    assert_eq!(
        forget_window(
            &Boots::default(),
            hosts(&host),
            "pane-x",
            &InstallId::unreadable()
        ),
        0
    );
    assert_eq!(
        sweep_host(&*host, &InstallId::unreadable(), &["pane-x".into()]),
        Ok(false)
    );
    assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn a_host_that_cannot_forget_viewers_is_never_asked() {
    let (old, old_heard) = host(false);
    let (new, new_heard) = host(true);
    let both = vec![
        old.clone() as Arc<dyn ViewerHost>,
        new.clone() as Arc<dyn ViewerHost>,
    ];
    assert_eq!(
        forget_window(&Boots::default(), both, "pane-x", &InstallId::new("i1")),
        1
    );
    assert_eq!(
        new_heard.recv_timeout(WAIT).unwrap(),
        Sent::Detach(viewer("pane-x"))
    );
    assert_eq!(sweep_host(&*old, &InstallId::new("i1"), &[]), Ok(false));
    assert!(old_heard.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn a_sweep_keeps_mains_and_the_kept_windows_under_this_installs_prefix() {
    let (host, heard) = host(true);
    let keep = ["main".to_string(), "pane-x".to_string()];
    assert_eq!(sweep_host(&*host, &InstallId::new("i1"), &keep), Ok(true));
    let Sent::Retain(kept, prefix) = heard.recv_timeout(WAIT).unwrap() else {
        panic!("a sweep is one retain request");
    };
    assert_eq!(kept, vec![viewer("pane-x")]);
    assert_eq!(prefix, "app:i1:");
    // The prefix never reaches main's viewer, the dashboard's or another install's windows.
    for other in [
        main_viewer(),
        ViewerId::new("dashboard"),
        viewer_for("pane-x", &InstallId::new("i2")).unwrap(),
    ] {
        assert!(!other.as_str().starts_with(&prefix), "{other}");
    }
    assert!(viewer("pane-y").as_str().starts_with(&prefix));
}

#[test]
fn a_window_closed_while_its_host_was_offline_is_swept_on_reconnect() {
    let install = InstallId::new("i1");
    // Offline: no connected host to ask.
    assert_eq!(
        forget_window(&Boots::default(), Vec::new(), "pane-x", &install),
        0
    );
    // On reconnect only main is open, so pane-x's viewer is not kept under the prefix.
    let (host, heard) = host(true);
    assert_eq!(sweep_host(&*host, &install, &["main".into()]), Ok(true));
    let Sent::Retain(kept, prefix) = heard.recv_timeout(WAIT).unwrap() else {
        panic!("a sweep is one retain request");
    };
    assert!(kept.is_empty());
    assert!(viewer("pane-x").as_str().starts_with(&prefix));
}
