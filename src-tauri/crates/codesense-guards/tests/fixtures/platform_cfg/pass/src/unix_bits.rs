#[cfg(test)]
mod tests;

// One attribute naming two OS predicates is one site; each path is one more.
#[cfg(any(unix, target_os = "macos"))]
pub fn run() {
    let _ = unsafe { libc::getpid() };
    let _ = std::os::unix::ffi::OsStrExt::as_bytes;
}

pub fn not_os() {
    let _ = cfg!(debug_assertions);
    #[cfg(feature = "unix")]
    let _ = 0;
    #[cfg_attr(test, allow(unused))]
    let _ = 1;
}
