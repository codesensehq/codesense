// SPDX-License-Identifier: MIT
//! A private directory: created owner-only where it is missing, tightened to
//! owner-only where it already exists.

use std::io;
use std::path::Path;

/// Why [`create_or_tighten`] failed.
#[derive(Debug)]
pub(crate) enum PrivateDirError {
    /// The directory, or one of its missing parents, could not be created.
    Create(io::Error),
    /// The directory exists but could not be made owner-only: not this
    /// user's, or a symlink, whose target is not ours to change.
    Tighten(io::Error),
}

impl std::fmt::Display for PrivateDirError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Create(error) | Self::Tighten(error) => error.fmt(f),
        }
    }
}

/// Create the directory `dir` owner-only (unix 0700; on Windows a protected
/// owner-only DACL), its missing parents plainly, then make `dir` owner-only
/// even when it already existed. Unlike `commands::paths::ensure_private_dir`,
/// an existing directory is tightened.
pub(crate) fn create_or_tighten(dir: &Path) -> Result<(), PrivateDirError> {
    if let Some(parent) = dir
        .parent()
        .filter(|parent| !std::ffi::OsStr::is_empty(parent.as_os_str()))
    {
        std::fs::create_dir_all(parent).map_err(PrivateDirError::Create)?;
    }
    codesense_platform::fs::create_dir_owner_only(dir).map_err(PrivateDirError::Create)?;
    codesense_platform::fs::set_owner_only(dir).map_err(PrivateDirError::Tighten)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::owner_only::{is_owner_only, shared_dir};

    #[test]
    fn a_missing_directory_is_created_and_an_existing_one_tightened() {
        let root = tempfile::tempdir().unwrap();
        let fresh = root.path().join("missing").join("private");
        create_or_tighten(&fresh).unwrap();
        assert!(is_owner_only(&fresh));
        let shared = root.path().join("shared");
        shared_dir(&shared);
        create_or_tighten(&shared).unwrap();
        assert!(is_owner_only(&shared));
        let file = root.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(matches!(
            create_or_tighten(&file),
            Err(PrivateDirError::Create(_))
        ));
    }
}
