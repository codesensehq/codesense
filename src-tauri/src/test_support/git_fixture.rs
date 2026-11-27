// SPDX-License-Identifier: MIT
//! Throwaway git repos for tests that check a story doc is left as it was.

use std::path::Path;

/// A git repo at `dir` born on `branch`, with `files` in its one commit.
pub(crate) fn committed_repo(dir: &Path, branch: &str, files: &[(&str, &str)]) -> git2::Oid {
    let mut opts = git2::RepositoryInitOptions::new();
    opts.initial_head(branch);
    let repo = git2::Repository::init_opts(dir, &opts).unwrap();
    let mut index = repo.index().unwrap();
    for (name, text) in files {
        std::fs::write(dir.join(name), text).unwrap();
        index.add_path(Path::new(name)).unwrap();
    }
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("t", "t@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
        .unwrap()
}

/// What `git status --porcelain` would list at `dir`, untracked files included.
pub(crate) fn porcelain(dir: &Path) -> Vec<String> {
    let repo = git2::Repository::open(dir).unwrap();
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts)).unwrap();
    statuses
        .iter()
        .map(|s| s.path().expect("utf-8 status path").to_string())
        .collect()
}

/// The source of the function whose signature starts with `signature` in `source`.
pub(crate) fn fn_source<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source.find(signature).unwrap();
    &source[start..start + source[start..].find("\n}\n").unwrap()]
}
