// SPDX-License-Identifier: MIT
//! The group store: the one reader and writer of group files.
//!
//! A group file lives in the person's private layer, per context repo and local profile:
//! `users/<profile>/scratch/orgs/<owner>/<repo>/config/groups/<id>.json` in the Scratch space,
//! outside `content/`, so it never shows as private content and never pushes. The scratch repo
//! excludes the folder and the folder holds a `.gitignore` of `*`, so its git status stays clean.
//!
//! - **One write entry.** [`GroupStore::write`] runs a writer's kit ops; [`GroupStore::commit`]
//!   puts or deletes a file whole. Both check the tiles flag first and, with the flag off, return
//!   before touching the disk.
//! - **One lock, a per-file `rev`.** A write applies when its `baseRev` is the file's head `rev`,
//!   read from the file under the lock; otherwise it is a [`StoreError::Conflict`] that names the
//!   head and changes nothing. The one exception is a person's write, which is rebased onto the
//!   head and wins unless one of its ops can't run there; when an agent's write since its base
//!   touched that op's tile keys, it is a [`StoreError::Collided`] naming them, and the store's
//!   collision hook hears it. The writes since a base are kept in memory, so a rebase never
//!   crosses a restart, a whole-file commit or another process's write.
//! - **Two app processes.** Every write also holds a lock on the folder's `.lock` file across
//!   reading the head and replacing the file.
//! - **Tombstones.** A delete leaves a tombstone holding the `rev`, so a recreate continues from
//!   it and a client holding an old `baseRev` never passes.
//! - **Atomic, owner-only writes** through `write_json_atomic_private`, under the watcher's
//!   suppression, so a resize raises no content change.
//! - **Repair on load is in memory.** A load drops leaves whose ref is structurally invalid
//!   (unparseable or refused by the leaf-id grammar) and keeps every well-formed ref, resolved or
//!   not. The file changes only with the next real write, which carries the repair and bumps
//!   `rev` once.
//! - **"Can't be read."** A file that fails to parse, has another version or isn't this shape is
//!   listed with that reason and never rewritten: every write to it is refused before
//!   compare-and-set runs.
//! - **Paths.** An id is `[a-z0-9-]{1,64}`, never `index`; its file is `config/groups/<id>.json`,
//!   checked to stay in that folder with no symlink followed on the way.
//! - **Window pins.** `config/groups/index.json` holds each window's pins under
//!   `windows.<label>.pins`, at most [`PINS_MAX`], read and written only through
//!   [`GroupStore::window_pins`] and [`GroupStore::set_window_pins`]. An entry for a window that
//!   isn't open is kept, and every other key in the file is written back as it was.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::leaf_id::{leaf_ref_problem, Layer};
use super::ops::{apply, touched_keys, KitOp, OpFailed};
use super::shape::{GroupFile, OwnerKind, SavedNode, Tombstone, VERSION};
use super::tile_key::tile_key;
use crate::context_repo::scratch_space::{self, ScratchOrgSpace};
use crate::domain::Principal;

/// The folder under a space's `config/` that holds the group files.
const GROUPS_DIR: &str = "groups";
/// The scratch repo's exclude entries for the group folder of a space, one per org layout
/// (`orgs/<owner>/<repo>` and a one-segment `orgs/<name>`). Each leads with `/`, so it is
/// anchored to the repo root and a user's own `config/groups` folder elsewhere stays tracked.
pub const GROUPS_EXCLUDES: [&str; 2] = ["/orgs/*/*/config/groups/", "/orgs/*/config/groups/"];
/// The reason a file that can't be loaded is listed with.
pub const UNREADABLE: &str = "can't be read";

const ID_MAX: usize = 64;
const FILE_SUFFIX: &str = ".json";

/// The group folder's lock file, which every app process locks around a write.
const LOCK_FILE: &str = ".lock";
/// The group folder's file of window pins, and the id its stem would be.
const INDEX_FILE: &str = "index.json";
const INDEX_ID: &str = "index";
/// The most pins a window holds.
pub const PINS_MAX: usize = 3;
/// The longest window label the pins file keys.
const LABEL_MAX: usize = 128;

/// How many writes per file the store remembers for a rebase.
const HISTORY_MAX: usize = 64;

