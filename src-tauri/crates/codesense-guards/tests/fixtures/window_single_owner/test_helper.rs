// SPDX-License-Identifier: MIT
// Same-named helpers in test code only.

struct Bench;

impl Bench {
    #[cfg(test)]
    fn resolve_target(&self) {}
}

#[cfg(test)]
mod helpers {
    pub fn return_by_kind() {}
    pub fn route_path_event() {}
}

#[test]
fn resolve_target() {}
