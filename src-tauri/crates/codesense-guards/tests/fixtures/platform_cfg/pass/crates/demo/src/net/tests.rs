#[cfg(unix)]
#[test]
fn t() {
    let _ = unsafe { libc::getpid() };
}
