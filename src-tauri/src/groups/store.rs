// SPDX-License-Identifier: MIT
//! The group store: the one reader and writer of group files.
//!
//! A group file lives in the person's private layer, per context repo and local profile:
//! `users/<profile>/scratch/orgs/<owner>/<repo>/config/groups/<id>.json` in the Scratch space,
//! outside `content/`, so it never shows as private content and never pushes. The scratch repo
//! excludes the folder and the folder holds a `.gitignore` of `*`, so its git status stays clean.
//!
//! - **One write entry.** [`GroupStore::commit`] writes and deletes. It checks the tiles flag
//!   first and, with the flag off, returns before touching the disk.
//! - **One lock, a per-file `rev`.** A write applies only when its `baseRev` is the file's head
//!   `rev`, read from the file under the lock; otherwise it is a [`StoreError::Conflict`] that
//!   names the head and changes nothing. A delete leaves a tombstone holding the `rev`, so a
//!   recreate continues from it and a client holding an old `baseRev` never passes.
//! - **Atomic, owner-only writes** through `write_json_atomic_private`, under the watcher's
//!   suppression, so a resize raises no content change.
//! - **Repair on load is in memory.** A load drops leaves whose ref is structurally invalid
//!   (unparseable or refused by the leaf-id grammar) and keeps every well-formed ref, resolved or
//!   not. The file changes only with the next real write, which carries the repair and bumps
//!   `rev` once.
//! - **"Can't be read."** A file that fails to parse, has another version or isn't this shape is
//!   listed with that reason and never rewritten: every write to it is refused before
//!   compare-and-set runs.
//! - **Paths.** An id is `[a-z0-9-]{1,64}`; its file is `config/groups/<id>.json`, checked to stay
//!   in that folder with no symlink followed on the way.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::leaf_id::{leaf_ref_problem, Layer};
use super::shape::{GroupFile, OwnerKind, SavedNode, Tombstone, VERSION};
use crate::context_repo::scratch_space::{self, ScratchOrgSpace};
use crate::domain::Principal;

/// The folder under a space's `config/` that holds the group files.
const GROUPS_DIR: &str = "groups";
/// The scratch repo's exclude entry for every space's group folder. A pattern with a slash in
/// the middle is anchored to the repo root, so it leads with `**/` to match under `orgs/`.
pub const GROUPS_EXCLUDE: &str = "**/config/groups/";
/// The reason a file that can't be loaded is listed with.
pub const UNREADABLE: &str = "can't be read";

const ID_MAX: usize = 64;
const FILE_SUFFIX: &str = ".json";

/// The one lock every group write holds.
static WRITE: Mutex<()> = Mutex::new(());

/// A space's group folder.
pub fn groups_dir(space: &ScratchOrgSpace) -> PathBuf {
    space.config_dir().join(GROUPS_DIR)
}

/// Whether a path under the scratch repo, as segments, is in a space's group folder
/// (`orgs/<owner>/<repo>/config/groups/…`).
pub fn is_group_path(parts: &[String]) -> bool {
    parts.len() >= 5
        && parts[0] == "orgs"
        && parts[3] == crate::context_repo::path::CONFIG_DIR
        && parts[4] == GROUPS_DIR
}

/// Why a store call did nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// The tiles flag is off: the store writes nothing.
    TilesOff,
    /// The id is not `[a-z0-9-]{1,64}`.
    InvalidId(String),
    /// The path is not a plain file in a plain folder (a symlink, or not a folder).
    Refused(String),
    /// The file can't be read, so it is never written.
    Unreadable,
    /// The write's `baseRev` is not the head; nothing changed.
    Conflict { current_revision: u64 },
    /// The tree holds a ref or a split the store refuses; nothing changed.
    InvalidTree(String),
    /// No such group.
    NotFound,
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TilesOff => f.write_str("tiles are off"),
            Self::InvalidId(id) => write!(f, "{id:?} is not a group id"),
            Self::Refused(why) => write!(f, "refused: {why}"),
            Self::Unreadable => f.write_str(UNREADABLE),
            Self::Conflict { current_revision } => {
                write!(f, "the group changed; it is at revision {current_revision}")
            }
            Self::InvalidTree(why) => write!(f, "refused: {why}"),
            Self::NotFound => f.write_str("no such group"),
            Self::Io(why) => f.write_str(why),
        }
    }
}

/// A write through the one entry.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Put {
        owner: OwnerKind,
        root: Option<SavedNode>,
    },
    Delete,
}