/// The one lock every group write holds.
static WRITE: Mutex<()> = Mutex::new(());
/// Per group file, the last writes [`GroupStore::write`] placed, oldest first. In memory only: a
/// restart, a [`GroupStore::commit`] or another process's write leaves a gap, and a person's
/// write on a base before the gap is a plain conflict.
static HISTORY: Mutex<BTreeMap<PathBuf, VecDeque<Placed>>> = Mutex::new(BTreeMap::new());

/// A space's group folder.
pub fn groups_dir(space: &ScratchOrgSpace) -> PathBuf {
    space.config_dir().join(GROUPS_DIR)
}

/// Whether a path under the scratch repo, as segments, is in a space's group folder
/// (`orgs/<owner>/<repo>/config/groups/…`, or `orgs/<name>/config/groups/…` for a one-segment org).
pub fn is_group_path(parts: &[String]) -> bool {
    let at = |start: usize| {
        parts.len() >= start + 2
            && parts[start] == crate::context_repo::CONFIG_DIR
            && parts[start + 1] == GROUPS_DIR
    };
    parts.first().is_some_and(|first| first == "orgs") && (at(2) || at(3))
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
    Conflict {
        current_revision: u64,
    },
    /// A person's rebased op can't run because an agent's write since its `baseRev` touched one
    /// of its tile keys; the agent's write stays and nothing changed.
    Collided(Collision),
    /// The tree holds a ref or a split the store refuses; nothing changed.
    InvalidTree(String),
    /// An op the store doesn't run, or one that can't run on the head it was sent for.
    InvalidOp(String),
    /// No such group.
    NotFound,
    /// A window already holds [`PINS_MAX`] pins; nothing changed.
    PinsFull,
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
            Self::Collided(collision) => write!(
                f,
                "an agent changed {} since; the group is at revision {}",
                collision.keys.join(", "),
                collision.current_revision
            ),
            Self::InvalidTree(why) => write!(f, "refused: {why}"),
            Self::InvalidOp(why) => write!(f, "refused: {why}"),
            Self::NotFound => f.write_str("no such group"),
            Self::PinsFull => write!(f, "a window holds at most {PINS_MAX} pins"),
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

/// Who a write comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Writer {
    /// A person, through the window with this label.
    Person { window: String },
    /// An agent, through the MCP session with this id.
    Agent { session: String },
    /// The app itself, for this reason.
    System { kind: String },
}

/// A write through [`GroupStore::write`]: kit ops on the tree at `base_rev`, leaving a file of
/// `owner`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreWrite {
    pub writer: Writer,
    pub base_rev: u64,
    pub owner: OwnerKind,
    pub ops: Vec<KitOp>,
}

/// A write the store placed: its `rev`, its writer and the tile keys its ops touched.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    pub rev: u64,
    pub by: Writer,
    pub keys: Vec<String>,
}

/// A person's rebased op that met an agent's write: the head's `rev`, the person op's
/// `base_rev`, the tile keys both touched and the agents that wrote them.
#[derive(Debug, Clone, PartialEq)]
pub struct Collision {
    pub current_revision: u64,
    pub base_rev: u64,
    pub keys: Vec<String>,
    pub agents: Vec<Writer>,
}

/// Told of every [`Collision`] once, before the write returns it.
pub type CollisionHook = std::sync::Arc<dyn Fn(&Collision) + Send + Sync>;

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

/// What a planned write lays down.
enum Body {
    File(GroupFile),
    Tombstone(Tombstone),
}

