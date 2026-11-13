// SPDX-License-Identifier: MIT
//! The pack format: the `pack.yml` manifest and the `packs.lock.yml` lock as serde
//! models. The JSON Schemas under `content/generated/schemas/` are exported from these
//! types by `docs_schemas::export_model_schemas`, never from a second field list.
//!
//! Validation (paths, caps, hashes, the parts graph) and derived risk facts arrive in
//! `validate` and `risk`. Staging, install and the lock writer belong to later stories.

pub mod lock;
pub mod manifest;

#[cfg(test)]
mod tests;
