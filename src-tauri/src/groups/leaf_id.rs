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
    if let Some(dir) = leaf.strip_prefix(GENERIC_PREFIX) {
        if let Some(why) = generic_dir_problem(dir) {
            return Some(format!("{leaf:?}: {why}"));
        }
        return machine_local(leaf, layer);
    }
    if is_local_id(leaf) {
        return machine_local(leaf, layer);
    }
    Some(format!(
        "{leaf:?}: not a tile ref (agent:, doc:, generic:, a workspace or a terminal tab id)"
    ))
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
        for leaf in ["agent:core/dev", "doc:core/notes/plan.md"] {
            assert_eq!(leaf_ref_problem(leaf, Layer::Private), None);
            assert_eq!(leaf_ref_problem(leaf, Layer::Shared), None);
        }
        for leaf in [
            "ws-1a2b",
            "tab_9",
            "SV-WF-63-cli-overlay.story",
            "generic:/Users/me/code",
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