/// A write planned from the head, before anything is written.
struct Planned {
    rev: u64,
    body: Body,
    placed: Option<Placed>,
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
    collision_hook: Option<CollisionHook>,
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
            collision_hook: None,
        })
    }

    /// Writes under the watcher's suppression, so the app's own write raises no change event.
    pub fn with_suppression(mut self, handle: crate::content_engine::SuppressionHandle) -> Self {
        self.suppression = Some(handle);
        self
    }

    /// The context repo this store holds the groups of, so a view of them is keyed by it.
    pub fn org(&self) -> &str {
        &self.org
    }

    /// Whether this store runs with tiles on.
    pub fn tiles(&self) -> bool {
        self.tiles
    }

    /// Tells `hook` of each collision a person's write meets.
    pub fn with_collision_hook(mut self, hook: CollisionHook) -> Self {
        self.collision_hook = Some(hook);
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

    /// The group `id`'s head for a client: `None` when it never existed, its `rev` and no tree
    /// when it was deleted (a new file continues from that `rev`), else its `rev` and tree,
    /// repaired in memory. Reads only.
    pub fn group_head(&self, id: &str) -> Result<Option<(u64, Option<SavedNode>)>, StoreError> {
        let path = self.group_file(id)?;
        match read_head(&path) {
            Head::Absent => Ok(None),
            Head::Deleted(rev) => Ok(Some((rev, None))),
            Head::File(loaded) => Ok(Some((loaded.file.rev, loaded.file.root))),
            Head::Unreadable => Err(StoreError::Unreadable),
        }
    }

    /// Puts or deletes the group `id` whole when `base_rev` is its head `rev` (0 for a group that
    /// never existed, the tombstone's for a deleted one). Returns the new `rev`. It records no
    /// writer, so a person's write on an older base can't be rebased across it.
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
        let planned = self.transact(path, |_, head| {
            let (head_rev, live) = match head {
                Head::Unreadable => return Err(StoreError::Unreadable),
                Head::Absent => (0, false),
                Head::Deleted(rev) => (*rev, false),
                Head::File(loaded) => (loaded.file.rev, true),
            };
            if matches!(change, Change::Delete) && !live {
                return Err(StoreError::NotFound);
            }
            if base_rev != head_rev {
                return Err(StoreError::Conflict {
                    current_revision: head_rev,
                });
            }
            let rev = next_rev(head_rev)?;
            let body = match &change {
                Change::Put { owner, root } => Body::File(GroupFile {
                    version: VERSION,
                    owner: *owner,
                    rev,
                    root: root.clone(),
                }),
                Change::Delete => Body::Tombstone(Tombstone {
                    version: VERSION,
                    deleted: true,
                    rev,
                }),
            };
            Ok(Planned {
                rev,
                body,
                placed: None,
            })
        })?;
        Ok(planned.rev)
    }

    /// Runs `write.ops` on the group `id` and writes the tree they leave: the entry for every
    /// writer. At the head `rev` the ops run on the head. On an older `baseRev`, a person's ops
    /// are rebased onto the head and win; an agent's or the system's write is a
    /// [`StoreError::Conflict`]. A rebased op that can't run is a [`StoreError::Collided`] when an
    /// agent's write since `baseRev` touched one of its tile keys, and a plain conflict otherwise
    /// (or when the store holds no record of every write since `baseRev`). Nothing is written on
    /// any refusal.
    pub fn write(&self, id: &str, write: StoreWrite) -> Result<Placed, StoreError> {
        if !self.tiles {
            return Err(StoreError::TilesOff);
        }
        let path = self.group_file(id)?;
        if Vec::is_empty(&write.ops) {
            return Err(StoreError::InvalidOp(
                "a write holds one or more ops".into(),
            ));
        }
        if write
            .ops
            .iter()
            .any(|op| matches!(op, KitOp::Pin { .. } | KitOp::Unpin { .. }))
        {
            return Err(StoreError::InvalidOp(
                "a pin is not a tree op; the window's pins hold it".into(),
            ));
        }
        let planned = self
            .transact(path, |path, head| plan_write(path, head, &write))
            .inspect_err(|error| {
                if let (StoreError::Collided(collision), Some(hook)) = (error, &self.collision_hook)
                {
                    hook(collision);
                }
            })?;
        planned
            .placed
            .ok_or_else(|| StoreError::Io("the write placed nothing".into()))
    }

    /// The pins of the window labelled `label`, oldest first: the one read of `windows.*`. A
    /// window with no entry has none. Reads only: a key the leaf-id grammar refuses is left out
    /// here and stays in the file until the window's next write of its pins.
    ///
    /// The file is the context repo's, so a person who switches org sees that org's pins for the
    /// window. One profile-wide record replaces it when the windows' own registry imports it.
    pub fn window_pins(&self, label: &str) -> Result<Vec<String>, StoreError> {
        if let Some(why) = label_problem(label) {
            return Err(StoreError::Refused(why));
        }
        let path = self.index_file()?;
        let index = read_index(&path)?;
        let mut pins: Vec<String> = vec![];
        if let Some(entry) = BTreeMap::get(&index.windows, label) {
            for key in &entry.pins {
                if Result::is_ok(&tile_key(key, Layer::Private)) {
                    pins.push(String::clone(key));
                }
            }
        }
        Ok(pins)
    }

    /// Replaces the pins of the window labelled `label` with `pins`, in one write: the one write
    /// of `windows.*`. Refused with the tiles flag off, past [`PINS_MAX`], for a key pinned twice
    /// or one the leaf-id grammar refuses, and for a pins file that can't be read, which is never
    /// rewritten. Every other window's entry and every other key stay as they were.
    pub fn set_window_pins(&self, label: &str, pins: Vec<String>) -> Result<(), StoreError> {
        if !self.tiles {
            return Err(StoreError::TilesOff);
        }
        if let Some(why) = label_problem(label) {
            return Err(StoreError::Refused(why));
        }
        if pins.len() > PINS_MAX {
            return Err(StoreError::PinsFull);
        }
        for (at, key) in pins.iter().enumerate() {
            if let Err(why) = tile_key(key, Layer::Private) {
                return Err(StoreError::InvalidOp(why));
            }
            if pins[..at].contains(key) {
                return Err(StoreError::InvalidOp(format!("{key:?} is pinned twice")));
            }
        }
        let _write = WRITE
            .lock()
            .map_err(|_| StoreError::Io("the group store is unavailable".into()))?;
        read_index(&self.index_file()?)?;
        scratch_space::open_group_space(&self.home, &self.principal, &self.org, self.tiles)
            .map_err(|e| StoreError::Io(e.to_string()))?;
        let _folder = self.lock_folder()?;
        let path = self.index_file()?;
        let mut index = read_index(&path)?;
        let entry = index.windows.entry(String::from(label)).or_default();
        entry.pins = pins;
        self.write_json(&path, &index)
    }

    /// The pins file, its folders and itself checked.
    fn index_file(&self) -> Result<PathBuf, StoreError> {
        self.checked_path(self.group_dir().join(INDEX_FILE))
    }

    /// Plans a write from the head under the process lock and, when the plan passes, plans it
    /// again under the folder's lock, which another process takes too, and writes it. The first
    /// plan refuses before the space's folders are made.
    fn transact(
        &self,
        path: PathBuf,
        plan: impl Fn(&Path, &Head) -> Result<Planned, StoreError>,
    ) -> Result<Planned, StoreError> {
        let _write = WRITE
            .lock()
            .map_err(|_| StoreError::Io("the group store is unavailable".into()))?;
        let path = self.checked_path(path)?;
        plan(&path, &read_head(&path))?;
        scratch_space::open_group_space(&self.home, &self.principal, &self.org, self.tiles)
            .map_err(|e| StoreError::Io(e.to_string()))?;
        let _folder = self.lock_folder()?;
        let path = self.checked_path(path)?;
        let planned = plan(&path, &read_head(&path))?;
        match &planned.body {
            Body::File(file) => self.write_json(&path, file)?,
            Body::Tombstone(tombstone) => self.write_json(&path, tombstone)?,
        }
        record(&path, planned.placed.clone());
        Ok(planned)
    }

    /// The group folder's lock file, opened without following a link and locked: held while a
    /// write reads the head and replaces the file, so two app processes never interleave.
    fn lock_folder(&self) -> Result<std::fs::File, StoreError> {
        let path = self.group_dir().join(LOCK_FILE);
        let mut options = std::fs::OpenOptions::new();
        std::fs::OpenOptions::write(&mut options, true);
        std::fs::OpenOptions::truncate(&mut options, false);
        std::fs::OpenOptions::create(&mut options, true);
        let file = codesense_platform::fs::open_nofollow(&mut options, &path)
            .map_err(|e| StoreError::Refused(format!("the group folder's lock: {e}")))?;
        codesense_platform::fs::lock_exclusive(&file)
            .map_err(|e| StoreError::Io(format!("the group folder's lock: {e}")))?;
        Ok(file)
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
            return Err(StoreError::Refused(
                "the path leaves the group folder".into(),
            ));
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
                return Err(StoreError::Refused(
                    "the group folder is not normalized".into(),
                ));
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

    fn write_json<T: serde::Serialize>(&self, path: &Path, value: &T) -> Result<(), StoreError> {
        let tmp = path.with_extension("json.tmp");
        let _quiet = self.suppression.as_ref().map(|handle| {
            crate::content_engine::Suppression::new(handle, [path.to_path_buf(), tmp])
        });
        crate::shared::json_io::write_json_atomic_private(path, value)
            .map_err(|e| StoreError::Io(e.to_string()))
    }
}

