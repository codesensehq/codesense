// SPDX-License-Identifier: MIT
//! The user's GIF search settings and the provider key, with the Tauri commands the Settings
//! card calls. Settings live in `gif.json` in the app data dir (On or Off, the provider, the
//! rating ceiling and which key fingerprints are production keys); the key lives only in the OS
//! keychain item the provider names, under the OS login name. No MCP tool reaches either.
use super::{fingerprint, GifError, Provider, Rating};
use crate::commands::credential_store::{
    default_store, secret_store_available, CredentialStore, Secret,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

/// The settings file's name in the app data dir.
pub(crate) const FILE: &str = "gif.json";
/// The longest a search waits for the keychain: past it, an access prompt is waiting on the user.
pub(crate) const KEY_READ_TIMEOUT: Duration = Duration::from_secs(3);
const NO_STORE: &str = "This computer has no secret store, so the key can't be kept here.";
/// Held while `gif.json` is read, changed and written.
static WRITE: Mutex<()> = std::sync::Mutex::new(());

/// What `gif.json` holds. A missing or unreadable file, or field, reads as its default: On,
/// GIPHY, a pg ceiling and no production key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GifSettings {
    pub enabled: bool,
    pub provider: Provider,
    pub ceiling: Rating,
    /// `<provider>:<fingerprint>` for each key the user marked production.
    pub production_keys: Vec<String>,
}
impl Default for GifSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: Provider::Giphy,
            ceiling: Rating::Pg,
            production_keys: Vec::new(),
        }
    }
}
impl GifSettings {
    pub(crate) fn is_production(&self, provider: Provider, fingerprint: &str) -> bool {
        self.production_keys
            .contains(&production_key(provider, fingerprint))
    }
    fn clear_production(&mut self, provider: Provider) {
        let prefix = format!("{}:", provider.as_str());
        let kept = std::mem::take(&mut self.production_keys)
            .into_iter()
            .filter(|k| !k.starts_with(&prefix));
        self.production_keys = kept.collect();
    }
}

fn production_key(provider: Provider, fingerprint: &str) -> String {
    format!("{}:{fingerprint}", provider.as_str())
}

fn valid_production_key(value: &str) -> bool {
    value.split_once(':').is_some_and(|(provider, fp)| {
        Provider::parse(provider).is_some_and(|p| p.as_str() == provider)
            && fp.len() == 16
            && !fp.contains(|c: char| !matches!(c, '0'..='9' | 'a'..='f'))
    })
}

/// The settings in `dir`, each field read on its own so one bad value falls back alone.
pub(crate) fn load(dir: &Path) -> GifSettings {
    let defaults = GifSettings::default();
    let Ok(bytes) = std::fs::read(dir.join(FILE)) else {
        return defaults;
    };
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&bytes) else {
        return defaults;
    };
    GifSettings {
        enabled: map
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.enabled),
        provider: map
            .get("provider")
            .and_then(Value::as_str)
            .and_then(Provider::parse)
            .unwrap_or(defaults.provider),
        ceiling: map
            .get("ceiling")
            .and_then(Value::as_str)
            .and_then(Rating::parse)
            .unwrap_or(defaults.ceiling),
        production_keys: map
            .get("productionKeys")
            .and_then(Value::as_array)
            .map(|keys| {
                keys.iter()
                    .filter_map(Value::as_str)
                    .filter(|k| valid_production_key(k))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Change the settings in `dir` under the write lock, and replace the file atomically.
fn update(dir: &Path, change: impl FnOnce(&mut GifSettings)) -> Result<GifSettings, String> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(dir);
    change(&mut settings);
    let write = || -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(&settings)?;
        codesense_platform::fs::atomic_replace(&dir.join(FILE), &bytes)?;
        Ok(())
    };
    write().map_err(|_| "Couldn't save the GIF search settings. Nothing changed.".to_string())?;
    Ok(settings)
}

/// Keys shorter than this are refused, and the Settings card shows the last 4 characters only of
/// a key at least this long.
pub(crate) const MIN_KEY_CHARS: usize = 16;

/// The key read in flight and the key last read, shared by every clone of one [`Keys`].
#[derive(Default)]
struct KeyCache {
    reading: std::sync::atomic::AtomicBool,
    /// The key last read, and a generation each save and remove moves on, so a read that
    /// started before one of them never caches the key it replaced.
    key: Mutex<(u64, Option<(Provider, Secret)>)>,
}

