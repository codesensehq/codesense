#[cfg(cap_terminal_server_sidecar)]
mod sidecar {}

#[cfg(cap_no_such_capability)]
mod gone {}

fn main() {
    let _ = cfg!(cap_also_missing);
}
