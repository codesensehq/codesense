//! Test-only as a whole.
#![cfg(test)]

#[cfg(windows)]
fn t() {
    let _ = windows_sys::Win32::Foundation::CloseHandle;
}
