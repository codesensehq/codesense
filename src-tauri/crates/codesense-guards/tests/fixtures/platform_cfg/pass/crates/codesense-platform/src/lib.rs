#[cfg(windows)]
pub fn close() {
    let _ = windows_sys::Win32::Foundation::CloseHandle;
}
