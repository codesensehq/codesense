// SPDX-License-Identifier: MIT
//! The machine types local terminals use on every platform: This Mac's id and
//! the runtime members, sessions, workspaces and admissions a layout names. They
//! are plain data, re-exported from `commands::machines` at their usual paths.

use serde::{Deserialize, Serialize};

/// This Mac's id: local is a machine like any other, always first.
pub const LOCAL_MACHINE_ID: &str = "local";

/// Lossless IPC representation of an owner-issued counter. Numeric ordering is
/// retained in Rust; JavaScript receives canonical decimal strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RuntimeCounter(u64);

impl RuntimeCounter {
    pub(crate) fn new(value: u64) -> Self {
        Self(value)
    }
}

impl Serialize for RuntimeCounter {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for RuntimeCounter {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        let number = value.parse::<u64>().map_err(serde::de::Error::custom)?;
        if number.to_string() != value {
            return Err(serde::de::Error::custom("expected canonical decimal u64"));
        }
        Ok(Self(number))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeMemberSlot {
    InProcess,
    Sidecar,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "RuntimeMemberAddressWire")]
pub struct RuntimeMemberAddress {
    pub machine_id: String,
    pub slot: RuntimeMemberSlot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeMemberAddressWire {
    machine_id: String,
    slot: RuntimeMemberSlot,
}

impl TryFrom<RuntimeMemberAddressWire> for RuntimeMemberAddress {
    type Error = &'static str;
    fn try_from(value: RuntimeMemberAddressWire) -> Result<Self, Self::Error> {
        if value.machine_id.is_empty()
            || (value.machine_id == LOCAL_MACHINE_ID) == (value.slot == RuntimeMemberSlot::Remote)
        {
            return Err("runtime slot does not belong to this machine");
        }
        Ok(Self {
            machine_id: value.machine_id,
            slot: value.slot,
        })
    }
}

impl RuntimeMemberAddress {
    pub(crate) fn local(slot: RuntimeMemberSlot) -> Self {
        assert!(
            slot != RuntimeMemberSlot::Remote,
            "local owner cannot issue a remote member"
        );
        Self {
            machine_id: LOCAL_MACHINE_ID.into(),
            slot,
        }
    }
    pub(crate) fn remote(machine_id: &str) -> Self {
        Self {
            machine_id: machine_id.into(),
            slot: RuntimeMemberSlot::Remote,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeNamespace {
    pub server_id: String,
    pub epoch: String,
    pub generation: RuntimeCounter,
}

impl From<&crate::terminal::session_server::EventNamespace> for RuntimeNamespace {
    fn from(value: &crate::terminal::session_server::EventNamespace) -> Self {
        Self {
            server_id: value.server_id.clone(),
            epoch: value.epoch.clone(),
            generation: RuntimeCounter::new(value.generation()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenRuntimeLayout {
    pub last_namespace: Option<RuntimeNamespace>,
    pub server_id: String,
    pub epoch: String,
    pub snapshot: codesense_pty_core::layout::LayoutSnapshot,
    pub reason: RuntimeHistoryReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeHistoryReason {
    Incompatible,
    Unreachable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeAdmissionState {
    Live {
        namespace: RuntimeNamespace,
    },
    Historical {
        historical: Box<FrozenRuntimeLayout>,
    },
    Unavailable,
    Removed,
}

impl Serialize for RuntimeAdmissionState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (state, namespace, historical) = match self {
            Self::Live { namespace } => ("live", Some(namespace), None),
            Self::Historical { historical } => ("historical", None, Some(historical)),
            Self::Unavailable => ("unavailable", None, None),
            Self::Removed => ("removed", None, None),
        };
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("state", state)?;
        map.serialize_entry("namespace", &namespace)?;
        map.serialize_entry("historical", &historical)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for RuntimeAdmissionState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            state: String,
            namespace: Option<RuntimeNamespace>,
            historical: Option<Box<FrozenRuntimeLayout>>,
        }
        let wire = Wire::deserialize(deserializer)?;
        match (wire.state.as_str(), wire.namespace, wire.historical) {
            ("live", Some(namespace), None) => Ok(Self::Live { namespace }),
            ("historical", None, Some(historical)) => Ok(Self::Historical { historical }),
            ("unavailable", None, None) => Ok(Self::Unavailable),
            ("removed", None, None) => Ok(Self::Removed),
            _ => Err(serde::de::Error::custom("invalid runtime admission state")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAdmissionRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_authority_epoch: Option<String>,
    pub member: RuntimeMemberAddress,
    pub revision: RuntimeCounter,
    #[serde(flatten)]
    pub state: RuntimeAdmissionState,
}

impl RuntimeAdmissionRow {
    #[cfg(test)]
    pub(crate) fn live(
        member: RuntimeMemberAddress,
        revision: u64,
        namespace: &crate::terminal::session_server::EventNamespace,
    ) -> Self {
        Self {
            member,
            revision: RuntimeCounter::new(revision),
            private_authority_epoch: None,
            state: RuntimeAdmissionState::Live {
                namespace: namespace.into(),
            },
        }
    }

    pub(crate) fn matches(&self, target: &RuntimeMemberTarget) -> bool {
        self.member == target.member
            && self.revision == target.admission_revision
            && matches!(&self.state, RuntimeAdmissionState::Live { namespace } if namespace == &target.namespace)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMemberTarget {
    pub member: RuntimeMemberAddress,
    pub admission_revision: RuntimeCounter,
    pub namespace: RuntimeNamespace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAdmissionBaseline {
    pub rows: Vec<RuntimeAdmissionRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum RuntimeLayoutReply {
    Live {
        #[serde(
            default,
            rename = "privateAuthorityEpoch",
            skip_serializing_if = "Option::is_none"
        )]
        private_authority_epoch: Option<String>,
        #[serde(flatten)]
        target: RuntimeMemberTarget,
        snapshot: Box<codesense_pty_core::layout::LayoutSnapshot>,
    },
    Historical {
        #[serde(
            default,
            rename = "privateAuthorityEpoch",
            skip_serializing_if = "Option::is_none"
        )]
        private_authority_epoch: Option<String>,
        member: RuntimeMemberAddress,
        #[serde(rename = "admissionRevision")]
        admission_revision: RuntimeCounter,
        frozen: Box<FrozenRuntimeLayout>,
    },
    Unavailable {
        member: RuntimeMemberAddress,
        #[serde(rename = "admissionRevision")]
        admission_revision: RuntimeCounter,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSessionTarget {
    #[serde(flatten)]
    pub runtime: RuntimeMemberTarget,
    pub session: codesense_pty_core::domain::PtySessionId,
}

/// The legacy branch is local-only and requires a unique live owner. An object
/// must decode as a complete admitted target; it can never fall back to an id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeSessionReference {
    Admitted(Box<RuntimeSessionTarget>),
    Legacy(String),
}

impl RuntimeSessionReference {
    pub(crate) fn session(&self) -> &str {
        match self {
            Self::Admitted(target) => target.session.as_str(),
            Self::Legacy(session) => session,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWorkspaceTarget {
    #[serde(flatten)]
    pub runtime: RuntimeMemberTarget,
    pub workspace: codesense_pty_core::domain::WorkspaceKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeWorkspaceReference {
    Admitted(Box<RuntimeWorkspaceTarget>),
    Legacy(codesense_pty_core::domain::WorkspaceKey),
}

impl RuntimeWorkspaceReference {
    pub(crate) fn workspace(&self) -> &codesense_pty_core::domain::WorkspaceKey {
        match self {
            Self::Admitted(target) => &target.workspace,
            Self::Legacy(key) => key,
        }
    }
}
