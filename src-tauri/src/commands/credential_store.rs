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

/// The local value source: the OS keychain via `keyring` (the macOS Keychain, or Secret Service on
/// Linux). Holds only the service namespace — each call opens a fresh keyring `Entry`.
pub struct KeychainStore {
    service: &'static str,
}

/// What the OS secret store looks like from here.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Probe {
    /// Reachable, named for the log line.
    Present(&'static str),
    /// Definitely absent: no session bus, no Secret Service on it, no default collection.
    Absent,
    /// Couldn't tell: a timeout while the service starts, a probe still running, or any other
    /// failure. Holds the error's description, which is its D-Bus error name when it has one.
    Unknown(String),
    /// The deployment injects secrets through the environment, so there is no store to probe.
    Env,
}

/// Turn a keyring failure into the store's error, in this one place. `Unavailable` means there
/// is no store at all: a keyring `NoStorageAccess` or `PlatformFailure` while `probe` finds the
/// store definitely absent. A locked store, a dismissed prompt, a probe that can't tell and any
/// other failure stay `Failed`, and the text of a `Failed` is the same on every platform.
fn classify(error: keyring::Error, what: &str, probe: impl FnOnce() -> Probe) -> CredentialError {
    let no_store = matches!(
        error,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    ) && probe() == Probe::Absent;
    if no_store {
        CredentialError::Unavailable
    } else {
        CredentialError::Failed(format!("keychain {what} failed: {error}"))
    }
}

impl KeychainStore {
    pub fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(self.service, account)
            .map_err(|e| classify(e, "entry open", store_probe))
    }
}

impl CredentialStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        match self.entry(account)?.get_password() {
            Ok(v) => Ok(Some(Secret::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(classify(e, "read", store_probe)),
        }
    }

    fn set(&self, account: &str, value: &Secret) -> Result<(), CredentialError> {
        self.entry(account)?
            .set_password(value.expose())
            .map_err(|e| classify(e, "write", store_probe))
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(classify(e, "delete", store_probe)),
        }
    }
}

/// How long the startup capability resolution waits for the probe. D-Bus I/O never runs on the
/// thread that waits: a probe that is still running at the deadline leaves the store off for the
/// run.
pub const PROBE_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

/// Where the probe's result lands, with the condition variable its waiter sleeps on.
struct ProbeSlot {
    state: std::sync::Mutex<Option<Probe>>,
    done: std::sync::Condvar,
}

static PROBE: std::sync::OnceLock<std::sync::Arc<ProbeSlot>> = std::sync::OnceLock::new();

/// The probe's slot. The first call starts the probe on a background thread (on macOS it is a
/// constant, so the thread ends at once).
fn probe_slot() -> &'static std::sync::Arc<ProbeSlot> {
    PROBE.get_or_init(|| {
        let slot = std::sync::Arc::new(ProbeSlot {
            state: std::sync::Mutex::new(None),
            done: std::sync::Condvar::new(),
        });
        let running = std::sync::Arc::clone(&slot);
        std::thread::spawn(move || {
            finish_probe(&running, || {
                secret_store_state(&cred_source(), platform_probe)
            })
        });
        slot
    })
}

/// Runs `probe`, logs the real state (`secret store: <state>`), and wakes the waiter.
fn finish_probe(slot: &ProbeSlot, probe: impl FnOnce() -> Probe) {
    let state = probe();
    log_probe(&state);
    *slot.state.lock().unwrap() = Some(state);
    slot.done.notify_all();
}

/// Waits up to `wait` for the slot's result; `None` when it is still running.
fn probe_result(slot: &ProbeSlot, wait: std::time::Duration) -> Option<Probe> {
    let guard = slot.state.lock().unwrap();
    let (guard, _) = slot
        .done
        .wait_timeout_while(guard, wait, |state| state.is_none())
        .unwrap();
    guard.clone()
}

/// The result when the probe was still running at the deadline.
fn probe_timed_out(wait: std::time::Duration) -> Probe {
    Probe::Unknown(format!("probe still running after {} ms", wait.as_millis()))
}

fn log_probe(state: &Probe) {
    let (level, line) = probe_log(state);
    log::log!(target: "auth", level, "{line}");
}

