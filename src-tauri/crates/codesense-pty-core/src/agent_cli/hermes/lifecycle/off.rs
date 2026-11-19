// SPDX-License-Identifier: MIT
//! Where Unix process groups are not available yet: no gateway is verified, so
//! `teardown_home` signals nothing.
use super::*;

pub(super) fn verified_gateway(_home: &Path) -> Option<peer::PeerProcess> {
    None
}
