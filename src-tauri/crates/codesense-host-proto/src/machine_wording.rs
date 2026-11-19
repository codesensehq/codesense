// SPDX-License-Identifier: MIT
//! How text a person reads names the computer CodeSense runs on: "This Mac"
//! on macOS and "This computer" on every other OS. The front end's
//! `src/shared/lib/local-machine.ts` holds the same three forms.
//!
//! Each function takes the OS name (`std::env::consts::OS`) as an argument, so
//! one test pins every OS's wording on any host. A caller passes
//! [`RUNNING_OS`]. Values an agent reads as data (a machine label such as
//! "This Mac") don't come from here.

/// The OS this build runs on, as `std::env::consts::OS` names it.
pub const RUNNING_OS: &str = std::env::consts::OS;

/// The computer's name at the start of a sentence or as a label: "This Mac"
/// or "This computer".
pub fn machine_noun(os: &str) -> &'static str {
    if is_mac(os) {
        "This Mac"
    } else {
        "This computer"
    }
}

/// The computer's name mid-sentence: "this Mac" or "this computer".
pub fn machine_noun_lower(os: &str) -> &'static str {
    if is_mac(os) {
        "this Mac"
    } else {
        "this computer"
    }
}

/// The bare noun, as in "another Mac" or "each teammate's computer": "Mac" or
/// "computer".
pub fn machine_kind(os: &str) -> &'static str {
    if is_mac(os) {
        "Mac"
    } else {
        "computer"
    }
}

fn is_mac(os: &str) -> bool {
    os == "macos"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_form_names_the_computer_for_its_os() {
        let table = [
            ("macos", "This Mac", "this Mac", "Mac"),
            ("linux", "This computer", "this computer", "computer"),
            ("windows", "This computer", "this computer", "computer"),
        ];
        for (os, noun, lower, kind) in table {
            assert_eq!(machine_noun(os), noun, "machine_noun({os})");
            assert_eq!(machine_noun_lower(os), lower, "machine_noun_lower({os})");
            assert_eq!(machine_kind(os), kind, "machine_kind({os})");
        }
    }
}