/// A loaded file, repaired in memory, and the refs the repair dropped.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub file: GroupFile,
    pub dropped: Vec<String>,
}

/// One listed group: its file, or [`UNREADABLE`].
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub id: String,
    pub file: Result<GroupFile, &'static str>,
}

/// What a group's path holds.
enum Head {
    Absent,
    Deleted(u64),
    File(Loaded),
    Unreadable,
}

/// One profile's group files for one context repo.
pub struct GroupStore {
    home: PathBuf,
    principal: Principal,
    org: String,
    space: ScratchOrgSpace,
    scratch_root: PathBuf,
    tiles: bool,
    suppression: Option<crate::content_engine::SuppressionHandle>,
}

impl GroupStore {
    /// The store of `principal`'s private layer for the context repo `org_slug`. Path math only:
    /// it creates nothing. `tiles` is the session's tiles flag (`tiles_enabled()`).
    pub fn at(
        home: &Path,
        principal: &Principal,
        org_slug: &str,
        tiles: bool,
    ) -> Result<Self, StoreError> {
        let space = scratch_space::org_space_at(home, principal, org_slug)
            .map_err(|e| StoreError::Refused(e.to_string()))?;
        Ok(Self {
            home: home.to_path_buf(),
            principal: principal.clone(),
            org: org_slug.to_string(),
            space,
            scratch_root: scratch_space::scratch_root(home, principal),
            tiles,
            suppression: None,
        })
    }

    /// Writes under the watcher's suppression, so the app's own write raises no change event.
    pub fn with_suppression(mut self, handle: crate::content_engine::SuppressionHandle) -> Self {
        self.suppression = Some(handle);
        self
    }

