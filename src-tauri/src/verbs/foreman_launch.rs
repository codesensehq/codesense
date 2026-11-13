// SPDX-License-Identifier: MIT
//! The `foreman.launch` capability: a page may open a `team-workspace` agent only when it is
//! one of the bundled Foreman pages. It is deliberately outside [`super::capabilities::ALL`],
//! so no preset, declaration or per-dashboard override can hand it out; it is minted from the
//! page file's own bytes, at its own place in the placed docs checkout.
use sha2::{Digest, Sha256};
use std::path::Path;

pub const CAPABILITY: &str = "foreman.launch";

/// A bundled page that holds the capability: its path inside the placed docs checkout
/// (`/`-separated), and the lowercase hex SHA-256 of its bytes. A page edited by one byte, or
/// a copy anywhere else, loses the grant. The page's sibling files are covered by its place:
/// the docs checkout is app-managed, so a copy elsewhere cannot bring its own scripts.
pub struct Page {
    pub path: &'static str,
    pub sha256: &'static str,
}

/// The pages that hold it. Empty until the Foreman page ships in the docs bundle.
pub const PAGES: &[Page] = &[];

/// The grant a freshly minted frame holds, given the placed docs root.
pub fn grant_for(docs_root: &Path, document_path: &str) -> Option<String> {
    grant_in(PAGES, docs_root, document_path)
}

/// The document must be a regular file (not a link) inside `docs_root`, at a page's path, with
/// that page's bytes. The path is checked before the file is read.
pub fn grant_in(pages: &[Page], docs_root: &Path, document_path: &str) -> Option<String> {
    if pages.is_empty() {
        return None;
    }
    let document = Path::new(document_path);
    if std::fs::symlink_metadata(document)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let root = std::fs::canonicalize(docs_root).ok()?;
    let document = std::fs::canonicalize(document).ok()?;
    let relative = document.strip_prefix(&root).ok()?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    let page = pages.iter().find(|page| page.path == relative)?;
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

    /// A docs root holding the page, and a second, unrelated dir.
    fn placed(body: &[u8]) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        let page = docs.join(PAGE);
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
    }

    #[test]
    fn no_pages_are_bundled_yet_so_nothing_holds_it() {
        let (_dir, docs, page) = placed(BODY);
        assert!(PAGES.is_empty());
        assert_eq!(grant_for(&docs, &page.to_string_lossy()), None);
    }

    #[test]
    fn it_is_not_in_the_grantable_vocabulary() {
        assert!(!super::super::capabilities::known(CAPABILITY));
    }
}