/// The provider key in the OS keychain. The secret store is checked before every keyring call:
/// on a computer without one (Windows today) the keyring is an in-memory stand-in, which must
/// never read as a saved key. A key read is single-flight: while one is running (an access
/// prompt waiting on the user), a search does not start another. The last key read is kept in
/// memory until a save or a remove.
#[derive(Clone)]
pub(crate) struct Keys {
    stores: Arc<dyn Fn(Provider) -> Arc<dyn CredentialStore> + Send + Sync>,
    available: Arc<dyn Fn() -> bool + Send + Sync>,
    account: Option<String>,
    read_timeout: Duration,
    cache: Arc<KeyCache>,
}

impl Keys {
    /// The OS keychain, the secret store probe and the OS login name.
    pub(crate) fn system() -> Self {
        Self {
            stores: Arc::new(|provider: Provider| -> Arc<dyn CredentialStore> {
                Arc::from(default_store(provider.key_service()))
            }),
            available: Arc::new(secret_store_available),
            account: codesense_platform::user::login_name(),
            read_timeout: KEY_READ_TIMEOUT,
            cache: Arc::new(KeyCache::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn new(
        store: Arc<dyn CredentialStore>,
        available: bool,
        account: Option<&str>,
        read_timeout: Duration,
    ) -> Self {
        Self::per_provider(move |_| store.clone(), available, account, read_timeout)
    }

    /// Keys with one store per provider, as the keychain's items are.
    #[cfg(test)]
    pub(crate) fn per_provider(
        stores: impl Fn(Provider) -> Arc<dyn CredentialStore> + Send + Sync + 'static,
        available: bool,
        account: Option<&str>,
        read_timeout: Duration,
    ) -> Self {
        Self {
            stores: Arc::new(stores),
            available: Arc::new(move || available),
            account: account.map(str::to_string),
            read_timeout,
            cache: Arc::new(KeyCache::default()),
        }
    }

    /// The store and account to use, or why there are none.
    fn reach(&self, provider: Provider) -> Result<(Arc<dyn CredentialStore>, &str), GifError> {
        if !(self.available)() {
            return Err(GifError::NoSecretStore);
        }
        let account = self
            .account
            .as_deref()
            .ok_or(GifError::KeychainUnavailable)?;
        Ok(((self.stores)(provider), account))
    }

    /// The cache's generation, taken when a read starts.
    fn generation(&self) -> u64 {
        self.cache.key.lock().unwrap_or_else(|e| e.into_inner()).0
    }

    /// Cache `entry`: from a read that started at generation `read_at`, only when no save or
    /// remove has happened since; from a save or remove (`None`), always, moving the generation.
    fn remember(&self, entry: Option<(Provider, Secret)>, read_at: Option<u64>) {
        let mut cached = self.cache.key.lock().unwrap_or_else(|e| e.into_inner());
        match read_at {
            Some(generation) if generation != cached.0 => {}
            Some(_) => cached.1 = entry,
            None => *cached = (cached.0 + 1, entry),
        }
    }

    #[cfg(test)]
    pub(crate) fn has_cached_key(&self) -> bool {
        self.cache.key.lock().unwrap().1.is_some()
    }

    #[cfg(test)]
    pub(crate) fn is_reading(&self) -> bool {
        self.cache.reading.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The saved key, trimmed (an item saved outside the app may end in a newline); `None` when
    /// there is none. Blocking: it may raise a keychain prompt.
    pub(crate) fn read_key(&self, provider: Provider) -> Result<Option<Secret>, GifError> {
        let (store, account) = self.reach(provider)?;
        let read_at = self.generation();
        let key = match store.get(account) {
            Ok(Some(key)) => Some(key.expose().trim().to_string()),
            Ok(None) => None,
            Err(_) => return Err(GifError::KeychainUnavailable),
        };
        let key = key.filter(|k| k != "").map(Secret::new);
        self.remember(key.clone().map(|k| (provider, k)), Some(read_at));
        Ok(key)
    }

    /// The key for a search: the one last read, else one [`Self::read_key`] off the async
    /// threads, given up after the read timeout so a keychain prompt never holds a search. While
    /// a read is still running no other starts. No key is [`GifError::NoProvider`].
    pub(crate) async fn read_timed(&self, provider: Provider) -> Result<Secret, GifError> {
        if !(self.available)() {
            return Err(GifError::NoSecretStore);
        }
        let cached = match &self.cache.key.lock().unwrap_or_else(|e| e.into_inner()).1 {
            Some((p, key)) if *p == provider => Some(key.clone()),
            _ => None,
        };
        if let Some(key) = cached {
            return Ok(key);
        }
        let reading = &self.cache.reading;
        if reading.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Err(GifError::KeychainUnavailable);
        }
        let keys = self.clone();
        let read = tokio::task::spawn_blocking(move || {
            let key = keys.read_key(provider);
            keys.cache
                .reading
                .store(false, std::sync::atomic::Ordering::SeqCst);
            key
        });
        match tokio::time::timeout(self.read_timeout, read).await {
            Ok(Ok(Ok(Some(key)))) => Ok(key),
            Ok(Ok(Ok(None))) => Err(GifError::NoProvider),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => {
                reading.store(false, std::sync::atomic::Ordering::SeqCst);
                Err(GifError::KeychainUnavailable)
            }
            Err(_) => Err(GifError::KeychainUnavailable),
        }
    }

    /// Save `key`, which [`check_key`] has passed. Blocking.
    pub(crate) fn save_key(&self, provider: Provider, key: &str) -> Result<(), String> {
        let key = check_key(provider, key)?;
        let (store, account) = self.reach(provider).map_err(|_| NO_STORE.to_string())?;
        let secret = Secret::new(key);
        store
            .set(account, &secret)
            .map_err(|_| "Couldn't save the key to your OS keychain.".to_string())?;
        self.remember(Some((provider, secret)), None);
        Ok(())
    }

    /// Remove the saved key. Blocking.
    pub(crate) fn remove_key(&self, provider: Provider) -> Result<(), String> {
        let (store, account) = self.reach(provider).map_err(|_| NO_STORE.to_string())?;
        CredentialStore::delete(store.as_ref(), account)
            .map_err(|_| "Couldn't remove the key from your OS keychain.".to_string())?;
        self.remember(None, None);
        Ok(())
    }
}

/// `key` trimmed, or why it can't be a key: empty, spaces or other non-printing characters,
/// longer than 256 bytes or shorter than [`MIN_KEY_CHARS`].
pub(crate) fn check_key(provider: Provider, key: &str) -> Result<String, String> {
    let key = key.trim();
    let name = Provider::display_name(provider);
    if key == "" {
        return Err(format!("Enter a {name} key."));
    }
    if key.contains(|c: char| !c.is_ascii_graphic()) || key.len() > 256 {
        return Err(format!(
            "A {name} key has only letters, digits and symbols, with no spaces."
        ));
    }
    if key.chars().count() < MIN_KEY_CHARS {
        return Err(format!(
            "A {name} key has at least {MIN_KEY_CHARS} characters. Check that you pasted all of \
             it."
        ));
    }
    Ok(key.to_string())
}

/// What the Settings card shows for On/Off, the provider and the ceiling.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub enabled: bool,
    pub provider: Provider,
    pub ceiling: Rating,
}
fn view(settings: &GifSettings) -> SettingsView {
    SettingsView {
        enabled: settings.enabled,
        provider: settings.provider,
        ceiling: settings.ceiling,
    }
}

/// A change from the Settings card; each field that is set changes.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub ceiling: Option<String>,
    /// Mark the saved key as a production key (no local cap), or not.
    #[serde(default)]
    pub production: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyState {
    Missing,
    Saved,
    Unavailable,
}

/// What the Settings card shows for the key: never the key, only the last 4 characters of one
/// at least [`MIN_KEY_CHARS`] long.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub status: KeyState,
    pub hint: Option<String>,
    pub production: bool,
}

/// The key's status, read fresh from the keychain (the read that may raise an access prompt,
/// while the user is in Settings to allow it).
pub(crate) fn status_with(keys: &Keys, dir: &Path) -> KeyStatus {
    let settings = load(dir);
    match keys.read_key(settings.provider) {
        Ok(Some(key)) => {
            let chars: Vec<char> = key.expose().chars().collect();
            let hint = (chars.len() >= MIN_KEY_CHARS).then(|| {
                let tail: String = chars[chars.len() - 4..].iter().collect();
                format!("…{tail}")
            });
            KeyStatus {
                status: KeyState::Saved,
                hint,
                production: settings.is_production(settings.provider, &fingerprint(&key)),
            }
        }
        Ok(None) => KeyStatus {
            status: KeyState::Missing,
            hint: None,
            production: false,
        },
        Err(_) => KeyStatus {
            status: KeyState::Unavailable,
            hint: None,
            production: false,
        },
    }
}

/// Save a new key. Its production flag is cleared first, as a replaced key's is, so a failed
/// save never leaves a new key marked production.
pub(crate) fn save_with(keys: &Keys, dir: &Path, key: &str) -> Result<KeyStatus, String> {
    let current = load(dir);
    let provider = current.provider;
    // A key that can't be one changes nothing, the current key's production flag included.
    check_key(provider, key).map_err(|error| format!("{error} Nothing changed."))?;
    let had_production = current.production_keys.len() > 0;
    update(dir, |s| s.clear_production(provider))?;
    keys.save_key(provider, key).map_err(|error| {
        if had_production {
            format!("{error} The saved key stays, no longer marked as a production key.")
        } else {
            format!("{error} Nothing changed.")
        }
    })?;
    // The old key's install id goes with it; the new key gets its own on its first ping.
    super::register::forget_install(dir);
    Ok(status_with(keys, dir))
}

/// Remove the key and its production flag (the flag first, so a failed remove never leaves a
/// half-applied state behind it).
pub(crate) fn remove_with(keys: &Keys, dir: &Path) -> Result<KeyStatus, String> {
    let provider = load(dir).provider;
    update(dir, |s| s.clear_production(provider))?;
    keys.remove_key(provider)?;
    super::register::forget_install(dir);
    Ok(status_with(keys, dir))
}

pub(crate) fn set_with(
    keys: &Keys,
    dir: &Path,
    change: SettingsUpdate,
) -> Result<SettingsView, String> {
    let ceiling = change
        .ceiling
        .as_deref()
        .map(|c| Rating::parse(c).ok_or("The rating ceiling is g, pg or pg-13."))
        .transpose()?;
    let production = match change.production {
        Some(flag) => {
            let provider = load(dir).provider;
            let key = keys
                .read_key(provider)
                .map_err(|_| "Couldn't read the key from your OS keychain.".to_string())?
                .ok_or_else(|| format!("Save a {} key first.", Provider::display_name(provider)))?;
            Some((provider, fingerprint(&key), flag))
        }
        None => None,
    };
    let settings = update(dir, |s| {
        if let Some(enabled) = change.enabled {
            s.enabled = enabled;
        }
        if let Some(ceiling) = ceiling {
            s.ceiling = ceiling;
        }
        if let Some((provider, fp, flag)) = production {
            s.clear_production(provider);
            if flag {
                s.production_keys.push(production_key(provider, &fp));
            }
        }
    })?;
    if !settings.enabled {
        // Off: no pings, and nothing that identifies the install stays.
        super::register::forget_install(dir);
    }
    Ok(view(&settings))
}

pub(crate) fn data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    tauri::Manager::path(app)
        .app_data_dir()
        .map_err(|_| "GIF search has no app data folder".to_string())
}