    /// The groups, by id, each with its file or [`UNREADABLE`]. Tombstones are skipped. Reads only.
    pub fn list(&self) -> Result<Vec<Listed>, StoreError> {
        self.check_folders()?;
        let entries = match std::fs::read_dir(self.group_dir()) {
            Ok(entries) => entries,
            Err(e) if std::io::Error::kind(&e) == std::io::ErrorKind::NotFound => {
                return Ok(vec![])
            }
            Err(e) => return Err(StoreError::Io(e.to_string())),
        };
        let mut listed = vec![];
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(FILE_SUFFIX) else {
                continue;
            };
            if id_problem(id).is_some() {
                continue;
            }
            let file = match read_head(&std::fs::DirEntry::path(&entry)) {
                Head::Absent | Head::Deleted(_) => continue,
                Head::File(loaded) => Ok(loaded.file),
                Head::Unreadable => Err(UNREADABLE),
            };
            listed.push(Listed {
                id: id.to_string(),
                file,
            });
        }
        listed.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(listed)
    }

    /// The group `id`, repaired in memory. Reads only: a repair reaches the file with the next
    /// write.
    pub fn load(&self, id: &str) -> Result<Loaded, StoreError> {
        let path = self.group_file(id)?;
        match read_head(&path) {
            Head::Absent | Head::Deleted(_) => Err(StoreError::NotFound),
            Head::File(loaded) => Ok(loaded),
            Head::Unreadable => Err(StoreError::Unreadable),
        }
    }

    /// The one write entry: put or delete the group `id` when `base_rev` is its head `rev` (0 for
    /// a group that never existed, the tombstone's for a deleted one). Returns the new `rev`.
    pub fn commit(&self, id: &str, base_rev: u64, change: Change) -> Result<u64, StoreError> {
        if !self.tiles {
            return Err(StoreError::TilesOff);
        }
        let path = self.group_file(id)?;
        if let Change::Put {
            root: Some(root), ..
        } = &change
        {
            if let Some(why) = tree_problem(root) {
                return Err(StoreError::InvalidTree(why));
            }
        }
        let _write = WRITE
            .lock()
            .map_err(|_| StoreError::Io("the group store is unavailable".into()))?;
        let path = self.checked_path(path)?;
        let head = match read_head(&path) {
            Head::Unreadable => return Err(StoreError::Unreadable),
            Head::Absent => None,
            Head::Deleted(rev) => Some((rev, false)),
            Head::File(loaded) => Some((loaded.file.rev, true)),
        };
        let (head_rev, live) = head.unwrap_or((0, false));
        if matches!(change, Change::Delete) && !live {
            return Err(StoreError::NotFound);
        }
        if base_rev != head_rev {
            return Err(StoreError::Conflict {
                current_revision: head_rev,
            });
        }
        let rev = head_rev
            .checked_add(1)
            .ok_or_else(|| StoreError::Io("the group's revision is at its limit".into()))?;
        scratch_space::open_group_space(&self.home, &self.principal, &self.org, self.tiles)
            .map_err(|e| StoreError::Io(e.to_string()))?;
        let path = self.checked_path(path)?;
        match change {
            Change::Put { owner, root } => self.write(
                &path,
                &GroupFile {
                    version: VERSION,
                    owner,
                    rev,
                    root,
                },
            )?,
            Change::Delete => self.write(
                &path,
                &Tombstone {
                    version: VERSION,
                    deleted: true,
                    rev,
                },
            )?,
        }
        Ok(rev)
    }

    fn group_dir(&self) -> PathBuf {
        groups_dir(&self.space)
    }

    /// The file of a valid `id`, its folders and itself checked.
    fn group_file(&self, id: &str) -> Result<PathBuf, StoreError> {
        if let Some(why) = id_problem(id) {
            return Err(StoreError::InvalidId(why));
        }
        let path = self.group_dir().join(format!("{id}{FILE_SUFFIX}"));
        self.checked_path(path)
    }

    /// `path` once its folders and itself are checked: inside the group folder, and no existing
    /// part a symlink.
    fn checked_path(&self, path: PathBuf) -> Result<PathBuf, StoreError> {
        if path.parent() != Some(self.group_dir().as_path()) {
            return Err(StoreError::Refused("the path leaves the group folder".into()));
        }
        self.check_folders()?;
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                Err(StoreError::Refused("the group file is a symlink".into()))
            }
            _ => Ok(path),
        }
    }

    /// Every existing folder from the scratch repo down to the group folder is a real folder.
    fn check_folders(&self) -> Result<(), StoreError> {
        let dir = self.group_dir();
        let relative = dir
            .strip_prefix(&self.scratch_root)
            .map_err(|_| StoreError::Refused("the group folder leaves the scratch space".into()))?;
        let mut at = self.scratch_root.clone();
        for component in relative.components() {
            let Component::Normal(part) = component else {
                return Err(StoreError::Refused("the group folder is not normalized".into()));
            };
            at.push(part);
            match std::fs::symlink_metadata(&at) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(StoreError::Refused(format!(
                        "{} is a symlink",
                        std::path::Path::to_string_lossy(&at)
                    )))
                }
                Ok(meta) if !std::fs::Metadata::is_dir(&meta) => {
                    return Err(StoreError::Refused(format!(
                        "{} is not a folder",
                        std::path::Path::to_string_lossy(&at)
                    )))
                }
                Ok(_) => {}
                Err(_) => return Ok(()),
            }
        }
        Ok(())
    }

    fn write<T: serde::Serialize>(&self, path: &Path, value: &T) -> Result<(), StoreError> {
        let tmp = path.with_extension("json.tmp");
        let _quiet = self.suppression.as_ref().map(|handle| {
            crate::content_engine::Suppression::new(handle, [path.to_path_buf(), tmp])
        });
        crate::shared::json_io::write_json_atomic_private(path, value)
            .map_err(|e| StoreError::Io(e.to_string()))
    }
}

/// Why `id` is not a group id, or `None`.
fn id_problem(id: &str) -> Option<String> {
    let valid = !str::is_empty(id)
        && id.len() <= ID_MAX
        && !id
            .chars()
            .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    (!valid).then(|| format!("{id:?}: a group id is [a-z0-9-]{{1,64}}"))
}

/// Why the store refuses `node`, or `None`.
fn tree_problem(node: &SavedNode) -> Option<String> {
    match node {
        SavedNode::Leaf { id, workspace_id } => {
            if id != workspace_id {
                return Some(format!("a leaf's id {id:?} and workspaceId {workspace_id:?} differ"));
            }
            leaf_ref_problem(id, Layer::Private)
        }
        SavedNode::Split {
            children, sizes, ..
        } => {
            if children.len() < 2 {
                return Some("a split has two or more children".into());
            }
            if sizes.len() != children.len() {
                return Some("a split has one size per child".into());
            }
            if sizes.iter().any(|s| !s.is_finite() || *s < 0.0) {
                return Some("a size is a finite number, 0 or more".into());
            }
            children.iter().find_map(tree_problem)
        }
    }
}

