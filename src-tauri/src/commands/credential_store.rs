// SPDX-License-Identifier: MIT
//! Secret value storage for credentials — the OS keychain on desktop (the macOS
//! Keychain, or Secret Service on Linux), the process environment on a
//! headless/cloud runner.
//!
//! Salvaged from the retired SW-GT-32 branch (the `Secret` newtype +
//! `KeychainStore` + `EnvStore` topology switch) and generalized for SW-CN-4:
//! the trait carries `set` (not just `get`) so a single serialized blob — the
//! whole `auth::AuthFile` — can live under one keychain entry, replacing the
//! former 0600 `auth.json`.
//!
//! **Blocking** — the keychain API (`keyring`) is synchronous and can block
//! (and, on an async runtime without a dedicated thread, deadlock); on macOS
//! it can also raise a system prompt. Every call MUST run off the UI/command
//! thread via `commands::await_blocking` / `spawn_blocking`. This module never
//! touches an `.await`; the offload is the caller's responsibility.

use std::fmt;

/// The keychain service namespace for the single serialized auth blob (SW-CN-4).
/// Distinct from any future per-credential service so the two never collide.
pub const AUTH_SERVICE: &str = "codesense-auth";

/// The account under [`AUTH_SERVICE`] holding the serialized `AuthFile` blob.
pub const AUTH_ACCOUNT: &str = "auth-file";

/// Why a [`CredentialStore`] call failed. `Unavailable` is the one case callers
/// handle on its own: the OS has no secret store to talk to (on Linux, no Secret
/// Service on the session bus), so nothing can be saved and nothing was saved
/// before. Everything else is `Failed` with a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialError {
    Unavailable,
    Failed(String),
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => write!(f, "no secret store is available"),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

impl From<String> for CredentialError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for CredentialError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_string())
    }
}

impl From<CredentialError> for String {
    fn from(error: CredentialError) -> Self {
        error.to_string()
    }
}

/// An opaque secret value. Its [`fmt::Debug`] / [`fmt::Display`] **redact**, so a
/// stray `{:?}` in a log line or an error can never leak it. The plaintext is
/// reachable only through [`Secret::expose`] — call that ONLY at a controlled
/// de-redaction boundary (the keychain write, or handing the blob to `serde`),
/// never a log, an error string, or a persisted record.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wrap a plaintext value.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The de-redaction boundary — returns the plaintext. Never log or persist
    /// the result.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// A value source for a named secret. Swapping the impl — [`KeychainStore`]
/// locally vs [`EnvStore`] on a headless/CI runner — changes *where the value
/// lives* without touching the caller. Every method is synchronous/blocking;
/// callers offload via `await_blocking` (see module docs). `Send + Sync` so the
/// store can be held in `Arc` and moved into a blocking closure.
pub trait CredentialStore: Send + Sync {
    /// Fetch the secret under `account`. `Ok(None)` means *definitively absent*
    /// (no entry); `Err` means the backend could not be read (e.g. a locked or
    /// access-denied keychain). Callers MUST distinguish the two: a read error
    /// must not be treated as "no credentials" and trigger a destructive
    /// migrate/overwrite/reap — the entry may still hold the user's secret.
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError>;
    /// Write `value` under `account`, overwriting any existing entry.
    fn set(&self, account: &str, value: &Secret) -> Result<(), CredentialError>;
    /// Writes `value` and replaces a store that cannot be read. Only the activation path uses
    /// this; every other write goes through `set`, which never repairs. The default is `set`.
    fn set_repairing(&self, account: &str, value: &Secret) -> Result<(), CredentialError> {
        self.set(account, value)
    }
    /// Remove the entry under `account`; an absent entry is already removed.
    /// A source that cannot remove (the provisioned environment) says so.
    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Err("this credential source does not remove entries".into())
    }
}

/// The local value source: the OS keychain (macOS Keychain via `keyring`). Holds
/// only the service namespace — each call opens a fresh keyring `Entry`.
pub struct KeychainStore {
    service: &'static str,
}

impl KeychainStore {
    pub fn new(service: &'static str) -> Self {
        Self { service }
    }
}

