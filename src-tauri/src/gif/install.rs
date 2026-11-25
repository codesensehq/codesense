// SPDX-License-Identifier: MIT
//! `gif-install.json`: the id each provider knows this install by, per key. GIPHY's is the
//! random id its API issues; KLIPY's is a `customer_id` made here with no network call. Each
//! entry names the fingerprint of the key it was made for, and a write keeps the other
//! provider's entry. Saving or removing a key drops that provider's entry; turning search Off
//! deletes the file.
use super::Provider;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// The install id file's name in the app data dir.
pub(crate) const FILE: &str = "gif-install.json";
/// Held while `gif-install.json` is read to be changed, written or deleted, with each data
/// dir's install epoch: it moves on every forget (search Off, a key removed or replaced), so an
/// id made before one is never saved after it, and what was held for the old id is let go.
static INSTALL_FILE: Mutex<BTreeMap<PathBuf, u64>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The field a provider's id is kept under.
fn id_field(provider: Provider) -> &'static str {
    match provider {
        Provider::Giphy => "randomId",
        Provider::Klipy => "customerId",
    }
}

/// One provider's entry: its id and the fingerprint of the key it was made for.
fn entry(provider: Provider, id: &str, fp: &str) -> serde_json::Value {
    let mut entry = serde_json::Map::new();
    entry.insert(id_field(provider).to_string(), id.into());
    entry.insert("key".to_string(), fp.into());
    serde_json::Value::Object(entry)
}

/// The file's entries, or none when it is missing or not a JSON object.
fn entries(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    let read = std::fs::read(dir.join(FILE));
    match read.map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes)) {
        Ok(Ok(serde_json::Value::Object(map))) => map,
        _ => serde_json::Map::new(),
    }
}

/// The id `provider` knows this install by with the key whose fingerprint is `fp`, if the file
/// holds one.
pub(crate) fn read_install(dir: &Path, provider: Provider, fp: &str) -> Option<String> {
    let entries = entries(dir);
    let entry = entries.get(Provider::as_str(provider))?;
    let id = serde_json::Value::as_str(entry.get(id_field(provider))?)?;
    let key = serde_json::Value::as_str(entry.get("key")?)?;
    (key == fp && super::valid_id(id)).then(|| id.to_string())
}

/// Replace the file with `entries`, or delete it when there are none: a temp file readable by
/// this user only, renamed over the file. The caller holds [`INSTALL_FILE`].
fn replace(
    dir: &Path,
    entries: &serde_json::Map<String, serde_json::Value>,
) -> std::io::Result<()> {
    if entries.is_empty() {
        return match std::fs::remove_file(dir.join(FILE)) {
            Err(e) if std::io::Error::kind(&e) != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(dir)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut temp, &serde_json::to_vec_pretty(entries)?)?;
    codesense_platform::fs::set_owner_only(tempfile::NamedTempFile::path(&temp))?;
    tempfile::NamedTempFile::persist(temp, dir.join(FILE)).map_err(|e| e.error)?;
    Ok(())
}

/// Save `id` as `provider`'s id for the key `fp`, keeping the other provider's entry. `false`,
/// with nothing written, when the epoch moved on from `epoch`.
pub(crate) fn write_install(
    dir: &Path,
    provider: Provider,
    fp: &str,
    id: &str,
    epoch: u64,
) -> std::io::Result<bool> {
    let epochs = lock(&INSTALL_FILE);
    if epochs.get(dir).copied().unwrap_or(0) != epoch {
        return Ok(false);
    }
    let mut entries = entries(dir);
    entries.insert(
        Provider::as_str(provider).to_string(),
        entry(provider, id, fp),
    );
    replace(dir, &entries)?;
    drop(epochs);
    Ok(true)
}

/// KLIPY's `customer_id` for this install and the key `fp`: the saved one, else a random UUID
/// made here and saved, both under one hold of the file. An id that can't be saved, or one made
/// after the epoch moved on from `epoch`, is an error, so no search sends an id a later share
/// would not.
pub(crate) fn customer_id(dir: &Path, fp: &str, epoch: u64) -> std::io::Result<String> {
    let epochs = lock(&INSTALL_FILE);
    if epochs.get(dir).copied().unwrap_or(0) != epoch {
        return Err(std::io::Error::other("the install epoch moved"));
    }
    if let Some(id) = read_install(dir, Provider::Klipy, fp) {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut entries = entries(dir);
    entries.insert(
        Provider::as_str(Provider::Klipy).to_string(),
        entry(Provider::Klipy, &id, fp),
    );
    replace(dir, &entries)?;
    drop(epochs);
    Ok(id)
}

/// The install epoch of `dir` (see [`INSTALL_FILE`]).
pub(crate) fn install_epoch(dir: &Path) -> u64 {
    lock(&INSTALL_FILE).get(dir).copied().unwrap_or(0)
}

/// Delete `gif-install.json`, so nothing that identifies the install stays: GIF search was
/// turned Off. A failure is logged.
pub(crate) fn forget_install(dir: &Path) {
    let mut epochs = lock(&INSTALL_FILE);
    *epochs.entry(dir.to_path_buf()).or_insert(0) += 1;
    match std::fs::remove_file(dir.join(FILE)) {
        Err(e) if std::io::Error::kind(&e) != std::io::ErrorKind::NotFound => {
            log::warn!(target: "gif", "gif registration: the install id could not be deleted: {e}");
        }
        _ => {}
    }
}

/// Drop `provider`'s entry, whose key was removed or replaced, keeping the other's; the file
/// goes when no entry is left. The epoch moves as with [`forget_install`]. A failure is logged.
pub(crate) fn forget_install_for(dir: &Path, provider: Provider) {
    let mut epochs = lock(&INSTALL_FILE);
    *epochs.entry(dir.to_path_buf()).or_insert(0) += 1;
    let mut entries = entries(dir);
    entries.remove(Provider::as_str(provider));
    if let Err(e) = replace(dir, &entries) {
        log::warn!(target: "gif", "gif registration: the {} install id could not be deleted: {e}", provider.display_name());
    }
}
