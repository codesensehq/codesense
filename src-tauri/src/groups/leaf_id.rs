// SPDX-License-Identifier: MIT
//! The leaf-id grammar: the one check of a tile ref before it is stored.
//!
//! A tile ref is the tiling kit's opaque leaf id (`leafId` in
//! `src/shared/tiling/mosaic-tree.ts`). Its kinds:
//!
//! - `agent:<team>/<name>`: portable, valid in any layer.
//! - `doc:<team>/<team-relative path>`: portable, valid in any layer. The path is normalized:
//!   forward slashes only, no empty, `.` or `..` segment, and no absolute or drive-letter path,
//!   backslash, `~`, NUL, control character or scheme.
//! - `generic:<absolute directory>`: the id of a generic workspace, machine-local and valid
//!   only in the private layer. The directory is absolute (`/…` or a drive letter), local (no
//!   leading `//`, `/\`, `\\` or `\/`, which Windows reads as a network share) and holds no
//!   control character.
//! - a workspace id or a terminal tab id (`[A-Za-z0-9._-]{1,128}`, no prefix, not only dots):
//!   machine-local, valid only in the private layer, which never pushes. A story workspace's id
//!   is the story's file stem, which holds dots.
//! - the viewer's prefixed workspace ids, machine-local and valid only in the private layer:
//!   `root:<owner>/<repo>` or `root:<name>` (a repo's root workspace), `story:<local id>`, and
//!   `integration:<epic doc path>` (an epic's terminal, keyed on the epic's doc path, absolute
//!   on this machine and held to the generic directory's rules) or `integration:<epic>[:<repo>]`
//!   (the epic's folder name and a repo). Each other part keeps the local id's charset and
//!   length bound.
//!
//! - a content tab's key, one per kind a tile shows besides agents, docs and terminals:
//!   - `story-page:<story id>` (a story's page) and `inbox:<org>` (an org's Inbox): portable,
//!     valid in any layer;
//!   - `dashboard:<scope>:<org>[:<team>]/<pane id>`: a `built-in` or `team` dashboard is
//!     portable; a `private` one names the person's own pane and stays in the private layer;
//!   - `diff:<context|source>:<worktree id>` (a worktree's diff) and `notes:<note id>` (a
//!     scratch note): machine-local, valid only in the private layer.
//!
//!   A story, worktree or note id keeps the local id's charset and length bound; an org is
//!   `<owner>/<name>` or `<name>`, each part a local id; a pane id is `[a-z0-9][a-z0-9-]*`.
//!
//! A team and a name are `[a-z0-9][a-z0-9._-]{0,63}`. Any other prefix or shape is refused.
//! The cases live in one fixture, `tests/fixtures/leaf-keys.json`, which other checks of a
//! tile key read too.

/// Where a ref is stored. A shared layer is any layer a clone pushes or syncs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Private,
    Shared,
}

const AGENT_PREFIX: &str = "agent:";
const DOC_PREFIX: &str = "doc:";
const GENERIC_PREFIX: &str = "generic:";
const ROOT_PREFIX: &str = "root:";
const STORY_PREFIX: &str = "story:";
const INTEGRATION_PREFIX: &str = "integration:";
const STORY_PAGE_PREFIX: &str = "story-page:";
const INBOX_PREFIX: &str = "inbox:";
const DASHBOARD_PREFIX: &str = "dashboard:";
const DIFF_PREFIX: &str = "diff:";
const NOTES_PREFIX: &str = "notes:";
const GENERIC_PATH_MAX: usize = 4096;
const LOCAL_ID_MAX: usize = 128;
const SEGMENT_MAX: usize = 64;

