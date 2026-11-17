#[cfg(unix)]
#[test]
fn reached_only_through_a_test_gated_declaration() {
    let _ = unsafe { libc::getpid() };
}
