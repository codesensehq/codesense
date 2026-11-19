#[cfg(unix)]
pub mod bridge;
// A capability gate is not an OS predicate: not a site, and no row.
#[cfg(cap_bridge)]
pub mod capped;
pub mod inner_gate;
pub mod net;

pub fn bridge_available() -> bool {
    cfg!(unix)
}

pub fn bridge_compiled() -> bool {
    cfg!(cap_bridge)
}

#[cfg(all(test, windows))]
mod win_tests {
    fn t() {
        let _ = windows_sys::Win32::Foundation::CloseHandle;
    }
}