/// Whether a probe result means the app can keep secrets: only a present store does. An absent
/// store, one the probe couldn't tell about and the environment source all mean no.
fn available(state: &Probe) -> bool {
    matches!(state, Probe::Present(_))
}

/// Starts the secret store probe in the background, so a later `secret_store_available` finds it
/// done. The app calls it first in setup.
pub fn start_secret_store_probe() {
    probe_slot();
}

/// Whether the app can keep secrets in an OS store, waiting at most [`PROBE_WAIT`] for the probe
/// (which logs `secret store: <state>` itself when it finishes). The probe only asks that the
/// Secret Service bus name and its default collection exist: it never unlocks anything, so no
/// prompt can appear. An app with no Secret Service keeps running; saving a secret then fails
/// with [`CredentialError::Unavailable`]. With `CODESENSE_CRED_SOURCE=env` secrets are read from
/// the environment and never saved, so it is `false` and the bus is not touched. A probe still
/// running at the deadline is unknown, logged as a warning, and `false`.
pub fn secret_store_available() -> bool {
    match probe_result(probe_slot(), PROBE_WAIT) {
        Some(state) => available(&state),
        None => {
            log_probe(&probe_timed_out(PROBE_WAIT));
            false
        }
    }
}

/// The startup log line for a probe result and its level: an indeterminate probe is a warning
/// that names the error, since the store is then off for the run without being known absent.
fn probe_log(state: &Probe) -> (log::Level, String) {
    match state {
        Probe::Present(backend) => (log::Level::Info, format!("secret store: {backend}")),
        Probe::Env => (log::Level::Info, "secret store: env (read-only)".into()),
        Probe::Absent => (log::Level::Info, "secret store: unavailable".into()),
        Probe::Unknown(error) => (log::Level::Warn, format!("secret store: unknown ({error})")),
    }
}

/// The state for a credential source (`CODESENSE_CRED_SOURCE`) and the OS probe, which the
/// environment source never runs.
fn secret_store_state(source: &CredSource, os: impl FnOnce() -> Probe) -> Probe {
    if matches!(source, CredSource::Env) {
        Probe::Env
    } else {
        os()
    }
}

/// The OS probe a failed keyring call asks, uncached: the store may have appeared or gone since
/// the startup probe.
fn store_probe() -> Probe {
    platform_probe()
}

#[cfg(target_os = "macos")]
fn platform_probe() -> Probe {
    Probe::Present("keychain")
}

#[cfg(target_os = "linux")]
fn platform_probe() -> Probe {
    use dbus_secret_service::{EncryptionType, SecretService};
    // A zero prompt timeout cancels any prompt at once, so a probe can never ask.
    let service = match SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 0) {
        Ok(service) => service,
        Err(error) => return absence_of(&error),
    };
    match service.get_default_collection() {
        Ok(_) => Probe::Present("secret-service"),
        Err(error) => absence_of(&error),
    }
}

/// Only a definite absence is `Absent`; anything else the probe can't be sure of is `Unknown`.
#[cfg(target_os = "linux")]
fn absence_of(error: &dbus_secret_service::Error) -> Probe {
    match error {
        dbus_secret_service::Error::NoResult => Probe::Absent,
        dbus_secret_service::Error::Dbus(source) => match source.name() {
            Some(name) if NO_SERVICE_ERRORS.contains(&name) => Probe::Absent,
            Some(name) => Probe::Unknown(name.to_string()),
            None => Probe::Unknown(error.to_string()),
        },
        _ => Probe::Unknown(error.to_string()),
    }
}

