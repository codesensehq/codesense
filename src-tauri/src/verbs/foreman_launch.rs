// SPDX-License-Identifier: MIT
//! The `foreman.launch` capability: a page may open a `team-workspace` agent only when it is
//! one of the bundled Foreman pages. It is deliberately outside [`super::capabilities::ALL`],
//! so no preset, declaration or per-dashboard override can hand it out; it is minted from the
//! page file's own bytes.
use sha2::{Digest, Sha256};

pub const CAPABILITY: &str = "foreman.launch";

/// A bundled page that holds the capability: the tail of its document path, and the lowercase
/// hex SHA-256 of its bytes. A page edited by one byte loses the grant.
pub struct Page {
    pub path_suffix: &'static str,
    pub sha256: &'static str,
}

/// The pages that hold it. Empty until the Foreman page ships in the docs bundle.
pub const PAGES: &[Page] = &[];

pub fn admits(document_path: &str, bytes: &[u8]) -> bool {
    admits_in(PAGES, document_path, bytes)
}

pub fn admits_in(pages: &[Page], document_path: &str, bytes: &[u8]) -> bool {
    let path = document_path.replace('\\', "/");
    let digest = format!("{:x}", Sha256::digest(bytes));
    pages
        .iter()
        .any(|page| path.ends_with(page.path_suffix) && page.sha256 == digest)
}

/// The grant a freshly minted frame holds: its file is read from disk, so a missing file holds nothing.
pub fn grant_for(document_path: &str) -> Option<String> {
    if PAGES.is_empty() {
        return None;
    }
    let bytes = std::fs::read(document_path).ok()?;
    admits(document_path, &bytes).then(|| CAPABILITY.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &[u8] = b"<!doctype html><title>Foreman</title>";
    fn pages(sha256: &'static str) -> Vec<Page> {
        vec![Page {
            path_suffix: "getting-started/foreman/index.html",
            sha256,
        }]
    }
    fn body_hash() -> String {
        format!("{:x}", Sha256::digest(BODY))
    }

    #[test]
    fn matching_path_and_hash_admit() {
        let hash: &'static str = Box::leak(body_hash().into_boxed_str());
        assert!(admits_in(
            &pages(hash),
            "/x/getting-started/foreman/index.html",
            BODY
        ));
    }

    #[test]
    fn an_edited_page_or_another_path_is_refused() {
        let hash: &'static str = Box::leak(body_hash().into_boxed_str());
        let mut edited = BODY.to_vec();
        edited.push(b' ');
        assert!(!admits_in(
            &pages(hash),
            "/x/getting-started/foreman/index.html",
            &edited
        ));
        assert!(!admits_in(&pages(hash), "/x/notes/index.html", BODY));
    }

    #[test]
    fn no_pages_are_bundled_yet_so_nothing_holds_it() {
        assert!(PAGES.is_empty());
        assert_eq!(grant_for("/x/getting-started/foreman/index.html"), None);
    }

    #[test]
    fn it_is_not_in_the_grantable_vocabulary() {
        assert!(!super::super::capabilities::known(CAPABILITY));
    }
}
