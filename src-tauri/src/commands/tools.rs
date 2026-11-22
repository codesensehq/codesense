// SPDX-License-Identifier: MIT
use std::path::Path;

use log::{error, info};
use serde::Serialize;

use crate::commands::async_helpers::await_blocking;

mod terminals;

#[derive(Debug, Clone, Serialize)]
pub struct Tool {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedTools {
    pub terminals: Vec<Tool>,
    pub editors: Vec<Tool>,
    pub default_terminal: String,
    pub default_editor: String,
}

fn app_exists(name: &str) -> bool {
    Path::new(&format!("/Applications/{}.app", name)).exists()
}

#[tauri::command]
pub async fn detect_tools() -> Result<DetectedTools, String> {
    await_blocking("detect_tools", detect_tools_impl).await
}

fn detect_tools_impl() -> Result<DetectedTools, String> {
    let os = std::env::consts::OS;
    let detected = terminals::detect(os, &terminals::host_find);
    let default_terminal = terminals::default_terminal(
        os,
        &detected,
        &std::env::var("TERM_PROGRAM").unwrap_or_default(),
    );
    let terminals: Vec<Tool> = detected.iter().map(terminals::Detected::tool).collect();
    let mut editors = Vec::new();

    // Detect editors
    if app_exists("Cursor") {
        editors.push(Tool {
            id: "cursor".into(),
            label: "Cursor".into(),
        });
    }

    // Default editor: first detected
    let default_editor = editors.first().map(|e| e.id.clone()).unwrap_or_default();

    let terminal_names: Vec<&str> = terminals.iter().map(|t| t.id.as_str()).collect();
    let editor_names: Vec<&str> = editors.iter().map(|e| e.id.as_str()).collect();
    info!(target: "tools", "detect_tools: terminals={:?}, editors={:?}", terminal_names, editor_names);

    Ok(DetectedTools {
        terminals,
        editors,
        default_terminal,
        default_editor,
    })
}

#[tauri::command]
pub async fn open_terminal(
    terminal: String,
    custom_cmd: String,
    repo_path: String,
    run_command: String,
) -> Result<(), String> {
    info!(target: "tools", "open_terminal: terminal={}, repo_path={}", terminal, repo_path);
    await_blocking("open_terminal", move || {
        open_terminal_impl(terminal, custom_cmd, repo_path, run_command)
    })
    .await
}

fn open_terminal_impl(
    terminal: String,
    custom_cmd: String,
    repo_path: String,
    run_command: String,
) -> Result<(), String> {
    if terminal == "custom" {
        if custom_cmd.is_empty() {
            return Err("No custom terminal command configured".into());
        }
        let mut command = std::process::Command::new(&custom_cmd);
        crate::linux_startup::remove_app_webkit_env(&mut command);
        return command.arg(&repo_path).spawn().map(|_| ()).map_err(|e| {
            error!(target: "tools", "open_terminal: spawn failed for custom: {}", e);
            format!("Failed to open terminal: {}", e)
        });
    }

    let chosen = terminals::terminal_launch(
        std::env::consts::OS,
        &terminal,
        Path::new(&repo_path),
        &run_command,
        &terminals::host_find,
        &|path: &Path| path.is_dir(),
    )?;
    // Ghostty can't be handed a command, so it goes on the clipboard to paste.
    if let Some(clipboard) = &chosen.clipboard {
        // Named so the write guard's resolver sees `Launch` and resolves `.command()`;
        // removing the annotation raises the guard's unresolved-call count.
        let pbcopy: &crate::shared::opener::Launch = &clipboard.launch;
        let _ = pbcopy
            .command()
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                // Dropped before the wait: pbcopy reads to end of input.
                if let Some(mut stdin) = child.stdin.take() {
                    stdin.write_all(clipboard.text.as_bytes())?;
                }
                child.wait()
            });
    }
    crate::shared::opener::spawn_first(
        std::slice::from_ref(&chosen.launch),
        &crate::shared::opener::HostSpawn,
    )
    .map_err(|e| {
        error!(target: "tools", "open_terminal: spawn failed for {}: {}", chosen.label, e);
        format!("Failed to open {}: {}", chosen.label, e)
    })
}

#[tauri::command]
pub async fn open_editor(
    editor: String,
    custom_cmd: String,
    repo_path: String,
) -> Result<(), String> {
    info!(target: "tools", "open_editor: editor={}, repo_path={}", editor, repo_path);
    await_blocking("open_editor", move || {
        open_editor_impl(editor, custom_cmd, repo_path)
    })
    .await
}

fn open_editor_impl(editor: String, custom_cmd: String, repo_path: String) -> Result<(), String> {
    let result = match editor.as_str() {
        "cursor" => std::process::Command::new("open")
            .args(["-a", "Cursor", &repo_path])
            .spawn(),
        "custom" => {
            if custom_cmd.is_empty() {
                return Err("No custom editor command configured".into());
            }
            let mut command = std::process::Command::new(&custom_cmd);
            crate::linux_startup::remove_app_webkit_env(&mut command);
            command.arg(&repo_path).spawn()
        }
        _ => return Err(format!("Unknown editor: {}", editor)),
    };

    result.map(|_| ()).map_err(|e| {
        error!(target: "tools", "open_editor: spawn failed for {}: {}", editor, e);
        format!("Failed to open editor: {}", e)
    })
}