/// D-Bus errors that say there is no session bus or no Secret Service to talk to. A `NoReply`, a
/// timeout, or a `NameHasNoOwner` (dbus-broker also sends it when activating a service fails) is
/// not here: a slow or failing daemon is not an absent one.
#[cfg(target_os = "linux")]
const NO_SERVICE_ERRORS: [&str; 6] = [
    "org.freedesktop.DBus.Error.NoServer",
    "org.freedesktop.DBus.Error.FileNotFound",
    "org.freedesktop.DBus.Error.BadAddress",
    "org.freedesktop.DBus.Error.NotSupported",
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.Spawn.ExecFailed",
];

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_probe() -> Probe {
    Probe::Absent
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

/// Which credential value source `CODESENSE_CRED_SOURCE` selects.
#[derive(Debug, PartialEq, Eq)]
enum CredSource {
    /// `env`: secrets are injected into the process environment.
    Env,
    /// Unset or empty: the OS keychain.
    Keychain,
    /// Set to something else, a likely typo; treated as the keychain.
    Unrecognized(String),
}

/// The one place the variable is read and parsed.
fn cred_source() -> CredSource {
    match std::env::var(CRED_SOURCE_ENV) {
        Ok(v) if v == "env" => CredSource::Env,
        Ok(v) if !v.is_empty() => CredSource::Unrecognized(v),
        _ => CredSource::Keychain,
    }
}

/// Select the credential value source for this deployment topology. A desktop
/// install resolves from the OS keychain; an always-up headless/CI runner sets
/// `CODESENSE_CRED_SOURCE=env` so the same accounts resolve from injected env /
/// the platform secret manager instead.
pub fn default_store(service: &'static str) -> Box<dyn CredentialStore> {
    match cred_source() {
        CredSource::Env => Box::new(EnvStore::new(service)),
        // Set-but-unrecognized is a likely misconfiguration (e.g. a typo) that
        // would silently fall back to the keychain — absent on a headless
        // runner. Warn so it is visible.
        CredSource::Unrecognized(v) => {
            log::warn!(
                target: "auth",
                "{CRED_SOURCE_ENV}={v:?} is unrecognized — falling back to the OS keychain store"
            );
            Box::new(KeychainStore::new(service))
        }
        CredSource::Keychain => Box::new(KeychainStore::new(service)),
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

    fn io_failure(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
        std::io::Error::other(message.to_string()).into()
    }

    /// Only a no-store failure is `Unavailable`; every other keyring error, and any failure while
    /// the store is present or can't be told (locked, a dismissed prompt, a slow service), is a
    /// `Failed` with the same text on every platform.
    #[test]
    fn classify_maps_only_a_definitely_absent_store_to_unavailable() {
        let variants = || {
            [
                keyring::Error::PlatformFailure(io_failure("bus gone")),
                keyring::Error::NoStorageAccess(io_failure("no collection")),
                keyring::Error::NoEntry,
                keyring::Error::BadEncoding(vec![0xff]),
                keyring::Error::TooLong("service".into(), 8),
                keyring::Error::Invalid("account".into(), "empty".into()),
                keyring::Error::Ambiguous(Vec::new()),
            ]
        };
        for probe in [
            Probe::Present("secret-service"),
            Probe::Unknown("NoReply".into()),
            Probe::Env,
        ] {
            for (index, error) in variants().into_iter().enumerate() {
                let text = error.to_string();
                assert_eq!(
                    classify(error, "read", || probe.clone()),
                    CredentialError::Failed(format!("keychain read failed: {text}")),
                    "variant {index} with {probe:?}"
                );
            }
        }
        for (index, error) in variants().into_iter().enumerate() {
            let text = error.to_string();
            let expected = if index < 2 {
                CredentialError::Unavailable
            } else {
                CredentialError::Failed(format!("keychain write failed: {text}"))
            };
            assert_eq!(
                classify(error, "write", || Probe::Absent),
                expected,
                "variant {index} with the store absent"
            );
        }
    }

    /// macOS keeps its exact message text.
    #[test]
    fn classify_keeps_the_keychain_failure_text() {
        let error = keyring::Error::PlatformFailure(io_failure("boom"));
        assert_eq!(
            classify(error, "delete", || Probe::Present("keychain")),
            CredentialError::Failed(
                "keychain delete failed: Platform secure storage failure: boom".into()
            )
        );
        let error = keyring::Error::NoStorageAccess(io_failure("denied"));
        assert_eq!(
            classify(error, "entry open", || Probe::Present("keychain")),
            CredentialError::Failed(
                "keychain entry open failed: Couldn't access platform secure storage: denied"
                    .into()
            )
        );
    }

    /// The probe is not consulted for an error that is never a missing store.
    #[test]
    fn classify_does_not_probe_for_other_errors() {
        let error = keyring::Error::NoEntry;
        let failed = classify(error, "read", || panic!("no probe for NoEntry"));
        assert!(matches!(failed, CredentialError::Failed(_)));
    }

    /// The environment source has no store to probe, so it is reported as read-only and the OS
    /// probe never runs.
    #[test]
    fn the_env_source_is_not_probed_and_is_not_a_store() {
        assert_eq!(
            secret_store_state(&CredSource::Env, || {
                panic!("the env source never probes the OS")
            }),
            Probe::Env
        );
        for source in [
            CredSource::Keychain,
            CredSource::Unrecognized("typo".into()),
        ] {
            assert_eq!(
                secret_store_state(&source, || Probe::Absent),
                Probe::Absent,
                "{source:?}"
            );
        }
    }

    /// An indeterminate probe is logged as a warning that names the error, and is not available.
    #[test]
    fn an_unknown_probe_warns_with_the_error_and_is_not_available() {
        let unknown = Probe::Unknown("org.freedesktop.DBus.Error.NoReply".into());
        assert_eq!(
            probe_log(&unknown),
            (
                log::Level::Warn,
                "secret store: unknown (org.freedesktop.DBus.Error.NoReply)".to_string()
            )
        );
        assert_eq!(
            probe_log(&Probe::Absent),
            (log::Level::Info, "secret store: unavailable".to_string())
        );
        assert_eq!(
            probe_log(&Probe::Present("keychain")),
            (log::Level::Info, "secret store: keychain".to_string())
        );
        assert_eq!(
            probe_log(&Probe::Env),
            (
                log::Level::Info,
                "secret store: env (read-only)".to_string()
            )
        );
    }

    /// Only a present store lets the app keep secrets: an absent one, one the probe couldn't tell
    /// about and the environment source are all off.
    #[test]
    fn only_a_present_store_is_available() {
        assert!(available(&Probe::Present("secret-service")));
        assert!(available(&Probe::Present("keychain")));
        assert!(!available(&Probe::Absent));
        assert!(!available(&Probe::Unknown("NoReply".into())));
        assert!(!available(&Probe::Env));
    }

    /// A probe that never answers is unknown at the deadline, and the wait is the deadline, not
    /// the probe: the test gives it a few milliseconds.
    #[test]
    fn a_probe_that_never_answers_is_unknown_at_the_deadline() {
        let slot = ProbeSlot {
            state: std::sync::Mutex::new(None),
            done: std::sync::Condvar::new(),
        };
        let wait = std::time::Duration::from_millis(5);
        let started = std::time::Instant::now();
        assert_eq!(probe_result(&slot, wait), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let unknown = probe_timed_out(wait);
        assert_eq!(
            unknown,
            Probe::Unknown("probe still running after 5 ms".into())
        );
        assert!(!available(&unknown));
        assert_eq!(
            probe_log(&probe_timed_out(PROBE_WAIT)),
            (
                log::Level::Warn,
                "secret store: unknown (probe still running after 300 ms)".to_string()
            )
        );
    }

    /// A probe that has answered is returned at once, however long the deadline.
    #[test]
    fn a_finished_probe_is_returned_without_waiting() {
        let slot = ProbeSlot {
            state: std::sync::Mutex::new(Some(Probe::Absent)),
            done: std::sync::Condvar::new(),
        };
        let started = std::time::Instant::now();
        assert_eq!(
            probe_result(&slot, std::time::Duration::from_secs(60)),
            Some(Probe::Absent)
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    /// The production `finish_probe` wakes a sleeping waiter as soon as the probe answers: the
    /// waiter returns in well under half its deadline (it would sleep the whole deadline if the
    /// notification were missing).
    #[test]
    fn a_probe_finishing_during_the_wait_wakes_the_waiter_at_once() {
        let slot = std::sync::Arc::new(ProbeSlot {
            state: std::sync::Mutex::new(None),
            done: std::sync::Condvar::new(),
        });
        let running = std::sync::Arc::clone(&slot);
        let handle = std::thread::spawn(move || {
            finish_probe(&running, || {
                std::thread::sleep(std::time::Duration::from_millis(20));
                Probe::Present("secret-service")
            })
        });
        let deadline = std::time::Duration::from_secs(4);
        let started = std::time::Instant::now();
        assert_eq!(
            probe_result(&slot, deadline),
            Some(Probe::Present("secret-service"))
        );
        assert!(
            started.elapsed() < deadline / 2,
            "the waiter slept {:?} of its {deadline:?}",
            started.elapsed()
        );
        handle.join().unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_keychain_is_always_present() {
        assert_eq!(store_probe(), Probe::Present("keychain"));
    }

    /// Only the D-Bus errors that say nothing is there count as absent; a timeout or a reply that
    /// never came does not.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_only_a_definite_dbus_absence_is_absent() {
        let dbus_error = |name: &str| {
            dbus_secret_service::Error::Dbus(dbus::Error::new_custom(name, "a message"))
        };
        for name in NO_SERVICE_ERRORS {
            assert_eq!(absence_of(&dbus_error(name)), Probe::Absent, "{name}");
        }
        // The name is matched, not searched for in the message: a failure that merely mentions
        // an absence is still unknown.
        let mentions_absence = dbus_secret_service::Error::Dbus(dbus::Error::new_custom(
            "org.freedesktop.DBus.Error.Failed",
            "org.freedesktop.DBus.Error.ServiceUnknown",
        ));
        assert_eq!(
            absence_of(&mentions_absence),
            Probe::Unknown("org.freedesktop.DBus.Error.Failed".into())
        );
        for name in [
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "org.freedesktop.DBus.Error.NoReply",
            "org.freedesktop.DBus.Error.Timeout",
            "org.freedesktop.DBus.Error.Failed",
            "org.freedesktop.DBus.Error.AccessDenied",
        ] {
            assert_eq!(
                absence_of(&dbus_error(name)),
                Probe::Unknown(name.to_string()),
                "{name}"
            );
        }
        assert_eq!(
            absence_of(&dbus_secret_service::Error::NoResult),
            Probe::Absent
        );
        // A locked collection or a dismissed prompt is not an absent one.
        assert_eq!(
            absence_of(&dbus_secret_service::Error::Locked),
            Probe::Unknown("Secret Service: object locked".into())
        );
        assert_eq!(
            absence_of(&dbus_secret_service::Error::Prompt),
            Probe::Unknown("Secret Service: unlock prompt was dismissed".into())
        );
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
    const NO_BUS_ENV: &str = "CODESENSE_TEST_NO_BUS";

    fn unique_account(label: &str) -> String {
        format!("{label}-{}", std::process::id())
    }

    /// This test binary again, as a fresh process running only `test` (an ignored test in this
    /// module) with `envs` set for it alone.
    fn run_child(test: &str, envs: &[(&str, &str)]) -> std::process::Output {
        let name = format!("{}::{test}", module_path!().split_once("::").unwrap().1);
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", &name, "--nocapture"]);
        for (key, value) in envs {
            command.env(key, value);
        }
        command.output().unwrap()
    }

    /// The child exited cleanly and ran its one test (a filter that matched nothing also exits
    /// cleanly). Its output is in the message either way.
    fn assert_child_passed(test: &str, output: &std::process::Output) {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "{test} failed\nstdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stdout.contains("1 passed"),
            "{test} did not run\nstdout: {stdout}\nstderr: {stderr}"
        );
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

    /// Started by `a_second_process_reads_what_the_first_wrote`, and left out of the CI filter:
    /// without the account variable it has nothing to read and would pass alone.
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
        let output = run_child("reader_process", &[(READER_ACCOUNT_ENV, &account)]);
        store.delete(&account).unwrap();
        assert_child_passed("reader_process", &output);
    }

    /// Started by `with_no_session_bus_every_call_is_unavailable` with no usable bus, and left
    /// out of the CI filter: without the variable it would run against the real session.
    #[test]
    #[ignore = "needs a Secret Service session"]
    fn no_bus_child() {
        if std::env::var(NO_BUS_ENV).is_err() {
            return;
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

    #[test]
    #[ignore = "needs a Secret Service session"]
    fn with_no_session_bus_every_call_is_unavailable() {
        let output = run_child(
            "no_bus_child",
            &[
                (NO_BUS_ENV, "1"),
                (
                    "DBUS_SESSION_BUS_ADDRESS",
                    "unix:path=/nonexistent/codesense-bus",
                ),
            ],
        );
        assert_child_passed("no_bus_child", &output);
    }
}
