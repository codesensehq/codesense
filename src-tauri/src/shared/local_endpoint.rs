// SPDX-License-Identifier: MIT
//! Whether a listener still answers at a local endpoint.

/// Whether a listener answers at the endpoint whose wire form is `wire`: a
/// socket path on unix, a pipe name on Windows. The probe connects and drops
/// the connection at once.
pub(crate) fn answers(wire: &std::path::Path) -> bool {
    codesense_platform::ipc::Endpoint::from_wire(wire.as_os_str())
        .and_then(|endpoint| codesense_platform::ipc::blocking::LocalStream::connect(&endpoint))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use codesense_platform::ipc::{Endpoint, LocalListener};

    #[tokio::test]
    async fn a_bound_endpoint_answers_until_its_listener_drops() {
        let dir = tempfile::tempdir().unwrap();
        // Named after the unique directory, so the Windows pipe is unique too.
        let endpoint = Endpoint::Ephemeral {
            dir: dir.path().to_path_buf(),
            name: dir.path().file_name().unwrap().to_str().unwrap().to_owned(),
        };
        let wire = std::path::PathBuf::from(endpoint.to_wire().unwrap());
        assert!(!answers(&wire), "nothing is bound yet");
        let listener = LocalListener::bind(&endpoint).unwrap();
        assert!(answers(&wire));
        drop(listener);
        assert!(!answers(&wire), "the listener is gone");
    }
}
