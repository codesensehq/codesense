// A capability gate compiles this module; the OS code inside it still counts.
#[cfg(unix)]
pub fn listen() {}

pub fn bridge_compiled() -> bool {
    cfg!(cap_bridge)
}
