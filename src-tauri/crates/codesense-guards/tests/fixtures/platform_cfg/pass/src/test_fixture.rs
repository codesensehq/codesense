// A feature-gated test helper with no every-OS caller, gated whole; its row
// names a test-scope capability.
#[cfg(unix)]
pub fn census() {}