/// The pins file: each window's entry by label, and any other key as it was read.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Index {
    #[serde(default)]
    windows: BTreeMap<String, WindowEntry>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

/// One window's entry: its pins, and any other key as it was read.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct WindowEntry {
    #[serde(default)]
    pins: Vec<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

/// The pins file at `path`: empty when there is none, [`StoreError::Unreadable`] when it isn't a
/// plain file holding that shape. Never follows a symlink.
fn read_index(path: &Path) -> Result<Index, StoreError> {
    match std::fs::symlink_metadata(path) {
        Err(e) if std::io::Error::kind(&e) == std::io::ErrorKind::NotFound => {
            return Ok(Index::default())
        }
        Ok(meta) if meta.is_file() => {}
        _ => return Err(StoreError::Unreadable),
    }
    let bytes = std::fs::read(path).map_err(|_| StoreError::Unreadable)?;
    serde_json::from_slice::<Index>(&bytes).map_err(|_| StoreError::Unreadable)
}

/// Why `label` is not a window label (`[A-Za-z0-9-/:_]{1,128}`, as Tauri names a window), or
/// `None`.
fn label_problem(label: &str) -> Option<String> {
    let valid = !str::is_empty(label)
        && label.len() <= LABEL_MAX
        && !label
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
    (!valid).then(|| format!("{label:?} is not a window label"))
}

