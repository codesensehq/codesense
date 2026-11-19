// SPDX-License-Identifier: MIT
//! The process tree `tests/process_tree.rs` starts in a pty, so it needs no
//! shell: it starts one grandchild (itself, asked to `sleep`), writes its own
//! pid and the grandchild's to the file it is given, then sleeps.

use std::time::Duration;

fn main() {
    let arg = std::env::args_os().nth(1).expect("a pid file or `sleep`");
    if arg == "sleep" {
        sleep_forever();
    }
    let grandchild = std::process::Command::new(std::env::current_exe().expect("own path"))
        .arg("sleep")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("start the grandchild");
    // Written whole, then renamed, so the test never reads half of it.
    let pid_file = std::path::PathBuf::from(arg);
    let partial = pid_file.with_extension("partial");
    std::fs::write(
        &partial,
        format!("{} {}", std::process::id(), grandchild.id()),
    )
    .expect("write the pids");
    std::fs::rename(&partial, &pid_file).expect("publish the pids");
    sleep_forever();
}

fn sleep_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
