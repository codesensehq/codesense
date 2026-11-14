// SPDX-License-Identifier: MIT
//! The `foreman.launch` capability: a page may open a `team-workspace` agent only when it is
//! one of the bundled pages that name an agent to start: the Foreman page and the setup guide's. It is deliberately outside [`super::capabilities::ALL`],
//! so no preset, declaration or per-dashboard override can hand it out; it is minted from the
//! page file's own bytes, at its own place in the placed docs checkout.
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub const CAPABILITY: &str = "foreman.launch";

/// A bundled page that holds the capability: its path inside the placed docs checkout
/// (`/`-separated), and the lowercase hex SHA-256 of its bytes. A page edited by one byte, or
/// a copy anywhere else, loses the grant. A page is one self-contained file (its kit and
/// config are inlined, and `foreman-page.node-test.mjs` refuses a sibling script or style), so
/// its hash covers everything it runs.
pub struct Page {
    pub path: &'static str,
    pub sha256: &'static str,
}

/// The pages that hold it. `scripts/foreman-page.mjs --check` and `scripts/guide-page.mjs
/// --check` (both in `gen:docs:check`) fail the build when a page here is not the bundled file,
/// so a docs update cannot drop the grant.
pub const PAGES: &[Page] = &[
    Page {
        path: "getting-started/content/foreman/index.html",
        sha256: "ff94132069b6e78fe2bc269be5e79c5c1c09bf01dadb659a505dfebeb775c8f2",
    },
    Page {
        path: "getting-started/content/guide/index.html",
        sha256: "fa6979a88e3e19a62d33c5b20b59e7ae4df9f847a7d9d7af1fb8b7173ab4b451",
    },
];

/// The agents a page holding the capability may launch: the Foreman and the setup guide, one
/// guide agent per runtime. The grant is defence in depth beside the page's hash, so a page
/// cannot start any other agent.
pub const AGENTS: &[&str] = &[
    "foreman-claude",
    "guide-claude",
    "guide-codex",
    "guide-opencode",
];

/// Whether a `team-workspace` open names an agent the page may launch. An open with no agent
/// would run the team's default agent, so it is refused too.
pub fn agent_allowed(agent: Option<&str>) -> bool {
    agent.is_some_and(|agent| AGENTS.contains(&agent))
}

/// The bundled Foreman page as this source tree ships it, for tests that place it in a docs root.
#[cfg(test)]
pub(crate) fn shipped_page() -> std::path::PathBuf {
    shipped_at(PAGES[0].path)
}

/// A bundled page by its `PAGES` path, as this source tree ships it.
#[cfg(test)]
pub(crate) fn shipped_at(path: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../codesense-docs")
        .join(path)
}

/// The grant a freshly minted frame holds, given the placed docs root.
pub fn grant_for(docs_root: &Path, document_path: &str) -> Option<String> {
    grant_in(PAGES, docs_root, document_path)
}