/// The `rev` after `head_rev`.
fn next_rev(head_rev: u64) -> Result<u64, StoreError> {
    head_rev
        .checked_add(1)
        .ok_or_else(|| StoreError::Io("the group's revision is at its limit".into()))
}

/// The file `write` leaves on `head`, or why it leaves none.
fn plan_write(path: &Path, head: &Head, write: &StoreWrite) -> Result<Planned, StoreError> {
    let (head_rev, root) = match head {
        Head::Unreadable => return Err(StoreError::Unreadable),
        Head::Absent => (0, None),
        Head::Deleted(rev) => (*rev, None),
        Head::File(loaded) => (loaded.file.rev, loaded.file.root.clone()),
    };
    let stale = StoreError::Conflict {
        current_revision: head_rev,
    };
    let (root, keys) = if write.base_rev == head_rev {
        run(root, &write.ops).map_err(|failed| {
            StoreError::InvalidOp(format!(
                "an op can't run on the group: {}",
                failed.keys.join(", ")
            ))
        })?
    } else {
        if write.base_rev > head_rev || !matches!(write.writer, Writer::Person { .. }) {
            return Err(stale);
        }
        let Some(since) = placed_since(path, write.base_rev, head_rev) else {
            return Err(stale);
        };
        match run(root, &write.ops) {
            Ok(done) => done,
            Err(failed) => {
                let agent_keys: BTreeSet<&str> = since
                    .iter()
                    .filter(|placed| matches!(placed.by, Writer::Agent { .. }))
                    .flat_map(|placed| placed.keys.iter().map(String::as_str))
                    .collect();
                let collided: Vec<String> = failed
                    .keys
                    .into_iter()
                    .filter(|key| agent_keys.contains(&**key))
                    .collect();
                if Vec::is_empty(&collided) {
                    return Err(stale);
                }
                let mut agents: Vec<Writer> = vec![];
                for placed in since {
                    let met = matches!(placed.by, Writer::Agent { .. })
                        && placed.keys.iter().any(|key| collided.contains(key));
                    if met && !agents.contains(&placed.by) {
                        agents.push(placed.by);
                    }
                }
                return Err(StoreError::Collided(Collision {
                    current_revision: head_rev,
                    base_rev: write.base_rev,
                    keys: collided,
                    agents,
                }));
            }
        }
    };
    if let Some(why) = root.as_ref().and_then(tree_problem) {
        return Err(StoreError::InvalidTree(why));
    }
    let rev = next_rev(head_rev)?;
    Ok(Planned {
        rev,
        body: Body::File(GroupFile {
            version: VERSION,
            owner: write.owner,
            rev,
            root,
        }),
        placed: Some(Placed {
            rev,
            by: write.writer.clone(),
            keys,
        }),
    })
}

