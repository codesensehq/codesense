// SPDX-License-Identifier: MIT
//! What the bridge's hook tests share: temporary directories and a local listener standing in
//! for the app's API.
// Each test file uses part of it.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

/// A fresh temporary directory, removed when dropped.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "codesense-bridge-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Answer each request 200 and hand its bytes back, head and body.
pub fn listener() -> (String, mpsc::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            // The whole request: its head, then the body its Content-Length names.
            loop {
                let n = stream.read(&mut chunk).unwrap();
                raw.extend_from_slice(&chunk[..n]);
                if let Some((head, body)) = split(&raw) {
                    let length: usize = String::from_utf8_lossy(head)
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: ").map(str::to_owned))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if body.len() >= length {
                        break;
                    }
                }
                assert!(n > 0, "request ended early");
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            let _ = tx.send(raw);
        }
    });
    (port, rx)
}

/// A request's head and body, once the blank line between them has arrived.
pub fn split(request: &[u8]) -> Option<(&[u8], &[u8])> {
    let at = request.windows(4).position(|w| w == b"\r\n\r\n")?;
    Some((&request[..at], &request[at + 4..]))
}
