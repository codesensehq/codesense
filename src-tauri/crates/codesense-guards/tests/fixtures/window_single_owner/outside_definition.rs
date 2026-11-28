// SPDX-License-Identifier: MIT
// A target resolver outside the windows module.

async fn resolve_target(name: &str) -> Result<String, String> {
    Ok(name.to_owned())
}