/// Turn a keyring failure into the store's error, in this one place. On Linux a
/// missing or unreachable Secret Service (no session bus, no service, no default
/// collection, or one that can't be unlocked) is `Unavailable`; macOS keeps every
/// failure as a message, because there a refused read is not the same as no store.
fn classify(error: keyring::Error, what: &str) -> CredentialError {
    #[cfg(target_os = "linux")]
    if matches!(
        error,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    ) {
        return CredentialError::Unavailable;
    }
    CredentialError::Failed(format!("keychain {what} failed: {error}"))
}

impl KeychainStore {
    fn entry(&self, account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(self.service, account).map_err(|e| classify(e, "entry open"))
    }
}

impl CredentialStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        match self.entry(account)?.get_password() {
            Ok(v) => Ok(Some(Secret::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(classify(e, "read")),
        }
    }

    fn set(&self, account: &str, value: &Secret) -> Result<(), CredentialError> {
        self.entry(account)?
            .set_password(value.expose())
            .map_err(|e| classify(e, "write"))
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(classify(e, "delete")),
        }
    }
}

static SECRET_STORE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether the OS secret store is reachable. The first call probes and logs
/// `secret store: <state>`; the app makes it at startup, later calls read the
/// result. The probe only asks that the Secret Service bus name and its default
/// collection exist: it never unlocks anything, so no prompt can appear. An app with
/// no Secret Service keeps running; saving a secret then fails with
/// [`CredentialError::Unavailable`].
pub fn secret_store_available() -> bool {
    *SECRET_STORE.get_or_init(|| match platform_probe() {
        Some(backend) => {
            log::info!(target: "auth", "secret store: {backend}");
            true
        }
        None => {
            log::info!(target: "auth", "secret store: unavailable");
            false
        }
    })
}

#[cfg(target_os = "macos")]
fn platform_probe() -> Option<&'static str> {
    Some("keychain")
}

#[cfg(target_os = "linux")]
fn platform_probe() -> Option<&'static str> {
    use dbus_secret_service::{EncryptionType, SecretService};
    // A zero prompt timeout cancels any prompt at once, so a probe can never ask.
    let Ok(service) = SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 0)
    else {
        return None;
    };
    match service.get_default_collection() {
        Ok(_) => Some("secret-service"),
        Err(_) => None,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_probe() -> Option<&'static str> {
    None
}

/// The cloud/CI value source: the process environment, where an always-up
/// runner's secret manager injects credentials. Read-only — a headless runner
/// provisions secrets externally, so `set` is unsupported and returns an
/// explanatory error rather than silently dropping a write.
pub struct EnvStore {
    service: &'static str,
}

impl EnvStore {
    pub fn new(service: &'static str) -> Self {
        Self { service }
    }
}

impl CredentialStore for EnvStore {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        // An unset OR empty injected var is "absent" — an empty secret is a
        // provisioning mistake, not a credential, so don't hand back `Some("")`.
        Ok(std::env::var(env_key_for(self.service, account))
            .ok()
            .filter(|v| !v.is_empty())
            .map(Secret::new))
    }

    fn set(&self, _account: &str, _value: &Secret) -> Result<(), CredentialError> {
        Err("credential source is env (headless) — writes are provisioned by the platform secret manager, not the app".into())
    }
}

/// The env var that selects the value source for this deployment.
pub const CRED_SOURCE_ENV: &str = "CODESENSE_CRED_SOURCE";

/// Select the credential value source for this deployment topology. A desktop
/// install resolves from the OS keychain; an always-up headless/CI runner sets
/// `CODESENSE_CRED_SOURCE=env` so the same accounts resolve from injected env /
/// the platform secret manager instead.
pub fn default_store(service: &'static str) -> Box<dyn CredentialStore> {
    match std::env::var(CRED_SOURCE_ENV) {
        Ok(v) if v == "env" => Box::new(EnvStore::new(service)),
        // Set-but-unrecognized is a likely misconfiguration (e.g. a typo) that
        // would silently fall back to the keychain — absent on a headless
        // runner. Warn so it is visible.
        Ok(v) if !v.is_empty() => {
            log::warn!(
                target: "auth",
                "{CRED_SOURCE_ENV}={v:?} is unrecognized — falling back to the OS keychain store"
            );
            Box::new(KeychainStore::new(service))
        }
        _ => Box::new(KeychainStore::new(service)),
    }
}

