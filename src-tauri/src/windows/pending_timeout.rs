// SPDX-License-Identifier: MIT
//! How long a new window may take to show its first paint before its open counts as failed.

/// Cold first paints (ms) recorded for the timeout. Empty until a real two-window build is
/// measured, so [`PENDING_TIMEOUT_MS`] holds its unmeasured default.
const COLD_FIRST_PAINTS_MS: &[u64] = &[];

/// The timeout used before any cold first paint is recorded.
const UNMEASURED_MS: u64 = 10_000;

/// The lowest timeout the formula gives, however fast the paints.
const FLOOR_MS: u64 = 5_000;

/// The slowest cold first paint × 3, rounded up to the next whole second, and never below
/// 5,000 ms.
pub const fn pending_timeout_ms(cold_ms: &[u64]) -> u64 {
    let mut slowest: u64 = 0;
    let mut i = 0;
    while i < cold_ms.len() {
        if cold_ms[i] > slowest {
            slowest = cold_ms[i];
        }
        i += 1;
    }
    let rounded = slowest.saturating_mul(3).div_ceil(1_000) * 1_000;
    if rounded < FLOOR_MS {
        FLOOR_MS
    } else {
        rounded
    }
}

/// The timeout for a set of recorded cold paints: the formula, or 10,000 ms with none recorded.
const fn timeout_for(recorded: &[u64]) -> u64 {
    if recorded.is_empty() {
        UNMEASURED_MS
    } else {
        pending_timeout_ms(recorded)
    }
}

/// How long a new window may take to paint before its open counts as failed.
#[allow(dead_code)] // read by the window-open path, which lands after this module.
pub const PENDING_TIMEOUT_MS: u64 = timeout_for(COLD_FIRST_PAINTS_MS);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paints_under_one_point_six_seconds_give_the_floor() {
        assert_eq!(pending_timeout_ms(&[400, 900, 1_200, 1_500, 1_599]), 5_000);
        assert_eq!(pending_timeout_ms(&[]), 5_000);
    }

    #[test]
    fn rounds_the_tripled_slowest_paint_up_to_a_whole_second() {
        assert_eq!(
            pending_timeout_ms(&[1_000, 2_345, 1_800, 900, 2_000]),
            8_000
        );
        assert_eq!(pending_timeout_ms(&[2_000]), 6_000);
        assert_eq!(pending_timeout_ms(&[2_001]), 7_000);
    }

    #[test]
    fn the_constant_is_the_formula_over_the_recorded_paints() {
        assert_eq!(PENDING_TIMEOUT_MS, timeout_for(COLD_FIRST_PAINTS_MS));
        assert_eq!(timeout_for(&[]), 10_000);
        assert_eq!(timeout_for(&[2_345]), 8_000);
    }
}
