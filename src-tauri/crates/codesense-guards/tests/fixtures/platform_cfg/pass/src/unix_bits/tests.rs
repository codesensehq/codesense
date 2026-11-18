use std::os::unix::fs::PermissionsExt;

#[cfg(target_os = "linux")]
#[test]
fn reached_only_through_a_test_gated_declaration() {
    let _ = unsafe { libc::getuid() };
}
