// SPDX-License-Identifier: MIT
//! Only `main`'s layout reads have app-wide effects.

use super::*;

#[test]
fn another_windows_first_read_has_no_app_wide_effect() {
    let boots = Boots::default();
    let pane = viewer_for("pane-x", &InstallId::new("i1")).unwrap();
    let read = layout_read(&boots, &pane, &ClientBootId::new("pane"));
    assert_eq!(
        read,
        LayoutRead {
            new_boot: true,
            app_wide: false,
        }
    );
    assert!(
        !read.announces(),
        "no sessions-source-changed, no connection re-sync"
    );
    assert_eq!(boots.of(&main_viewer()), None, "main's slot is untouched");
    // A reload of the window is still no app-wide effect.
    assert!(!layout_read(&boots, &pane, &ClientBootId::new("reload")).app_wide);
}

#[test]
fn mains_first_read_announces_restores_and_claims() {
    let boots = Boots::default();
    let read = layout_read(&boots, &main_viewer(), &ClientBootId::new("first"));
    assert_eq!(
        read,
        LayoutRead {
            new_boot: true,
            app_wide: true,
        }
    );
    assert!(read.announces());
    // Polling under the same boot restores and claims, and announces nothing.
    let again = layout_read(&boots, &main_viewer(), &ClientBootId::new("first"));
    assert!(again.app_wide && !again.new_boot && !again.announces());
}
