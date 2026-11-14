// SPDX-License-Identifier: MIT
//! The `clone_repo` rules: each hostile fixture is refused by a named rule before
//! any tab could open (the verb validates first), good inputs pass, and Stop removes
//! only a folder the verb created. No network and no `gh`.

use std::path::{Path, PathBuf};

use super::clone_repo::{
    clone_argv, finished, parent_of, records, validate_clone, CloneRecords, CloneRefusal,
    ValidClone,
};

/// A canonical temp parent: macOS's temp dir sits behind a symlink, which the
/// rules refuse by design.
fn parent() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap();
    (dir, real)
}

fn path_in(parent: &Path, name: &str) -> String {
    format!("{}/{name}", parent.display())
}

fn refused(repo: &str, parent: &Path, path: &str) -> CloneRefusal {
    validate_clone(repo, parent, path).unwrap_err()
}

#[test]
fn a_good_clone_into_an_absent_folder_passes_and_creates_it() {
    let (_dir, parent) = parent();
    let path = path_in(&parent, "api");
    let valid = validate_clone("acme/api", &parent, &path).unwrap();
    assert_eq!(
        valid,
        ValidClone {
            repo: "acme/api".into(),
            path: PathBuf::from(&path),
            creates: true,
        }
    );
}

#[test]
fn an_empty_existing_folder_passes_and_is_not_created_by_the_verb() {
    let (_dir, parent) = parent();
    let path = path_in(&parent, "api");
    std::fs::create_dir(&path).unwrap();
    assert!(!validate_clone("acme/api", &parent, &path).unwrap().creates);
}

#[test]
fn dots_dashes_underscores_and_a_spaced_parent_pass() {
    let (_dir, real) = parent();
    let spaced = real.join("My Code");
    std::fs::create_dir(&spaced).unwrap();
    let path = path_in(&spaced, "web.app_v2-x");
    assert!(validate_clone("a-b/web.app_v2-x", &spaced, &path).is_ok());
}

#[test]
fn the_argv_is_gh_repo_clone_with_two_operands() {
    let (_dir, parent) = parent();
    let path = path_in(&parent, "api");
    let valid = validate_clone("acme/api", &parent, &path).unwrap();
    assert_eq!(
        clone_argv("/usr/local/bin/gh", &valid),
        [
            "/usr/local/bin/gh",
            "repo",
            "clone",
            "acme/api",
            path.as_str()
        ]
    );
}

#[test]
fn hostile_repos_are_refused_by_the_repo_rules() {
    let (_dir, parent) = parent();
    let path = path_in(&parent, "b");
    let long_name = format!("a/{}", "n".repeat(300));
    let long_owner = format!("{}/b", "o".repeat(40));
    let cases: [(&str, CloneRefusal); 16] = [
        ("a/b; rm -rf ~", CloneRefusal::RepoName),
        ("a/b$(id)", CloneRefusal::RepoName),
        ("a/b`id`", CloneRefusal::RepoName),
        ("a/b\nx", CloneRefusal::RepoName),
        ("-oProxyCommand=x/y", CloneRefusal::RepoOwner),
        ("../x", CloneRefusal::RepoOwner),
        ("a/..", CloneRefusal::RepoName),
        ("a/b/c", CloneRefusal::RepoShape),
        ("https://github.com/a/b", CloneRefusal::RepoShape),
        ("\u{0430}cme/b", CloneRefusal::RepoShape),
        ("a/b\0", CloneRefusal::RepoName),
        ("a/-b", CloneRefusal::RepoName),
        ("a/b.git", CloneRefusal::RepoName),
        ("a@b/c", CloneRefusal::RepoOwner),
        ("", CloneRefusal::RepoShape),
        ("noslash", CloneRefusal::RepoShape),
    ];
    for (repo, rule) in cases {
        assert_eq!(refused(repo, &parent, &path), rule, "{repo:?}");
    }
    assert_eq!(refused(&long_name, &parent, &path), CloneRefusal::RepoName);
    assert_eq!(
        refused(&long_owner, &parent, &path),
        CloneRefusal::RepoOwner
    );
}