/// The document must sit at a page's path under `docs_root`, reached through plain segments
/// with no link or `..` below the root (a link could alias another file, and the viewer
/// re-resolves the path on every request), and carry that page's bytes. The path is checked
/// before the file is read.
pub fn grant_in(pages: &[Page], docs_root: &Path, document_path: &str) -> Option<String> {
    if pages.is_empty() {
        return None;
    }
    // The renderer may name the page through the canonical root (attached roots are stored
    // canonical) or the root as spelled here; either way only plain segments may follow it.
    let root = std::fs::canonicalize(docs_root).ok()?;
    let path = Path::new(document_path);
    let relative = path
        .strip_prefix(&root)
        .or_else(|_| path.strip_prefix(docs_root))
        .ok()?;
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let page = pages
        .iter()
        .find(|page| relative.to_string_lossy().replace('\\', "/") == page.path)?;
    let document = std::fs::canonicalize(document_path).ok()?;
    if document != root.join(relative) {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(std::fs::read(&document).ok()?));
    (page.sha256 == digest).then(|| CAPABILITY.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "getting-started/content/foreman/index.html";
    const BODY: &[u8] = b"<!doctype html><title>Foreman</title>";

    fn pages() -> Vec<Page> {
        let hash: &'static str = Box::leak(format!("{:x}", Sha256::digest(BODY)).into_boxed_str());
        vec![Page {
            path: PAGE,
            sha256: hash,
        }]
    }

    const GUIDE_PAGE: &str = "getting-started/content/guide/index.html";

    /// A docs root holding the page, and a second, unrelated dir.
    fn placed(body: &[u8]) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        placed_at(PAGE, body)
    }

    fn placed_at(
        at: &str,
        body: &[u8],
    ) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        let page = docs.join(at);
        std::fs::create_dir_all(page.parent().unwrap()).unwrap();
        std::fs::write(&page, body).unwrap();
        std::fs::create_dir_all(dir.path().join("team")).unwrap();
        (dir, docs, page)
    }

    #[test]
    fn the_page_at_its_place_with_its_bytes_holds_it() {
        let (_dir, docs, page) = placed(BODY);
        assert_eq!(
            grant_in(&pages(), &docs, &page.to_string_lossy()).as_deref(),
            Some(CAPABILITY)
        );
    }

    #[test]
    fn the_page_is_found_through_either_spelling_of_the_docs_root() {
        let (_dir, docs, page) = placed(BODY);
        let canonical_page = std::fs::canonicalize(&page).unwrap();
        let canonical_docs = std::fs::canonicalize(&docs).unwrap();
        for (root, document) in [(&docs, &canonical_page), (&canonical_docs, &page)] {
            assert_eq!(
                grant_in(&pages(), root, &document.to_string_lossy()).as_deref(),
                Some(CAPABILITY)
            );
        }
    }

    #[test]
    fn an_edited_page_is_refused() {
        let (_dir, docs, page) = placed(b"<!doctype html><title>Foreman</title> ");
        assert_eq!(grant_in(&pages(), &docs, &page.to_string_lossy()), None);
    }

    #[test]
    fn a_byte_identical_copy_outside_the_docs_root_is_refused() {
        let (dir, docs, _) = placed(BODY);
        // Same tail and bytes in a team's content: its siblings are not the bundle's.
        let copy = dir.path().join("team").join(PAGE);
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::write(&copy, BODY).unwrap();
        assert_eq!(grant_in(&pages(), &docs, &copy.to_string_lossy()), None);
        // Another place inside the docs root is refused too.
        let moved = docs.join("getting-started/content/other/index.html");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::write(&moved, BODY).unwrap();
        assert_eq!(grant_in(&pages(), &docs, &moved.to_string_lossy()), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_the_page_from_elsewhere_is_refused() {
        let (dir, docs, page) = placed(BODY);
        let link = dir.path().join("team").join("index.html");
        std::os::unix::fs::symlink(&page, &link).unwrap();
        assert_eq!(grant_in(&pages(), &docs, &link.to_string_lossy()), None);
        // A linked folder that reaches the page's folder from a team's content.
        let folder = dir.path().join("team").join("foreman");
        std::os::unix::fs::symlink(page.parent().unwrap(), &folder).unwrap();
        let aliased = folder.join("index.html");
        assert_eq!(grant_in(&pages(), &docs, &aliased.to_string_lossy()), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_the_docs_root_is_refused() {
        let (dir, docs, page) = placed(BODY);
        // The page's folder replaced by a link to a folder elsewhere with the same bytes.
        let elsewhere = dir.path().join("team").join("foreman");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("index.html"), BODY).unwrap();
        std::fs::remove_dir_all(page.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, page.parent().unwrap()).unwrap();
        assert_eq!(grant_in(&pages(), &docs, &page.to_string_lossy()), None);
    }

    #[test]
    fn a_path_with_dot_segments_is_refused() {
        let (_dir, docs, _) = placed(BODY);
        let dotted = docs.join("getting-started/content/other/../foreman/index.html");
        std::fs::create_dir_all(docs.join("getting-started/content/other")).unwrap();
        assert_eq!(grant_in(&pages(), &docs, &dotted.to_string_lossy()), None);
    }

    #[test]
    fn the_bundled_foreman_page_holds_it_at_its_place_and_nothing_else_does() {
        assert_eq!(
            PAGE, PAGES[0].path,
            "placed() writes at the bundled page's path"
        );
        // The shipped page, copied to its place in a placed docs root, holds the grant.
        let bytes =
            std::fs::read(shipped_page()).expect("the bundled Foreman page ships in the docs tree");
        let (_dir, docs, target) = placed(&bytes);
        assert_eq!(
            grant_for(&docs, &target.to_string_lossy()).as_deref(),
            Some(CAPABILITY)
        );
        // The same bytes at another place hold nothing, and neither does one more byte.
        let other = docs.join("getting-started/content/other/index.html");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, &bytes).unwrap();
        assert_eq!(grant_for(&docs, &other.to_string_lossy()), None);
        std::fs::write(&target, [bytes.as_slice(), b" "].concat()).unwrap();
        assert_eq!(grant_for(&docs, &target.to_string_lossy()), None);
    }

    #[test]
    fn only_the_foreman_and_the_setup_guide_may_be_launched() {
        assert!(agent_allowed(Some("foreman-claude")));
        for guide in ["guide-claude", "guide-codex", "guide-opencode"] {
            assert!(agent_allowed(Some(guide)), "{guide}");
        }
        assert!(!agent_allowed(Some("guide-hermes")));
        assert!(!agent_allowed(Some("dev-worker-claude")));
        assert!(!agent_allowed(Some("builtin/foreman-claude")));
        assert!(!agent_allowed(Some("")));
        // No agent would run the team's default agent.
        assert!(!agent_allowed(None));
    }

    #[test]
    fn exactly_the_foreman_page_and_the_guide_page_are_pinned() {
        let paths: Vec<&str> = PAGES.iter().map(|page| page.path).collect();
        assert_eq!(paths, [PAGE, GUIDE_PAGE]);
        assert!(!PAGES.is_empty());
    }

    #[test]
    fn every_pinned_page_hashes_to_its_entry() {
        // A page edited without its entry bumped fails here, not silently in the app.
        for page in PAGES {
            let bytes = std::fs::read(shipped_at(page.path))
                .unwrap_or_else(|_| panic!("{} ships in the docs tree", page.path));
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                page.sha256,
                "{}: update its PAGES hash (node scripts/guide-page.mjs --write)",
                page.path
            );
        }
    }

    #[test]
    fn the_bundled_guide_page_holds_it_at_its_place_and_nothing_else_does() {
        let bytes = std::fs::read(shipped_at(GUIDE_PAGE))
            .expect("the bundled guide page ships in the docs tree");
        let (_dir, docs, target) = placed_at(GUIDE_PAGE, &bytes);
        assert_eq!(
            grant_for(&docs, &target.to_string_lossy()).as_deref(),
            Some(CAPABILITY)
        );
        // The same bytes at another place hold nothing, and neither does one more byte.
        let other = docs.join("getting-started/content/other/index.html");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, &bytes).unwrap();
        assert_eq!(grant_for(&docs, &other.to_string_lossy()), None);
        std::fs::write(&target, [bytes.as_slice(), b" "].concat()).unwrap();
        assert_eq!(grant_for(&docs, &target.to_string_lossy()), None);
    }

    #[test]
    fn the_foreman_page_does_not_hold_the_guide_pages_place_and_the_reverse() {
        let foreman = std::fs::read(shipped_at(PAGE)).expect("the Foreman page ships");
        let guide = std::fs::read(shipped_at(GUIDE_PAGE)).expect("the guide page ships");
        // Each page's bytes at the other's path hold nothing: the entry is the pair, not the path.
        for (at, body) in [(PAGE, &guide), (GUIDE_PAGE, &foreman)] {
            let (_dir, docs, target) = placed_at(at, body);
            assert_eq!(grant_for(&docs, &target.to_string_lossy()), None, "{at}");
        }
    }

    #[test]
    fn it_is_not_in_the_grantable_vocabulary() {
        assert!(!super::super::capabilities::known(CAPABILITY));
    }
}