/// `ops` run in turn on `root`, and every tile key they touched, in order.
fn run(
    mut root: Option<SavedNode>,
    ops: &[KitOp],
) -> Result<(Option<SavedNode>, Vec<String>), OpFailed> {
    let mut keys: Vec<String> = vec![];
    for op in ops {
        for key in touched_keys(root.as_ref(), op) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        root = apply(root, op)?;
    }
    Ok((root, keys))
}

/// Records the write just placed at `path`; `None` (a write with no record) forgets the file's
/// history, so no rebase crosses it.
fn record(path: &Path, placed: Option<Placed>) {
    let mut history = HISTORY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match placed {
        None => {
            history.remove(path);
        }
        Some(placed) => {
            let writes = history.entry(path.to_path_buf()).or_default();
            writes.push_back(placed);
            while writes.len() > HISTORY_MAX {
                writes.pop_front();
            }
        }
    }
}

/// Every write placed at `path` after `base_rev` up to `head_rev`, or `None` when the history
/// misses one.
fn placed_since(path: &Path, base_rev: u64, head_rev: u64) -> Option<Vec<Placed>> {
    let history = HISTORY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let since: Vec<Placed> = history
        .get(path)?
        .iter()
        .filter(|placed| placed.rev > base_rev)
        .cloned()
        .collect();
    let whole = Iterator::all(&mut since.iter().zip(base_rev + 1..), |(placed, rev)| {
        placed.rev == rev
    }) && <[Placed]>::last(&since).map(|placed| placed.rev) == Some(head_rev);
    whole.then_some(since)
}

/// Why `id` is not a group id, or `None`.
fn id_problem(id: &str) -> Option<String> {
    let valid = !str::is_empty(id)
        && id.len() <= ID_MAX
        && !is_device_name(id)
        && id != INDEX_ID
        && !id
            .chars()
            .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    (!valid).then(|| format!("{id:?}: a group id is [a-z0-9-]{{1,64}}, never {INDEX_ID:?}"))
}

/// A Windows device name (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`). Windows maps
/// it to the device whatever the extension, so `nul.json` is not a file. Refused on every
/// platform, so a file written on one machine stays loadable on another. An id holds no dot, so
/// the whole id is the stem.
fn is_device_name(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let numbered = |prefix: &str| {
        id.strip_prefix(prefix)
            .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
    };
    matches!(&*id, "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt")
}

/// Why a saved leaf is refused: its `id` and `workspaceId` differ, or the ref isn't valid in the
/// private layer. The one leaf rule, shared by the write check and the load repair.
fn leaf_problem(id: &str, workspace_id: &str) -> Option<String> {
    if id != workspace_id {
        return Some(format!(
            "a leaf's id {id:?} and workspaceId {workspace_id:?} differ"
        ));
    }
    leaf_ref_problem(id, Layer::Private)
}

/// Why a split's shape is refused: fewer than two children, not one size per child, or a size
/// that is not a finite number of 0 or more. The one split rule, shared as `leaf_problem` is.
fn split_problem(children: usize, sizes: &[f64]) -> Option<String> {
    if children < 2 {
        return Some("a split has two or more children".into());
    }
    if sizes.len() != children {
        return Some("a split has one size per child".into());
    }
    sizes
        .iter()
        .any(|s| !s.is_finite() || *s < 0.0)
        .then(|| "a size is a finite number, 0 or more".into())
}

/// Why the store refuses `node`, or `None`.
fn tree_problem(node: &SavedNode) -> Option<String> {
    match node {
        SavedNode::Leaf { id, workspace_id } => leaf_problem(id, workspace_id),
        SavedNode::Split {
            children, sizes, ..
        } => {
            split_problem(children.len(), sizes).or_else(|| children.iter().find_map(tree_problem))
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
            let workspace_id = object
                .get("workspaceId")
                .and_then(serde_json::Value::as_str);
            match (id, workspace_id) {
                (Some(id), Some(workspace_id)) if leaf_problem(id, workspace_id).is_none() => {
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
            let numbers: Vec<f64> = sizes
                .iter()
                .map(serde_json::Value::as_f64)
                .collect::<Option<_>>()?;
            if split_problem(children.len(), &numbers).is_some() {
                return None;
            }
            let mut kept = vec![];
            for (child, size) in children.iter().zip(numbers) {
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
