// SPDX-License-Identifier: MIT
//! A key's passphrase goes straight from a system dialog into the keychain.
//! The webview never sees it: the app gets back only a keychain handle
//! (a [`CredentialRef`]), which is all that crosses IPC and all a binding
//! stores. At sign-in the askpass serves it from the keychain to `ssh`.

use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use crate::commands::credential_store::{CredentialError, CredentialStore, Secret};
use crate::domain::CredentialRef;

/// The keychain service holding SSH key passphrases, one entry per handle.
pub const SSH_SERVICE: &str = "codesense-ssh";

/// The `CredentialRef` provider of an SSH key passphrase.
pub const SSH_PROVIDER: &str = "ssh";

/// Ask for `key`'s passphrase in a system dialog: `None` when the person
/// cancelled. The passphrase comes back on the dialog's standard output —
/// never an argument, never a file.
#[cfg(target_os = "macos")]
pub fn prompt(key: &Path) -> Result<Option<Secret>, String> {
    let script = [
        "on run argv",
        "text returned of (display dialog (item 1 of argv) default answer \"\" with hidden answer \
         with title \"CodeSense\" buttons {\"Cancel\", \"Save to Keychain\"} \
         default button 2 cancel button 1 with icon caution)",
        "end run",
    ];
    let mut command = Command::new("/usr/bin/osascript");
    for line in script {
        command.args(["-e", line]);
    }
    let output = command
        .arg("--")
        .arg(format!(
            "Passphrase for {} — CodeSense keeps it in your keychain.",
            key.display()
        ))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("open the passphrase dialog: {e}"))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        return if said.contains("-128") {
            Ok(None)
        } else {
            Err(format!("the passphrase dialog failed: {}", said.trim()))
        };
    }
    let mut text = String::from_utf8(output.stdout).map_err(|_| "the passphrase is not text")?;
    if text.ends_with('\n') {
        text.pop();
    }
    Ok((!text.is_empty()).then(|| Secret::new(text)))
}

#[cfg(not(target_os = "macos"))]
pub fn prompt(_key: &Path) -> Result<Option<Secret>, String> {
    Err("storing a key passphrase needs the macOS keychain".into())
}

/// The error when there is no secret store to keep a passphrase in. It carries the typed
/// `unavailable:` prefix, which the panels strip before showing the sentence.
pub const UNAVAILABLE_MESSAGE: &str =
    "unavailable: Can't save the passphrase: no Secret Service is running. You'll be asked again next time.";

/// Shown when a handle's passphrase is not in the store.
const NOT_SAVED_MESSAGE: &str =
    "The key's passphrase is no longer in your keychain. Save it again.";

/// An account no passphrase is ever kept under, read only to ask the store whether it exists.
const PROBE_ACCOUNT: &str = "availability-check";

/// Fails with [`UNAVAILABLE_MESSAGE`] when there is no secret store, so a person is not
/// asked for a passphrase that could not be kept. Reads one absent entry: nothing is
/// unlocked or written.
pub fn ensure_available(store: &dyn CredentialStore) -> Result<(), String> {
    match store.get(PROBE_ACCOUNT) {
        Err(CredentialError::Unavailable) => Err(UNAVAILABLE_MESSAGE.into()),
        _ => Ok(()),
    }
}

/// Keep `passphrase` in the keychain under a fresh handle. With no secret store
/// the error is [`UNAVAILABLE_MESSAGE`] and nothing was kept.
pub fn store(store: &dyn CredentialStore, passphrase: &Secret) -> Result<CredentialRef, String> {
    let handle = CredentialRef {
        provider: SSH_PROVIDER.into(),
        account: uuid::Uuid::new_v4().to_string(),
    };
    store
        .set(&handle.account, passphrase)
        .map_err(|e| match e {
            CredentialError::Unavailable => UNAVAILABLE_MESSAGE.to_string(),
            e => e.to_string(),
        })?;
    Ok(handle)
}

/// The passphrase a handle names. With no secret store it is "not saved", so the
/// person is asked for it again.
pub fn load(store: &dyn CredentialStore, handle: &CredentialRef) -> Result<Secret, String> {
    if handle.provider != SSH_PROVIDER {
        return Err(format!("{:?} is not an SSH passphrase", handle.provider));
    }
    match store.get(&handle.account) {
        Ok(Some(secret)) => Ok(secret),
        Ok(None) | Err(CredentialError::Unavailable) => Err(NOT_SAVED_MESSAGE.into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Forget the passphrase a handle names. With no secret store there is nothing to
/// forget.
pub fn forget(store: &dyn CredentialStore, handle: &CredentialRef) -> Result<(), String> {
    if handle.provider != SSH_PROVIDER {
        return Ok(());
    }
    match store.delete(&handle.account) {
        Err(CredentialError::Unavailable) => Ok(()),
        other => other.map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::credential_store::{FakeStore, UnavailableStore};

    fn handle() -> CredentialRef {
        CredentialRef {
            provider: SSH_PROVIDER.into(),
            account: "a-handle".into(),
        }
    }

    /// The panels branch on this prefix to show the sentence without it.
    #[test]
    fn the_unavailable_message_carries_the_typed_prefix() {
        assert!(UNAVAILABLE_MESSAGE.starts_with("unavailable: "));
    }

    #[test]
    fn saving_with_no_secret_store_says_so_and_keeps_nothing() {
        let error = store(&UnavailableStore, &Secret::new("hunter2")).unwrap_err();
        assert_eq!(error, UNAVAILABLE_MESSAGE);
    }

    #[test]
    fn no_secret_store_is_reported_before_anyone_is_asked() {
        assert_eq!(
            ensure_available(&UnavailableStore),
            Err(UNAVAILABLE_MESSAGE.to_string())
        );
        assert_eq!(ensure_available(&FakeStore::default()), Ok(()));
    }

    #[test]
    fn a_passphrase_is_not_saved_when_there_is_no_secret_store() {
        let error = load(&UnavailableStore, &handle()).unwrap_err();
        assert_eq!(error, NOT_SAVED_MESSAGE);
    }

    #[test]
    fn forgetting_with_no_secret_store_has_nothing_to_do() {
        assert_eq!(forget(&UnavailableStore, &handle()), Ok(()));
    }
}
