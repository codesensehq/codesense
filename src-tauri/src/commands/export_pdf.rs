// SPDX-License-Identifier: MIT
//! PDF export via a hidden offscreen web view, plus a binary file write.
//!
//! Two Tauri commands, compiled where the `pdf-export` capability is on:
//! - `export_pdf_from_url`: loads a URL and exports to PDF
//! - `export_pdf_from_html`: loads an HTML string and exports to PDF
//!
//! Each OS renders in its own `render` module, which turns a [`ContentSource`]
//! into PDF bytes: `export_pdf/macos.rs` (WKWebView `createPDF`) and
//! `export_pdf/linux.rs` (a WebKitGTK print operation). The commands here own
//! the timeout and the write.
//!
//! Plus a utility command, compiled on every OS (canvas PNG and SVG export):
//! - `write_binary_file`: decodes base64 data and writes raw bytes to disk

use base64::Engine as _;
use log::debug;
use std::fs;
use std::path::PathBuf;

#[cfg(all(cap_pdf_export, target_os = "macos"))]
#[path = "export_pdf/macos.rs"]
mod render;
#[cfg(all(cap_pdf_export, target_os = "linux"))]
#[path = "export_pdf/linux.rs"]
mod render;

/// What an export loads: a URL, or an HTML string.
#[cfg(cap_pdf_export)]
enum ContentSource {
    Url(String),
    Html(String),
}

/// Render `source` to PDF within 30 seconds and write it to `output_path`.
#[cfg(cap_pdf_export)]
async fn export(source: ContentSource, output_path: String) -> Result<(), String> {
    let pdf_bytes =
        tokio::time::timeout(std::time::Duration::from_secs(30), render::render(source))
            .await
            .map_err(|_| "PDF export timed out after 30 seconds".to_string())?
            .map_err(|e| format!("PDF generation failed: {}", e))?;

    let path = PathBuf::from(&output_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    tokio::fs::write(&path, &pdf_bytes)
        .await
        .map_err(|e| format!("Failed to write PDF to {}: {}", output_path, e))?;

    debug!(target: "export_pdf", "PDF written: {} bytes to {}", pdf_bytes.len(), output_path);
    Ok(())
}

#[cfg(cap_pdf_export)]
#[tauri::command]
pub async fn export_pdf_from_url(url: String, output_path: String) -> Result<(), String> {
    debug!(target: "export_pdf", "export_pdf_from_url: url={}, output={}", url, output_path);
    export(ContentSource::Url(url), output_path).await
}

#[cfg(cap_pdf_export)]
#[tauri::command]
pub async fn export_pdf_from_html(html: String, output_path: String) -> Result<(), String> {
    debug!(target: "export_pdf", "export_pdf_from_html: html_len={}, output={}", html.len(), output_path);
    export(ContentSource::Html(html), output_path).await
}

#[tauri::command]
pub async fn write_binary_file(base64_data: String, output_path: String) -> Result<(), String> {
    crate::commands::await_blocking("write_binary_file", move || {
        debug!(target: "export_pdf", "write_binary_file: output={}", output_path);

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_data)
            .map_err(|e| format!("Base64 decode failed: {}", e))?;

        let path = PathBuf::from(&output_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
        }

        fs::write(&path, &bytes)
            .map_err(|e| format!("Failed to write file {}: {}", output_path, e))?;

        debug!(target: "export_pdf", "Binary file written: {} bytes to {}", bytes.len(), output_path);
        Ok(())
    })
    .await
}
