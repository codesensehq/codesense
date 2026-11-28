// SPDX-License-Identifier: MIT
//! The `group` and `groups` topics: the group store's changes, for the host only.
//!
//! - `group`: one view per group, keyed `<org>:<id>`, holding the group's file as one row (or
//!   no row once it is deleted, and an "can't be read" row for a file the store can't read).
//! - `groups`: one view per context repo, keyed by its org slug, holding the index: one row
//!   per listed group with its owner and `rev`, no tree.
//!
//! Both are in [`HOST_ONLY_TOPICS`](super::projection::HOST_ONLY_TOPICS): no frame may subscribe,
//! page, unsubscribe or write UI state on them, and no first paint carries them, since a group's
//! tree names every tile a person has arranged. Nothing is published with the tiles flag off.

use serde_json::{json, Value};

use super::projection::{Delta, TopicRegistry};
use crate::groups::store::{GroupStore, Listed, Loaded, StoreError, UNREADABLE};

pub const GROUP: &str = "group";
pub const GROUPS: &str = "groups";

/// The `group` view of the group `id` in the context repo `org`. A group id holds no `:`, so the
/// last `:` splits the two.
pub fn group_view_key(org: &str, id: &str) -> String {
    format!("{org}:{id}")
}

/// The `group` view's rows: the file, or nothing once the group is gone.
fn group_rows(
    key: &str,
    id: &str,
    loaded: Result<Loaded, StoreError>,
) -> Result<Vec<(Option<String>, Value)>, String> {
    let row = match loaded {
        Ok(loaded) => json!({ "id": id, "file": loaded.file, "dropped": loaded.dropped }),
        Err(StoreError::Unreadable) => json!({ "id": id, "unreadable": UNREADABLE }),
        Err(StoreError::NotFound) => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    Ok(vec![(Some(key.to_owned()), row)])
}

/// The `groups` view's rows: one per listed group, without its tree.
fn groups_rows(key: &str, listed: Vec<Listed>) -> Vec<(Option<String>, Value)> {
    listed
        .into_iter()
        .map(|listed| {
            let row = match listed.file {
                Ok(file) => json!({ "id": listed.id, "owner": file.owner, "rev": file.rev }),
                Err(why) => json!({ "id": listed.id, "unreadable": why }),
            };
            (Some(key.to_owned()), row)
        })
        .collect()
}

/// Project the group `id` of `store` (the store of the context repo `org`) into the `group` and
/// `groups` views after a change to it. With `tiles` off, nothing is read or published.
pub fn project(
    registry: &mut TopicRegistry,
    tiles: bool,
    store: &GroupStore,
    org: &str,
    id: &str,
) -> Result<Vec<Delta>, String> {
    if !tiles {
        return Ok(vec![]);
    }
    let key = group_view_key(org, id);
    let mut deltas =
        TopicRegistry::replace_view(registry, GROUP, &key, group_rows(&key, id, store.load(id))?)?;
    let listed = store.list().map_err(|e| e.to_string())?;
    deltas.extend(TopicRegistry::replace_view(
        registry,
        GROUPS,
        org,
        groups_rows(org, listed),
    )?);
    Ok(deltas)
}

/// Publish a change to the group `id` of `store` to the host's subscribers, when the session's
/// tiles flag is on.
// The group writers call it in a later change; until then only the tests do.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn publish_change<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    store: &GroupStore,
    org: &str,
    id: &str,
) -> Result<(), String> {
    let tiles = tauri::Manager::try_state::<crate::flags::TilesFlag>(app)
        .is_some_and(|flag| crate::flags::TilesFlag::is_on(&flag));
    let hub = tauri::Manager::state::<super::LiveHub>(app);
    let deltas = {
        let mut model = hub.model.lock().map_err(|e| e.to_string())?;
        project(&mut model.projections, tiles, store, org, id)?
    };
    super::publish(app, deltas);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Principal;
    use crate::groups::shape::{OwnerKind, SavedNode};
    use crate::groups::store::Change;
    use crate::live_hub::projection::HOST_ONLY_TOPICS;
    use crate::live_hub::LiveHub;
    use tauri::Manager;

    const ORG: &str = "acme/ctx";

    fn store(home: &std::path::Path) -> GroupStore {
        GroupStore::at(home, &Principal::from(42u64), ORG, true).unwrap()
    }

    fn put(leaf: &str) -> Change {
        Change::Put {
            owner: OwnerKind::Group,
            root: Some(SavedNode::Leaf {
                id: leaf.into(),
                workspace_id: leaf.into(),
            }),
        }
    }

    #[test]
    fn the_two_topics_are_registered_and_host_only() {
        let mut registry = TopicRegistry::default();
        assert_eq!(HOST_ONLY_TOPICS, [GROUP, GROUPS]);
        for topic in HOST_ONLY_TOPICS {
            assert!(registry.subscribe(topic, "k", None).is_ok(), "{topic}");
        }
    }

    /// A store change publishes the file on `group` and the index on `groups`, and a host
    /// subscriber (no frame) receives each.
    #[test]
    fn a_store_change_reaches_a_host_subscriber_on_both_topics() {
        let home = tempfile::tempdir().unwrap();
        let store = store(home.path());
        let key = group_view_key(ORG, "focus");
        let mut registry = TopicRegistry::default();
        registry
            .subscribe_window("host-group", GROUP, &key, None, None)
            .unwrap();
        registry
            .subscribe_window("host-groups", GROUPS, ORG, None, None)
            .unwrap();

        let rev = store.commit("focus", 0, put("agent:core/dev")).unwrap();
        let deltas = project(&mut registry, true, &store, ORG, "focus").unwrap();
        let sent = registry.deliver(&deltas);
        let to = |id: &str| {
            sent.iter()
                .find(|(sub, _)| sub == id)
                .map(|(_, delta)| delta.clone())
                .unwrap_or_else(|| panic!("{id} got no delta"))
        };
        let group = to("host-group");
        assert_eq!(group.topic, GROUP);
        assert_eq!(group.upserts.len(), 1);
        assert_eq!(group.upserts[0]["id"], "focus");
        assert_eq!(group.upserts[0]["file"]["rev"], rev);
        assert_eq!(
            group.upserts[0]["file"]["root"]["workspaceId"],
            "agent:core/dev"
        );
        let groups = to("host-groups");
        assert_eq!(groups.topic, GROUPS);
        assert_eq!(groups.upserts[0]["id"], "focus");
        assert_eq!(groups.upserts[0]["owner"], "group");
        assert!(
            groups.upserts[0].get("file").is_none(),
            "the index holds no tree"
        );

        // A delete removes the group from both views.
        store.commit("focus", rev, Change::Delete).unwrap();
        let deltas = project(&mut registry, true, &store, ORG, "focus").unwrap();
        let sent = registry.deliver(&deltas);
        for id in ["host-group", "host-groups"] {
            let (_, delta) = sent.iter().find(|(sub, _)| sub == id).unwrap();
            assert_eq!(delta.removes, vec!["focus".to_owned()], "{id}");
        }
    }

    /// With the tiles flag off nothing is read or published, and no view is made.
    #[test]
    fn with_the_flag_off_nothing_is_published() {
        let home = tempfile::tempdir().unwrap();
        let store = store(home.path());
        store.commit("focus", 0, put("agent:core/dev")).unwrap();
        let mut registry = TopicRegistry::default();
        let deltas = project(&mut registry, false, &store, ORG, "focus").unwrap();
        assert!(deltas.is_empty());
        assert!(!registry.has_view(GROUP, &group_view_key(ORG, "focus")));
        assert!(!registry.has_view(GROUPS, ORG));
    }

    /// The app's publish reads the session's flag itself.
    #[test]
    fn the_app_publish_follows_the_session_flag() {
        let home = tempfile::tempdir().unwrap();
        let store = store(home.path());
        store.commit("focus", 0, put("agent:core/dev")).unwrap();
        let key = group_view_key(ORG, "focus");
        for on in [false, true] {
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            app.manage(LiveHub::default());
            app.manage(crate::flags::TilesFlag::fixed(on));
            publish_change(app.handle(), &store, ORG, "focus").unwrap();
            let hub = app.state::<LiveHub>();
            assert_eq!(hub.has_view(&key, GROUP), on, "flag {on}");
            if on {
                let snapshot = hub.snapshot(&key, GROUP).unwrap();
                assert_eq!(snapshot.snapshot[0]["file"]["owner"], "group");
            }
        }
    }

    /// A frame's subscribe to either topic is refused with a clear error and creates no
    /// subscription; the host's (no frame) succeeds; every other topic is admitted exactly as it
    /// was, frame or not.
    #[test]
    fn a_frame_subscribe_to_a_host_only_topic_is_refused() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(LiveHub::default());
        let key = group_view_key(ORG, "focus");
        for (topic, key) in [(GROUP, key.as_str()), (GROUPS, ORG)] {
            let refused = super::super::subscribe_held(
                app.handle(),
                topic,
                key,
                None,
                Some("frame-sub"),
                None,
                Some("main"),
                Some("frame-1"),
            )
            .err()
            .expect("a frame is refused");
            assert!(refused.contains("host-only"), "{refused}");
            assert!(refused.contains(topic), "{refused}");
            let hub = app.state::<LiveHub>();
            assert!(!hub
                .model
                .lock()
                .unwrap()
                .projections
                .has_subscription(topic, key));
            assert!(super::super::refuse_host_only(topic, Some("frame-1")).is_err());

            let host = super::super::subscribe_held(
                app.handle(),
                topic,
                key,
                None,
                Some("host-sub"),
                None,
                Some("main"),
                None,
            );
            assert!(host.is_ok(), "{topic}: {:?}", host.err());
            assert!(super::super::refuse_host_only(topic, None).is_ok());
        }
        for topic in ["files", "records", "stories", "prefs", "machineStats"] {
            assert!(super::super::refuse_host_only(topic, Some("frame-1")).is_ok());
        }
        for topic in [
            "sessions",
            "inbox",
            "agentList",
            "pins",
            "messageDelivery",
            "storyTotals",
            "ui:gif",
        ] {
            assert!(super::super::refuse_host_only(topic, Some("frame-1")).is_ok());
            let framed = super::super::subscribe_held(
                app.handle(),
                topic,
                "all",
                None,
                Some(&format!("frame-{topic}")),
                None,
                Some("main"),
                Some("frame-1"),
            );
            let host = super::super::subscribe_held(
                app.handle(),
                topic,
                "all",
                None,
                Some(&format!("host-{topic}")),
                None,
                Some("main"),
                None,
            );
            assert_eq!(
                framed.as_ref().err(),
                host.as_ref().err(),
                "{topic}: a frame's subscribe keeps its result"
            );
        }
    }
}