#[test]
fn hostile_paths_are_refused_by_the_path_rules() {
    let parent = Path::new("/home/user");
    let long = format!("/home/user/{}", "p".repeat(1100));
    let cases: [(&str, CloneRefusal); 16] = [
        ("~/x", CloneRefusal::PathNotAbsolute),
        ("home/user/b", CloneRefusal::PathNotAbsolute),
        ("", CloneRefusal::PathNotAbsolute),
        ("/home/user/b; rm -rf ~", CloneRefusal::PathCharacter),
        ("/home/user/b$(id)", CloneRefusal::PathCharacter),
        ("/home/user/b`id`", CloneRefusal::PathCharacter),
        ("/home/user/b\nx", CloneRefusal::PathCharacter),
        ("/home/user/b\0", CloneRefusal::PathCharacter),
        ("/home/user/b'x", CloneRefusal::PathCharacter),
        ("/home/user/~b", CloneRefusal::PathCharacter),
        ("/home/user/\u{0431}", CloneRefusal::PathCharacter),
        ("/home/user/../etc", CloneRefusal::PathSegment),
        ("/home/user/./b", CloneRefusal::PathSegment),
        ("/home/user//b", CloneRefusal::PathSegment),
        ("/home/user/b/", CloneRefusal::PathSegment),
        ("/", CloneRefusal::PathSegment),
    ];
    for (path, rule) in cases {
        assert_eq!(refused("a/b", parent, path), rule, "{path:?}");
    }
    assert_eq!(refused("a/b", parent, &long), CloneRefusal::PathTooLong);
}

#[test]
fn containment_is_by_components_not_by_string_prefix() {
    let (_dir, parent) = parent();
    let sibling = path_in(&parent, "repo2");
    assert_eq!(
        refused("a/repo", &parent, &sibling),
        CloneRefusal::NameMismatch
    );
    // `/p2/repo` is not under `/p`, though `/p` is a string prefix of it.
    assert_eq!(
        refused("a/repo", Path::new("/p"), "/p2/repo"),
        CloneRefusal::Containment
    );
    // Two segments under the parent is not "directly under".
    assert_eq!(
        refused("a/repo", Path::new("/p"), "/p/x/repo"),
        CloneRefusal::Containment
    );
}

#[test]
fn the_last_segment_must_equal_the_repo_name() {
    let (_dir, parent) = parent();
    let path = path_in(&parent, "other");
    assert_eq!(
        refused("a/repo", &parent, &path),
        CloneRefusal::NameMismatch
    );
    let case = path_in(&parent, "REPO");
    assert_eq!(
        refused("a/repo", &parent, &case),
        CloneRefusal::NameMismatch
    );
}

