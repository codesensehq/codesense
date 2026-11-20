// SPDX-License-Identifier: MIT
//! What the bridge's hook tests share: a local listener standing in for the app's API.
// Each test file uses part of it.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

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
