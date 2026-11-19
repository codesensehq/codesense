#[cfg(unix)]
pub mod bridge;
pub mod inner_gate;
pub mod net;

pub fn bridge_available() -> bool {
    cfg!(unix)
}

#[cfg(all(test, windows))]
mod win_tests {
    fn t() {
        let _ = windows_sys::Win32::Foundation::CloseHandle;
    }
}