/// Map a `service`+`account` pair to the env var name [`EnvStore`] reads.
/// Alphanumerics uppercase; every other byte escapes as `_HH` (its hex code) so
/// the mapping is **injective** — distinct accounts can never alias to one env
/// var. The result is a valid shell identifier under a `CODESENSE_CRED_`
/// namespace.
pub fn env_key_for(service: &str, account: &str) -> String {
    let mut out = String::from("CODESENSE_CRED_");
    for b in service
        .bytes()
        .chain(std::iter::once(b'/'))
        .chain(account.bytes())
    {
        if b.is_ascii_alphanumeric() {
            out.push(b.to_ascii_uppercase() as char);
        } else {
            out.push_str(&format!("_{b:02X}"));
        }
    }
    out
}

/// In-memory [`CredentialStore`] test double — never touches the real keychain
/// (unavailable / prompt-bearing on the `ubuntu-latest` CI runner). Shared by
/// this module's tests and `auth`'s so no file re-declares a fake.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeStore {
    map: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl CredentialStore for FakeStore {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        Ok(self
            .map
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Secret::new))
    }

    fn set(&self, account: &str, value: &Secret) -> Result<(), CredentialError> {
        self.map
            .lock()
            .unwrap()
            .insert(account.to_string(), value.expose().to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.map.lock().unwrap().remove(account);
        Ok(())
    }
}

/// A [`CredentialStore`] test double for a machine with no secret store: every call is
/// [`CredentialError::Unavailable`].
#[cfg(test)]
pub(crate) struct UnavailableStore;

#[cfg(test)]
impl CredentialStore for UnavailableStore {
    fn get(&self, _account: &str) -> Result<Option<Secret>, CredentialError> {
        Err(CredentialError::Unavailable)
    }

    fn set(&self, _account: &str, _value: &Secret) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }

    fn delete(&self, _account: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_and_display_redact() {
        let s = Secret::new("super-secret-token");
        assert_eq!(format!("{s:?}"), "Secret(<redacted>)");
        assert_eq!(format!("{s}"), "<redacted>");
        // The plaintext is still reachable at the controlled boundary.
        assert_eq!(s.expose(), "super-secret-token");
    }

    #[test]
    fn fake_store_round_trips_set_get() {
        let store = FakeStore::default();
        assert!(store.get(AUTH_ACCOUNT).unwrap().is_none());

        store.set(AUTH_ACCOUNT, &Secret::new("blob-v1")).unwrap();
        assert_eq!(
            store.get(AUTH_ACCOUNT).unwrap().unwrap().expose(),
            "blob-v1"
        );

        // set overwrites.
        store.set(AUTH_ACCOUNT, &Secret::new("blob-v2")).unwrap();
        assert_eq!(
            store.get(AUTH_ACCOUNT).unwrap().unwrap().expose(),
            "blob-v2"
        );
    }

    /// Linux must never fall back to keyring's in-memory mock, which forgets every
    /// secret on exit.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_uses_secret_service_not_the_mock_store() {
        let entry = keyring::Entry::new(AUTH_SERVICE, "backend-check").unwrap();
        let credential = entry.get_credential();
        assert!(credential
            .downcast_ref::<keyring::secret_service::SsCredential>()
            .is_some());
        assert!(credential
            .downcast_ref::<keyring::mock::MockCredential>()
            .is_none());
    }

    #[test]
    fn credential_error_converts_to_and_from_strings() {
        assert_eq!(
            CredentialError::from("locked"),
            CredentialError::Failed("locked".into())
        );
        assert_eq!(
            String::from(CredentialError::Failed("locked".into())),
            "locked"
        );
        assert_ne!(CredentialError::Unavailable, CredentialError::from("x"));
    }

    #[test]
    fn env_key_for_is_injective_across_separators() {
        // `/`, `:`, `-`, `.` must each encode distinctly so no two accounts
        // collide onto one env var.
        let a = env_key_for(AUTH_SERVICE, "a/b");
        let b = env_key_for(AUTH_SERVICE, "a:b");
        let c = env_key_for(AUTH_SERVICE, "a-b");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
        assert!(a.starts_with("CODESENSE_CRED_"));
    }

    #[test]
    fn env_store_reads_injected_var_and_refuses_writes() {
        let key = env_key_for(AUTH_SERVICE, AUTH_ACCOUNT);
        // SAFETY: single-threaded test; no other thread reads this var.
        unsafe { std::env::set_var(&key, "injected-blob") };
        let store = EnvStore::new(AUTH_SERVICE);
        assert_eq!(
            store.get(AUTH_ACCOUNT).unwrap().unwrap().expose(),
            "injected-blob"
        );
        assert!(store.set(AUTH_ACCOUNT, &Secret::new("x")).is_err());

        // An empty injected var reads as absent, not an empty secret.
        // SAFETY: single-threaded test; no other thread reads this var.
        unsafe { std::env::set_var(&key, "") };
        assert!(store.get(AUTH_ACCOUNT).unwrap().is_none());
        unsafe { std::env::remove_var(&key) };
    }
}

