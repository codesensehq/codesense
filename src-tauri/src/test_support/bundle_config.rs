// SPDX-License-Identifier: MIT
//! Merging a per-platform Tauri overlay over the base config, the way the bundler does.

/// Apply `patch` to `target` as a JSON merge patch (RFC 7396): objects merge key by key, a
/// `null` removes the key, and anything else, an array included, replaces the value whole.
pub(crate) fn merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
    match (target, patch) {
        (serde_json::Value::Object(target), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    target.remove(key);
                } else {
                    merge_patch(
                        target.entry(key.clone()).or_insert(serde_json::Value::Null),
                        value,
                    );
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}
