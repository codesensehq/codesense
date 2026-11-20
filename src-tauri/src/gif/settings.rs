// SPDX-License-Identifier: MIT
//! The user's GIF search settings and the provider key, with the Tauri commands the Settings
//! card calls. Settings live in `gif.json` in the app data dir (On or Off, the provider, the
//! rating ceiling and which key fingerprints are production keys); the key lives only in the
//! Keychain item the provider names, under the OS login name. No MCP tool reaches either.
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
/// The longest a search waits for the Keychain: past it, an access prompt is waiting on the user.
pub(crate) const KEY_READ_TIMEOUT: Duration = Duration::from_secs(3);
const NO_STORE: &str =
    "This computer has no secret store, so the key can't be saved here. Nothing changed.";
/// Held while `gif.json` is read, changed and written.
static WRITE: Mutex<()> = Mutex::new(());

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

/// The provider key in the Keychain. The secret store is checked before every keyring call: on a
/// computer without one (Windows today) the keyring is an in-memory stand-in, which must never
/// read as a saved key.
#[derive(Clone)]
pub(crate) struct Keys {
    stores: Arc<dyn Fn(Provider) -> Arc<dyn CredentialStore> + Send + Sync>,
    available: Arc<dyn Fn() -> bool + Send + Sync>,
    account: Option<String>,
    read_timeout: Duration,
}

impl Keys {
    /// The OS Keychain, the secret store probe and the OS login name.
    pub(crate) fn system() -> Self {
        Self {
            stores: Arc::new(|provider: Provider| -> Arc<dyn CredentialStore> {
                Arc::from(default_store(provider.key_service()))
            }),
            available: Arc::new(secret_store_available),
            account: codesense_platform::user::login_name(),
            read_timeout: KEY_READ_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub(crate) fn new(
        store: Arc<dyn CredentialStore>,
        available: bool,
        account: Option<&str>,
        read_timeout: Duration,
    ) -> Self {
        Self {
            stores: Arc::new(move |_: Provider| store.clone()),
            available: Arc::new(move || available),
            account: account.map(str::to_string),
            read_timeout,
        }
    }

    /// The store and account to use, or `None` with no secret store or no login name.
    fn reach(&self, provider: Provider) -> Option<(Arc<dyn CredentialStore>, &str)> {
        if !(self.available)() {
            return None;
        }
        let account = self.account.as_deref()?;
        Some(((self.stores)(provider), account))
    }

    /// The saved key, `None` when there is none. Blocking: it may raise a Keychain prompt.
    pub(crate) fn read(&self, provider: Provider) -> Result<Option<Secret>, GifError> {
        let (store, account) = self.reach(provider).ok_or(GifError::KeychainUnavailable)?;
        match store.get(account) {
            Ok(Some(key)) if key.expose().trim() != "" => Ok(Some(key)),
            Ok(_) => Ok(None),
            Err(_) => Err(GifError::KeychainUnavailable),
        }
    }

    /// The key for a search: [`Self::read`] off the async threads, given up after the read
    /// timeout so a Keychain prompt never holds a search. No key is [`GifError::NoProvider`].
    pub(crate) async fn read_timed(&self, provider: Provider) -> Result<Secret, GifError> {
        let keys = self.clone();
        let read = tokio::task::spawn_blocking(move || keys.read(provider));
        match tokio::time::timeout(self.read_timeout, read).await {
            Ok(Ok(Ok(Some(key)))) => Ok(key),
            Ok(Ok(Ok(None))) => Err(GifError::NoProvider),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) | Err(_) => Err(GifError::KeychainUnavailable),
        }
    }

    /// Save `key`, trimmed; an empty key is refused. Blocking.
    pub(crate) fn save(&self, provider: Provider, key: &str) -> Result<(), String> {
        let key = key.trim();
        let label = Provider::label(provider);
        if key == "" {
            return Err(format!("Enter a {label} key."));
        }
        if key.len() > 256 || key.contains(|c: char| !c.is_ascii_graphic()) {
            return Err(format!(
                "A {label} key has only letters, digits and symbols, with no spaces."
            ));
        }
        let (store, account) = self.reach(provider).ok_or(NO_STORE)?;
        store
            .set(account, &Secret::new(key))
            .map_err(|_| "Couldn't save the key to your Keychain. Nothing changed.".to_string())
    }

    /// Remove the saved key. Blocking.
    pub(crate) fn remove(&self, provider: Provider) -> Result<(), String> {
        let (store, account) = self.reach(provider).ok_or(NO_STORE)?;
        CredentialStore::delete(store.as_ref(), account)
            .map_err(|_| "Couldn't remove the key from your Keychain.".to_string())
    }
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

/// What the Settings card shows for the key: never the key, only its last four characters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub status: KeyState,
    pub hint: Option<String>,
    pub production: bool,
}

pub(crate) fn status_with(keys: &Keys, dir: &Path) -> KeyStatus {
    let settings = load(dir);
    match keys.read(settings.provider) {
        Ok(Some(key)) => {
            let chars: Vec<char> = key.expose().chars().collect();
            let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
            KeyStatus {
                status: KeyState::Saved,
                hint: Some(format!("…{tail}")),
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

/// Save a new key. Its production flag starts cleared, as a replaced key's does.
pub(crate) fn save_with(keys: &Keys, dir: &Path, key: &str) -> Result<KeyStatus, String> {
    let provider = load(dir).provider;
    keys.save(provider, key)?;
    update(dir, |s| s.clear_production(provider))?;
    Ok(status_with(keys, dir))
}

/// Remove the key and its production flag.
pub(crate) fn remove_with(keys: &Keys, dir: &Path) -> Result<KeyStatus, String> {
    let provider = load(dir).provider;
    keys.remove(provider)?;
    update(dir, |s| s.clear_production(provider))?;
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
                .read(provider)
                .map_err(|_| "Couldn't read the key from your Keychain.".to_string())?
                .ok_or_else(|| format!("Save a {} key first.", Provider::label(provider)))?;
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
    Ok(view(&settings))
}

pub(crate) fn data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    tauri::Manager::path(app)
        .app_data_dir()
        .map_err(|_| "GIF search has no app data folder".to_string())
}

/// Run a settings or keyring call off the async threads: the keyring blocks and may prompt.
async fn blocking<T: Send + 'static>(
    call: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(|_| "GIF search settings are unavailable".to_string())?
}

#[tauri::command]
pub async fn gif_settings_get(app: tauri::AppHandle) -> Result<SettingsView, String> {
    let dir = data_dir(&app)?;
    blocking(move || Ok(view(&load(&dir)))).await
}
#[tauri::command]
pub async fn gif_settings_set(
    app: tauri::AppHandle,
    update: SettingsUpdate,
) -> Result<SettingsView, String> {
    let dir = data_dir(&app)?;
    blocking(move || set_with(&Keys::system(), &dir, update)).await
}
#[tauri::command]
pub async fn gif_key_status(app: tauri::AppHandle) -> Result<KeyStatus, String> {
    let dir = data_dir(&app)?;
    blocking(move || Ok(status_with(&Keys::system(), &dir))).await
}
#[tauri::command]
pub async fn gif_key_save(app: tauri::AppHandle, key: String) -> Result<KeyStatus, String> {
    let dir = data_dir(&app)?;
    blocking(move || save_with(&Keys::system(), &dir, &key)).await
}
#[tauri::command]
pub async fn gif_key_remove(app: tauri::AppHandle) -> Result<KeyStatus, String> {
    let dir = data_dir(&app)?;
    blocking(move || remove_with(&Keys::system(), &dir)).await
}