#[test]
fn a_missing_or_file_parent_is_refused() {
    let (_dir, parent) = parent();
    let gone = parent.join("gone");
    assert_eq!(
        refused("a/b", &gone, &path_in(&gone, "b")),
        CloneRefusal::ParentMissing
    );
    let file = parent.join("file");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(
        refused("a/b", &file, &path_in(&file, "b")),
        CloneRefusal::ParentNotDirectory
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_parent_or_ancestor_is_refused() {
    let (_dir, parent) = parent();
    let real = parent.join("real");
    std::fs::create_dir(&real).unwrap();
    let link = parent.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert_eq!(
        refused("a/b", &link, &path_in(&link, "b")),
        CloneRefusal::ParentSymlink
    );
    // A symlink higher up: the parent is a real folder reached through it.
    std::fs::create_dir(real.join("inner")).unwrap();
    let through = link.join("inner");
    assert_eq!(
        refused("a/b", &through, &path_in(&through, "b")),
        CloneRefusal::ParentSymlink
    );
}

#[test]
fn a_target_that_holds_something_is_refused() {
    let (_dir, parent) = parent();
    let path = path_in(&parent, "b");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(Path::new(&path).join("keep.txt"), "x").unwrap();
    assert_eq!(refused("a/b", &parent, &path), CloneRefusal::TargetNotEmpty);
    // A file at the target is refused too.
    let file = path_in(&parent, "c");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(refused("a/c", &parent, &file), CloneRefusal::TargetNotEmpty);
}

#[cfg(unix)]
#[test]
fn a_symlink_at_the_target_is_refused() {
    let (_dir, parent) = parent();
    let real = parent.join("real");
    std::fs::create_dir(&real).unwrap();
    let path = path_in(&parent, "b");
    std::os::unix::fs::symlink(&real, &path).unwrap();
    assert_eq!(refused("a/b", &parent, &path), CloneRefusal::TargetNotEmpty);
}

#[test]
fn a_refusal_names_its_rule() {
    let message = CloneRefusal::ParentSymlink.to_string();
    assert!(message.contains("parent_symlink"), "{message}");
    assert!(message.contains("symlink"), "{message}");
}

#[test]
fn the_parent_is_the_path_minus_its_last_segment() {
    assert_eq!(parent_of("/home/user/api"), Path::new("/home/user"));
}

#[test]
fn stop_removes_only_a_folder_the_verb_created() {
    let (_dir, parent) = parent();
    let created = parent.join("api");
    std::fs::create_dir(&created).unwrap();
    std::fs::write(created.join("README.md"), "x").unwrap();
    let records = CloneRecords::default();
    records.note_created(&created);
    assert!(records.is_recorded(&created));

    assert!(records.stop(&created).removed);
    assert!(!created.exists());
    assert!(!records.is_recorded(&created));
}

#[test]
fn stop_on_a_folder_that_was_already_there_removes_nothing() {
    let (_dir, parent) = parent();
    let existing = parent.join("api");
    std::fs::create_dir(&existing).unwrap();
    // Validation found it empty, so the verb did not create it and never records it.
    assert!(
        !validate_clone("a/api", &parent, &path_in(&parent, "api"))
            .unwrap()
            .creates
    );
    let records = CloneRecords::default();

    assert!(!records.stop(&existing).removed);
    assert!(existing.is_dir());
}

#[test]
fn stop_never_follows_a_recorded_path_that_became_a_symlink() {
    let (_dir, parent) = parent();
    let keep = parent.join("keep");
    std::fs::create_dir(&keep).unwrap();
    std::fs::write(keep.join("data"), "x").unwrap();
    let swapped = parent.join("api");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&keep, &swapped).unwrap();
    #[cfg(not(unix))]
    std::fs::create_dir(&swapped).unwrap();
    let records = CloneRecords::default();
    records.note_created(&swapped);

    #[cfg(unix)]
    assert!(!records.stop(&swapped).removed);
    #[cfg(not(unix))]
    let _ = records.stop(&swapped);
    assert!(keep.join("data").exists());
}

#[test]
fn stop_forgets_the_record_and_a_second_stop_removes_nothing() {
    let (_dir, parent) = parent();
    let created = parent.join("api");
    std::fs::create_dir(&created).unwrap();
    let records = CloneRecords::default();
    records.note_created(&created);
    assert!(records.stop(&created).removed);

    // Someone else creates the folder again: it is not ours to remove.
    std::fs::create_dir(&created).unwrap();
    assert!(!records.stop(&created).removed);
    assert!(created.is_dir());
}

#[test]
fn the_process_wide_record_is_shared() {
    let (_dir, parent) = parent();
    let path = parent.join("shared");
    records().note_created(&path);
    assert!(records().is_recorded(&path));
    assert!(!records().stop(&path).removed);
    assert!(!records().is_recorded(&path));
}

#[test]
fn stop_checks_only_the_text_rules_so_a_filled_clone_is_stoppable() {
    use super::clone_repo::validate_text;
    let (_dir, parent) = parent();
    let path = path_in(&parent, "api");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(Path::new(&path).join("README.md"), "x").unwrap();
    // The full check refuses the filled target; the text check, which a Stop runs, does not.
    assert_eq!(
        refused("a/api", &parent, &path),
        CloneRefusal::TargetNotEmpty
    );
    assert_eq!(
        validate_text("a/api", &parent, &path).unwrap(),
        PathBuf::from(&path)
    );
    assert_eq!(
        validate_text("a/api", Path::new("/p"), "/p2/api").unwrap_err(),
        CloneRefusal::Containment
    );
}

#[test]
fn a_clone_is_finished_when_git_has_written_its_index() {
    let (_dir, parent) = parent();
    let target = parent.join("api");
    std::fs::create_dir_all(target.join(".git")).unwrap();
    assert!(!finished(&target));
    std::fs::write(target.join(".git").join("index"), "x").unwrap();
    assert!(finished(&target));
}