/// Why `leaf` can't be stored in `layer`, or `None` when it can.
pub fn leaf_ref_problem(leaf: &str, layer: Layer) -> Option<String> {
    if let Some(rest) = leaf.strip_prefix(AGENT_PREFIX) {
        let Some((team, name)) = rest.split_once('/') else {
            return Some(format!("{leaf:?}: an agent ref is agent:<team>/<name>"));
        };
        return team_problem(leaf, team).or_else(|| {
            (!is_segment(name)).then(|| format!("{leaf:?}: the agent name is not valid"))
        });
    }
    if let Some(rest) = leaf.strip_prefix(DOC_PREFIX) {
        let Some((team, path)) = rest.split_once('/') else {
            return Some(format!("{leaf:?}: a doc ref is doc:<team>/<path>"));
        };
        return team_problem(leaf, team).or_else(|| doc_path_problem(leaf, path));
    }
    if let Some(problem) = content_tab_problem(leaf) {
        return match problem {
            Err(why) => Some(format!("{leaf:?}: {why}")),
            Ok(Reach::Portable) => None,
            Ok(Reach::Private) => private_only(leaf, layer),
        };
    }
    if let Some(dir) = leaf.strip_prefix(GENERIC_PREFIX) {
        if let Some(why) = generic_dir_problem(dir) {
            return Some(format!("{leaf:?}: {why}"));
        }
        return machine_local(leaf, layer);
    }
    if let Some(problem) = prefixed_workspace_problem(leaf) {
        return match problem {
            Some(why) => Some(format!("{leaf:?}: {why}")),
            None => machine_local(leaf, layer),
        };
    }
    if is_local_id(leaf) {
        return machine_local(leaf, layer);
    }
    Some(format!(
        "{leaf:?}: not a tile ref (agent:, doc:, story-page:, inbox:, dashboard:, diff:, notes:, \
         generic:, root:, story:, integration:, a workspace or a terminal tab id)"
    ))
}

/// Which layers a valid content tab's key may be stored in.
enum Reach {
    Portable,
    Private,
}

/// For a content tab's key, why its rest is refused or where it may be stored; `None` for any
/// other ref.
fn content_tab_problem(leaf: &str) -> Option<Result<Reach, &'static str>> {
    let check = |valid: bool, reach: Reach, why: &'static str| {
        Some(if valid { Ok(reach) } else { Err(why) })
    };
    if let Some(story) = leaf.strip_prefix(STORY_PAGE_PREFIX) {
        return check(
            is_local_id(story),
            Reach::Portable,
            "a story page ref is story-page:<story id>",
        );
    }
    if let Some(org) = leaf.strip_prefix(INBOX_PREFIX) {
        return check(
            is_repo_slug(org),
            Reach::Portable,
            "an inbox ref is inbox:<org>",
        );
    }
    if let Some(rest) = leaf.strip_prefix(DIFF_PREFIX) {
        let valid = match rest.split_once(':') {
            Some(("context" | "source", id)) => is_local_id(id),
            _ => false,
        };
        return check(
            valid,
            Reach::Private,
            "a diff ref is diff:<context|source>:<worktree id>",
        );
    }
    if let Some(id) = leaf.strip_prefix(NOTES_PREFIX) {
        return check(
            is_local_id(id),
            Reach::Private,
            "a notes ref is notes:<note id>",
        );
    }
    if let Some(rest) = leaf.strip_prefix(DASHBOARD_PREFIX) {
        return Some(dashboard_reach(rest).ok_or(
            "a dashboard ref is dashboard:<built-in|private>:<org>/<pane id> or \
             dashboard:team:<org>:<team>/<pane id>",
        ));
    }
    None
}

/// Where a `dashboard:` ref's rest may be stored, or `None` when it is not valid. An org may
/// hold `/`; a pane id never does.
fn dashboard_reach(rest: &str) -> Option<Reach> {
    let (scope, owner) = rest.split_once(':')?;
    let (owner, id) = owner.rsplit_once('/')?;
    if !crate::panes::is_valid_pane_id(id) {
        return None;
    }
    match scope {
        "built-in" => is_repo_slug(owner).then_some(Reach::Portable),
        "private" => is_repo_slug(owner).then_some(Reach::Private),
        "team" => {
            let (org, team) = owner.rsplit_once(':')?;
            (is_repo_slug(org) && is_segment(team)).then_some(Reach::Portable)
        }
        _ => None,
    }
}

/// A key that names this machine's or this person's own things: the private layer only.
fn private_only(leaf: &str, layer: Layer) -> Option<String> {
    match layer {
        Layer::Private => None,
        Layer::Shared => Some(format!(
            "{leaf:?}: a diff, notes or private dashboard ref is this machine's or this person's \
             own and stays in the private layer"
        )),
    }
}

