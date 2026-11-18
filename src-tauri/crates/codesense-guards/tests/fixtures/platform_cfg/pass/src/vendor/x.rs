// Vendored code is not scanned.
#[cfg(unix)]
pub fn vendored() {
    let _ = unsafe { libc::getpid() };
}