/// The service's keys and folder, so a save or remove here reaches the key a search uses.
fn service_keys(app: &tauri::AppHandle) -> Result<(Keys, PathBuf), String> {
    let service = super::service(app)?;
    Ok((service.keys.clone(), service.data_dir().to_path_buf()))
}

#[tauri::command]
pub async fn gif_settings_get(app: tauri::AppHandle) -> Result<SettingsView, String> {
    let dir = data_dir(&app)?;
    crate::commands::await_blocking("gif.settings_get", move || Ok(view(&load(&dir)))).await
}
#[tauri::command]
pub async fn gif_settings_set(
    app: tauri::AppHandle,
    update: SettingsUpdate,
) -> Result<SettingsView, String> {
    let (keys, dir) = service_keys(&app)?;
    crate::commands::await_blocking("gif.settings_set", move || set_with(&keys, &dir, update)).await
}
#[tauri::command]
pub async fn gif_key_status(app: tauri::AppHandle) -> Result<KeyStatus, String> {
    let (keys, dir) = service_keys(&app)?;
    crate::commands::await_blocking("gif.key_status", move || Ok(status_with(&keys, &dir))).await
}
#[tauri::command]
pub async fn gif_key_save(app: tauri::AppHandle, key: String) -> Result<KeyStatus, String> {
    let (keys, dir) = service_keys(&app)?;
    crate::commands::await_blocking("gif.key_save", move || save_with(&keys, &dir, &key)).await
}
#[tauri::command]
pub async fn gif_key_remove(app: tauri::AppHandle) -> Result<KeyStatus, String> {
    let (keys, dir) = service_keys(&app)?;
    crate::commands::await_blocking("gif.key_remove", move || remove_with(&keys, &dir)).await
}
