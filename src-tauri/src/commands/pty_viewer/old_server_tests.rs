// SPDX-License-Identifier: MIT
//! A terminal server from before viewer detach is never sent one: terminals cannot move
//! between windows on it, and closing or sweeping a window sends it nothing.

use super::*;
use crate::terminal::session_server::tests::mock_sidecar;
use codesense_session_server::testing::{short_root, RecordingSink, TestServer};

fn connect(root: &std::path::Path) -> Arc<SessionServerClient> {
    SessionServerClient::connect(
        root,
        Arc::new(RecordingSink::default()),
        Arc::default(),
        None,
    )
    .unwrap()
}

#[test]
fn a_server_without_viewer_detach_is_sent_nothing() {
    let root = short_root();
    let mock = mock_sidecar(root.path(), 1, |_, _, _| {});
    let client = connect(root.path());
    let install = InstallId::new("i1");

    assert_eq!(
        can_move_terminals(&*client),
        Err(UPDATE_TO_MOVE.to_string())
    );
    let hosts = vec![client.clone() as Arc<dyn ViewerHost>];
    assert_eq!(
        forget_window(&Boots::default(), hosts, "pane-x", &install),
        0
    );
    assert_eq!(sweep_host(&*client, &install, &[]), Ok(false));
    // Asked directly, the client still sends nothing and reports no error.
    assert_eq!(
        client.forget_viewer(&viewer_for("pane-x", &install).unwrap()),
        Ok(())
    );

    drop(client);
    assert!(mock.join().unwrap().is_empty(), "nothing was sent");
}

#[test]
fn a_current_server_forgets_viewers() {
    let root = short_root();
    let _server = TestServer::start_at(root.path());
    let client = connect(root.path());
    let install = InstallId::new("i1");

    assert_eq!(can_move_terminals(&*client), Ok(()));
    assert_eq!(
        client.forget_viewer(&viewer_for("pane-x", &install).unwrap()),
        Ok(())
    );
    assert_eq!(sweep_host(&*client, &install, &["pane-y".into()]), Ok(true));
}
