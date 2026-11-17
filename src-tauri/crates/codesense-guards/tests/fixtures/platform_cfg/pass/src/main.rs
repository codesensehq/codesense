//! cfg!(windows) in an inner doc comment is not a site.
// cfg(unix), libc:: and std::os::unix in a line comment are not sites.
/* a block comment /* nested: #[cfg(windows)] */ still a comment: libc::getpid */

mod mac_ui;
mod unix_bits;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "helpers/fake.rs"]
mod fake;
// Also declared by the `other` binary, so it is production code.
#[cfg(test)]
#[path = "both.rs"]
mod both_in_tests;
#[cfg(test)]
mod nested {
    // Inside an inline module, `#[path]` is relative to `src/nested/`.
    #[path = "deep.rs"]
    mod deep;
}

/// #[cfg(target_os = "linux")] in a doc comment.
fn main() {
    let _ = "libc:: and #[cfg(unix)] in a string";
    let _ = "an escaped quote \" then libc::";
    let _ = r#"a raw string with "quotes" and std::os::windows"#;
    let _ = b"windows_sys::";
    let _ = ('"', '\'', b'"');
    #[cfg(unix)]
    unix_bits::run();
}

#[cfg(test)]
mod inline_tests {
    #[cfg(unix)]
    #[test]
    fn unix_only() {
        let _ = libc::getpid;
    }
}