/// A machine-local ref is valid in the private layer only.
fn machine_local(leaf: &str, layer: Layer) -> Option<String> {
    match layer {
        Layer::Private => None,
        Layer::Shared => Some(format!(
            "{leaf:?}: a workspace or terminal tab id is machine-local and stays in the private layer"
        )),
    }
}

/// The directory of a `generic:` ref: absolute, no control character, bounded.
fn generic_dir_problem(dir: &str) -> Option<&'static str> {
    let bytes = dir.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\');
    if !(dir.starts_with('/') || drive) {
        return Some("a generic workspace ref holds an absolute directory");
    }
    if ["//", "/\\", "\\\\", "\\/"]
        .iter()
        .any(|unc| dir.starts_with(unc))
    {
        return Some("a generic workspace directory is local, not a UNC or network path");
    }
    if dir.len() > GENERIC_PATH_MAX {
        return Some("the generic workspace directory is too long");
    }
    if dir.chars().any(|c| c.is_control()) {
        return Some("the generic workspace directory holds a control character");
    }
    dir.split(['/', '\\'])
        .any(|segment| matches!(segment, "." | ".."))
        .then_some("the generic workspace directory holds a . or .. segment")
}

/// For a viewer workspace id with a `root:`, `story:` or `integration:` prefix, why its rest is
/// refused (`Some(None)` when it is valid); `None` for any other ref.
fn prefixed_workspace_problem(leaf: &str) -> Option<Option<&'static str>> {
    if let Some(rest) = leaf.strip_prefix(ROOT_PREFIX) {
        return Some(
            (!is_repo_slug(rest))
                .then_some("a root workspace ref is root:<owner>/<repo> or root:<name>"),
        );
    }
    if let Some(rest) = leaf.strip_prefix(STORY_PREFIX) {
        return Some((!is_local_id(rest)).then_some("a story workspace ref is story:<local id>"));
    }
    if let Some(rest) = leaf.strip_prefix(INTEGRATION_PREFIX) {
        // The viewer keys an epic's workspace on its doc path, absolute on this machine, and a
        // per-repo one on the epic's folder name and the repo.
        let valid = generic_dir_problem(rest).is_none()
            || match rest.split_once(':') {
                Some((epic, repo)) => is_local_id(epic) && is_repo_slug(repo),
                None => is_local_id(rest),
            };
        return Some((!valid).then_some(
            "an integration workspace ref is integration:<absolute epic doc path> or integration:<epic>[:<repo>]",
        ));
    }
    None
}

/// A repo as the viewer names it: `<owner>/<repo>` or `<name>`, each part a local id.
fn is_repo_slug(slug: &str) -> bool {
    let parts: Vec<&str> = slug.split('/').collect();
    parts.len() <= 2 && Iterator::all(&mut parts.iter(), |part| is_local_id(part))
}

/// A team or agent name: `[a-z0-9][a-z0-9._-]{0,63}`.
fn is_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    segment.len() <= SEGMENT_MAX
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && !chars.any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)))
}

fn team_problem(leaf: &str, team: &str) -> Option<String> {
    (!is_segment(team)).then(|| format!("{leaf:?}: the team is not valid"))
}

/// A team-relative path, normalized and holding no local path.
fn doc_path_problem(leaf: &str, path: &str) -> Option<String> {
    let refuse = |why: &str| Some(format!("{leaf:?}: {why}"));
    if str::is_empty(path) {
        return refuse("the doc path is empty");
    }
    if path.chars().any(|c| c.is_control()) {
        return refuse("the doc path holds a control character");
    }
    if path.contains('\\') {
        return refuse("the doc path holds a backslash");
    }
    if path.contains('~') {
        return refuse("the doc path holds ~");
    }
    if path.contains(':') {
        return refuse("the doc path holds a scheme or drive letter");
    }
    if path
        .split('/')
        .any(|segment| matches!(segment, "" | "." | ".."))
    {
        return refuse("the doc path is not normalized (an empty, . or .. segment)");
    }
    None
}