/// The store against a real Secret Service. Every test is `#[ignore]`d, so only the Linux app CI
/// job runs them, under a private session bus with the keyring daemon unlocked (the filter there
/// is `test(~secret_service_tests)`). nextest gives each test its own process.
#[cfg(all(test, target_os = "linux"))]
mod secret_service_tests {
    use super::*;

    const SERVICE: &str = "codesense-secret-service-test";
    const READER_ACCOUNT_ENV: &str = "CODESENSE_TEST_SECRET_ACCOUNT";

    fn unique_account(label: &str) -> String {
        format!("{label}-{}", std::process::id())
    }

    #[test]
    #[ignore = "needs a Secret Service session"]
    fn set_get_and_delete_round_trip() {
        assert!(secret_store_available());
        let store = KeychainStore::new(SERVICE);
        let account = unique_account("round-trip");
        assert!(store.get(&account).unwrap().is_none());

        store.set(&account, &Secret::new("first")).unwrap();
        assert_eq!(store.get(&account).unwrap().unwrap().expose(), "first");

        store.set(&account, &Secret::new("second")).unwrap();
        assert_eq!(store.get(&account).unwrap().unwrap().expose(), "second");

        store.delete(&account).unwrap();
        assert!(store.get(&account).unwrap().is_none());
        // An absent entry is already removed.
        store.delete(&account).unwrap();
    }

    /// Run by `a_second_process_reads_what_the_first_wrote`, not on its own: without the
    /// account variable it has nothing to read and passes.
    #[test]
    #[ignore = "needs a Secret Service session"]
    fn reader_process() {
        let Ok(account) = std::env::var(READER_ACCOUNT_ENV) else {
            return;
        };
        let secret = KeychainStore::new(SERVICE).get(&account).unwrap();
        assert_eq!(secret.unwrap().expose(), "kept across processes");
    }

    #[test]
    #[ignore = "needs a Secret Service session"]
    fn a_second_process_reads_what_the_first_wrote() {
        let store = KeychainStore::new(SERVICE);
        let account = unique_account("persist");
        store
            .set(&account, &Secret::new("kept across processes"))
            .unwrap();

        // The test binary again, as a fresh process, running only the reader.
        let reader = format!(
            "{}::reader_process",
            module_path!().split_once("::").unwrap().1
        );
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", &reader, "--nocapture"])
            .env(READER_ACCOUNT_ENV, &account)
            .output()
            .unwrap();
        let ran = String::from_utf8_lossy(&output.stdout);
        store.delete(&account).unwrap();
        assert!(output.status.success(), "reader failed: {ran}");
        assert!(ran.contains("1 passed"), "the reader did not run: {ran}");
    }

    #[test]
    #[ignore = "needs a Secret Service session"]
    fn with_no_session_bus_every_call_is_unavailable() {
        // SAFETY: nextest runs each test in its own process, and nothing here starts a thread
        // that reads the environment before this call.
        unsafe {
            std::env::set_var(
                "DBUS_SESSION_BUS_ADDRESS",
                "unix:path=/nonexistent/codesense-bus",
            );
        }
        assert!(!secret_store_available());
        let store = KeychainStore::new(SERVICE);
        assert_eq!(store.get("any").unwrap_err(), CredentialError::Unavailable);
        assert_eq!(
            store.set("any", &Secret::new("x")).unwrap_err(),
            CredentialError::Unavailable
        );
        assert_eq!(
            store.delete("any").unwrap_err(),
            CredentialError::Unavailable
        );
    }
}
