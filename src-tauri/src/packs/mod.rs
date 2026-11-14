// SPDX-License-Identifier: MIT
//! The pack format: the `pack.yml` manifest and the `packs.lock.yml` lock as serde
//! models. The JSON Schemas under `content/generated/schemas/` are exported from these
//! types by `docs_schemas::export_model_schemas`, never from a second field list.
//!
//! Validation (paths, caps, hashes, the parts graph) is `validate`; the risk facts derived
//! from a pack's files are `risk`. Staging, install and the lock writer come later.

pub mod lock;
pub mod manifest;
pub mod risk;
pub mod validate;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod validate_tests;