/// A workspace id or terminal tab id: `[A-Za-z0-9._-]{1,128}`, not only dots.
fn is_local_id(leaf: &str) -> bool {
    !str::is_empty(leaf)
        && leaf.len() <= LOCAL_ID_MAX
        && leaf.chars().any(|c| c != '.')
        && !leaf
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "._-".contains(c)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        leaf: String,
        layer: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct Fixture {
        refs: Vec<Row>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../../../tests/fixtures/leaf-keys.json")).unwrap()
    }

    fn layer(name: &str) -> Layer {
        match name {
            "private" => Layer::Private,
            "shared" => Layer::Shared,
            other => panic!("unknown layer {other}"),
        }
    }

    /// Every fixture row: the accepting rows pass and each refusing row says why.
    #[test]
    fn every_fixture_row_is_accepted_or_refused_as_listed() {
        let rows = fixture().refs;
        assert!(rows.len() >= 20, "the fixture holds the grammar's rows");
        for row in rows {
            let problem = leaf_ref_problem(&row.leaf, layer(&row.layer));
            assert_eq!(
                problem.is_none(),
                row.valid,
                "{:?} in {}: {problem:?}",
                row.leaf,
                row.layer
            );
        }
    }

    /// The portable kinds are valid in both layers; the machine-local kinds only in the private one.
    #[test]
    fn the_layer_decides_only_the_machine_local_kinds() {
        for leaf in [
            "agent:core/dev",
            "doc:core/notes/plan.md",
            "story-page:DEMO-63",
            "inbox:acme",
            "dashboard:built-in:acme/inbox",
            "dashboard:team:acme/app:core/board",
        ] {
            assert_eq!(leaf_ref_problem(leaf, Layer::Private), None);
            assert_eq!(leaf_ref_problem(leaf, Layer::Shared), None);
        }
        for leaf in [
            "ws-1a2b",
            "tab_9",
            "DEMO-63-cli-overlay.story",
            "generic:/home/me/code",
            "root:acme/app",
            "story:ab-12-cli-overlay.story",
            "integration:/home/me/org/_epic/demo/README.md",
            "integration:demo:acme/app",
            "diff:context:ctx-demo",
            "notes:scratch",
            "dashboard:private:acme/board",
        ] {
            assert_eq!(leaf_ref_problem(leaf, Layer::Private), None);
            assert!(leaf_ref_problem(leaf, Layer::Shared).is_some());
        }
    }

    /// A property check over generated refs: no accepted doc ref holds a local path, and every
    /// accepted ref has one of the four kinds.
    #[test]
    fn no_accepted_ref_holds_a_local_path() {
        let parts = [
            "", ".", "..", "a", "b.md", "~", "C:", "a\\b", "file:", "http:", "x\0", "notes", "/",
            "Z", "a-b", "_",
        ];
        let mut checked = 0;
        for prefix in ["agent:", "doc:", "", "tab:", "doc:/", "agent:core/"] {
            for a in parts {
                for b in parts {
                    for c in ["", "/", "/plan.md", "//x"] {
                        let leaf = format!("{prefix}{a}/{b}{c}");
                        for layer in [Layer::Private, Layer::Shared] {
                            checked += 1;
                            if leaf_ref_problem(&leaf, layer).is_some() {
                                continue;
                            }
                            if let Some(path) = leaf.strip_prefix("doc:") {
                                let path = path.split_once('/').unwrap().1;
                                assert!(!path.starts_with('/'), "{leaf:?}");
                                assert!(!path.contains(['\\', '~', ':', '\0']), "{leaf:?}");
                                assert!(
                                    path.split('/').all(|s| !matches!(s, "" | "." | "..")),
                                    "{leaf:?}"
                                );
                            } else {
                                assert!(leaf.starts_with("agent:"), "{leaf:?}");
                            }
                        }
                    }
                }
            }
        }
        assert!(checked > 1000);
    }

    #[test]
    fn a_refusal_names_the_ref() {
        let why = leaf_ref_problem("doc:team/a\\b", Layer::Private).unwrap();
        assert!(why.contains("doc:team/a\\\\b"), "{why}");
        assert!(why.contains("backslash"), "{why}");
    }
}