/// What `path` holds, never following a symlink.
fn read_head(path: &Path) -> Head {
    match std::fs::symlink_metadata(path) {
        Err(e) if std::io::Error::kind(&e) == std::io::ErrorKind::NotFound => return Head::Absent,
        Ok(meta) if meta.is_file() => {}
        _ => return Head::Unreadable,
    }
    Result::ok(std::fs::read(path))
        .and_then(|bytes| Result::ok(serde_json::from_slice::<serde_json::Value>(&bytes)))
        .and_then(|value| parse_head(&value))
        .unwrap_or(Head::Unreadable)
}

/// A file's head, or `None` when it can't be read.
fn parse_head(value: &serde_json::Value) -> Option<Head> {
    let object = value.as_object()?;
    if object.get("version")?.as_u64()? != u64::from(VERSION) {
        return None;
    }
    if object.contains_key("deleted") {
        let tombstone: Tombstone = Result::ok(serde_json::from_value(value.clone()))?;
        return tombstone.deleted.then_some(Head::Deleted(tombstone.rev));
    }
    if object
        .keys()
        .any(|k| !matches!(&**k, "version" | "owner" | "rev" | "root"))
    {
        return None;
    }
    let owner: OwnerKind = Result::ok(serde_json::from_value(object.get("owner")?.clone()))?;
    let rev = object.get("rev")?.as_u64()?;
    let mut dropped = vec![];
    let root = match object.get("root")? {
        serde_json::Value::Null => None,
        node => repair(node, &mut dropped)?,
    };
    Some(Head::File(Loaded {
        file: GroupFile {
            version: VERSION,
            owner,
            rev,
            root,
        },
        dropped,
    }))
}

/// `node` with its structurally invalid leaves dropped, its splits collapsed as the kit's
/// `parseMosaicNode` does. `Ok(None)`: nothing is left. `None`: the tree isn't this shape, so
/// the file can't be read.
fn repair(node: &serde_json::Value, dropped: &mut Vec<String>) -> Option<Option<SavedNode>> {
    let object = node.as_object()?;
    match serde_json::Value::as_str(object.get("kind")?)? {
        "leaf" => {
            if object
                .keys()
                .any(|k| !matches!(&**k, "kind" | "id" | "workspaceId"))
            {
                return None;
            }
            let id = object.get("id").and_then(serde_json::Value::as_str);
            let workspace_id = object.get("workspaceId").and_then(serde_json::Value::as_str);
            match (id, workspace_id) {
                (Some(id), Some(workspace_id))
                    if id == workspace_id && leaf_ref_problem(id, Layer::Private).is_none() =>
                {
                    Some(Some(SavedNode::Leaf {
                        id: id.to_string(),
                        workspace_id: workspace_id.to_string(),
                    }))
                }
                _ => {
                    dropped.push(id.or(workspace_id).unwrap_or("").to_string());
                    Some(None)
                }
            }
        }
        "split" => {
            if object
                .keys()
                .any(|k| !matches!(&**k, "kind" | "axis" | "children" | "sizes"))
            {
                return None;
            }
            let axis = Result::ok(serde_json::from_value(object.get("axis")?.clone()))?;
            let children = object.get("children")?.as_array()?;
            let sizes = object.get("sizes")?.as_array()?;
            if children.len() < 2 || sizes.len() != children.len() {
                return None;
            }
            let mut kept = vec![];
            for (child, size) in children.iter().zip(sizes) {
                let size = size.as_f64().filter(|s| s.is_finite() && *s >= 0.0)?;
                if let Some(child) = repair(child, dropped)? {
                    kept.push((child, size));
                }
            }
            if kept.len() == children.len() {
                let (children, sizes) = kept.into_iter().unzip();
                return Some(Some(SavedNode::Split {
                    axis,
                    children,
                    sizes,
                }));
            }
            if kept.len() < 2 {
                return Some(kept.pop().map(|(child, _)| child));
            }
            let (children, sizes): (Vec<SavedNode>, Vec<f64>) = kept.into_iter().unzip();
            Some(Some(SavedNode::Split {
                axis,
                children,
                sizes: normalized(&sizes),
            }))
        }
        _ => None,
    }
}

/// `sizes` scaled to sum to 100, or an even split when they sum to 0 (the kit's rule).
fn normalized(sizes: &[f64]) -> Vec<f64> {
    let sum: f64 = sizes.iter().sum();
    if sum <= 0.0 {
        return vec![100.0 / sizes.len() as f64; sizes.len()];
    }
    sizes.iter().map(|s| s / sum * 100.0).collect()
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
