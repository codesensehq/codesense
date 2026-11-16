// SPDX-License-Identifier: MIT

use super::*;
#[test]
fn unknown_pane_list_hides_team_manifests_but_keeps_private_content() {
    use crate::context_repo::caller_scope::{tests::Fixture, CallerScope};
    let f = Fixture::new();
    f.write(
            "parent",
            "panes/pane-manifest.yaml",
            "version: 1\npanes:\n  - id: parent\n    html: parent.html\n    title: Hidden manifest sentinel\n",
        );
    let me = Principal::from(1u64);
    let space = crate::context_repo::scratch_space::ensure_org_space(&f.home, &me, "acme/ctx")
        .unwrap()
        .0;
    std::fs::create_dir_all(space.panes_dir()).unwrap();
    std::fs::write(
        space.panes_dir().join("personal.html"),
        "<title>Private positive</title>",
    )
    .unwrap();
    std::fs::write(
            space.panes_dir().join(panes::manifest::MANIFEST_FILE),
            "version: 1\npanes:\n  - id: personal\n    html: personal.html\n    title: Private manifest positive\n",
        )
        .unwrap();
    let read = |scope: &CallerScope| {
        serde_json::to_value(list_for(&f.home, &me, "acme/ctx", "parent", scope).unwrap()).unwrap()
    };
    let unknown = read(&CallerScope::Unknown).to_string();
    assert!(!unknown.contains("Hidden manifest sentinel"));
    assert!(unknown.contains("personal.html"));
    assert!(unknown.contains("Private manifest positive"));
    assert!(read(&CallerScope::Human)
        .to_string()
        .contains("Hidden manifest sentinel"));
    std::fs::remove_file(f.path("parent", "panes/pane-manifest.yaml")).unwrap();
    assert_eq!(unknown, read(&CallerScope::Unknown).to_string());
}
#[test]
fn pane_fallback_precedence_runs_after_caller_filtering() {
    use crate::context_repo::caller_scope::{tests::Fixture, CallerScope};
    let f = Fixture::new();
    let me = Principal::from(1u64);
    let read = |scope: &CallerScope| {
        let ToolEnvelope::Ok(listing) =
            list_for(&f.home, &me, "acme/ctx", "parent", scope).unwrap()
        else {
            panic!("listing")
        };
        listing
            .panes
            .into_iter()
            .filter(|pane| pane.id == "inbox")
            .collect::<Vec<_>>()
    };
    assert_eq!(
        read(&f.scope)[0].dashboard_ref.scope,
        panes::DashboardScope::BuiltIn
    );
    f.write(
        "parent",
        "panes/inbox.html",
        "<html><head><title>Hidden Inbox</title></head><body>Private</body></html>",
    );
    let denied = read(&CallerScope::Unknown);
    std::fs::remove_file(f.path("parent", "panes/inbox.html")).unwrap();
    assert_eq!(denied, read(&CallerScope::Unknown));
    let private = crate::context_repo::scratch_space::ensure_org_space(&f.home, &me, "acme/ctx")
        .unwrap()
        .0;
    std::fs::create_dir_all(private.panes_dir()).unwrap();
    std::fs::write(
        private.panes_dir().join("inbox.html"),
        "<html><head><title>Private Inbox</title></head><body>Own</body></html>",
    )
    .unwrap();
    let own = read(&f.scope);
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].title, "Private Inbox");
}
#[test]
fn other_org_same_named_team_is_refused_and_own_manifest_aliases_follow_the_real_owner() {
    use crate::context_repo::caller_scope::{tests::Fixture, CallerScope};
    let f = Fixture::new();
    let me = Principal::from(1u64);
    let org = "other/ctx";
    let root = crate::context_repo::path_to_org_root(&f.home, &me, org).unwrap();
    std::fs::create_dir_all(root.join("parent/panes")).unwrap();
    std::fs::create_dir_all(root.join("parent/content")).unwrap();
    for name in ["org.yml", "people.yml", "teams.yml"] {
        let text = std::fs::read_to_string(f.root.join(name))
            .unwrap()
            .replace("acme/ctx", org);
        std::fs::write(root.join(name), text).unwrap();
    }
    std::fs::write(
        root.join("parent/panes/report.html"),
        "<title>HTML fallback</title>",
    )
    .unwrap();
    std::fs::write(root.join("parent/panes/pane-manifest.yaml"), "version: 1\npanes:\n  - id: report\n    html: report.html\n    title: Other org report\n    icon: chart-bar\n").unwrap();
    // The other org's private space holds a pane and a manifest too.
    let private = crate::context_repo::scratch_space::ensure_org_space(&f.home, &me, org)
        .unwrap()
        .0;
    std::fs::create_dir_all(private.panes_dir()).unwrap();
    std::fs::write(
        private.panes_dir().join("leaked.html"),
        "<title>Other org private sentinel</title>",
    )
    .unwrap();
    std::fs::write(
        private.panes_dir().join(panes::manifest::MANIFEST_FILE),
        "version: 1\npanes:\n  - id: leaked\n    html: leaked.html\n    title: Other org private sentinel\n",
    )
    .unwrap();
    let listing = |org: &str, team: &str, scope: &CallerScope| {
        let ToolEnvelope::Ok(listing) = list_for(&f.home, &me, org, team, scope).unwrap() else {
            panic!("listing refused");
        };
        listing
    };
    let panes = |org: &str, team: &str, scope: &CallerScope| listing(org, team, scope).panes;
    let read = |org: &str, team: &str, scope: &CallerScope| {
        panes(org, team, scope)
            .into_iter()
            .find(|pane| pane.id == "report")
    };
    assert_eq!(
        read(org, "parent", &CallerScope::Human).unwrap().title,
        "Other org report"
    );
    // The planted layers are real: a human sees the other org's private pane and both
    // its team and private manifest layers, so the refusals below are not vacuous.
    let human = listing(org, "parent", &CallerScope::Human);
    assert!(human
        .panes
        .iter()
        .any(|pane| pane.id == "leaked" && pane.scope == PaneScope::Private));
    for layer_scope in [PaneScope::Team, PaneScope::Private] {
        assert!(
            human
                .manifests
                .iter()
                .any(|layer| layer.scope == layer_scope),
            "{layer_scope:?}"
        );
    }
    // A team agent reads only its own org, even where a team shares its ancestor's name.
    // Only built-ins are listed: no team or private pane of the other org shows,
    // and neither manifest layer comes with them.
    let agent = listing(org, "parent", &f.scope);
    assert!(!agent.panes.is_empty());
    assert!(
        agent
            .panes
            .iter()
            .all(|pane| pane.dashboard_ref.scope == panes::DashboardScope::BuiltIn),
        "{:?}",
        agent.panes
    );
    assert!(
        agent.panes.iter().all(|pane| pane.id != "leaked"),
        "{:?}",
        agent.panes
    );
    assert!(agent.manifests.is_empty(), "{:?}", agent.manifests);
    // In the agent's own team a manifest is read, but not one aliasing another
    // team's unshared file: the real owner decides.
    f.write("child", "panes/report.html", "<title>HTML fallback</title>");
    f.write("child", "panes/pane-manifest.yaml", "version: 1\npanes:\n  - id: report\n    html: report.html\n    title: Own manifest title\n");
    assert_eq!(
        read("acme/ctx", "child", &f.scope).unwrap().title,
        "Own manifest title"
    );
    #[cfg(unix)]
    {
        let manifest = f.path("child", "panes/pane-manifest.yaml");
        let hidden = f.write("parent", "config/private-manifest.yaml", "version: 1\npanes:\n  - id: report\n    html: report.html\n    title: Hidden parent title\n");
        std::fs::remove_file(&manifest).unwrap();
        std::os::unix::fs::symlink(&hidden, &manifest).unwrap();
        let denied = read("acme/ctx", "child", &f.scope).unwrap();
        assert_eq!(denied.title, "HTML fallback");
        std::fs::remove_file(&manifest).unwrap();
        assert_eq!(Some(denied), read("acme/ctx", "child", &f.scope));
    }
    assert!(f
        .scope
        .existing(&f.path("parent", "content/shared.md"))
        .is_ok());
}
