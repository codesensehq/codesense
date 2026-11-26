// SPDX-License-Identifier: MIT
//! `gifSearch`, the Inbox pane's GIF search: the `gif_search` tool's candidates, each with its
//! still as a `data:` URI the pane can show under its `img-src 'self' data:` CSP. The stills are
//! fetched for the person's own search, so only the team's remote media Off stops them.
//! `gifPicked` registers the person's pick with the provider.
use super::{search, Candidate, GifError, GifService, Provider, SearchArgs};
use crate::media::{preview, Config, Remote};
use serde::Serialize;
use std::time::Duration;

/// A candidate with its still, when it arrived in time.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageCandidate {
    #[serde(flatten)]
    pub candidate: Candidate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_data: Option<String>,
}

/// The `gifSearch` result: `{status:"ok", provider, candidates}` with `previewData` on each
/// candidate whose still loaded within `deadline`, or `{status:"error", error, message}`. With
/// the team's remote media Off it is `mediaOff`, before any keychain read or network call.
pub(crate) async fn search_page(
    service: &GifService,
    config: &Config,
    args: SearchArgs<'_>,
    stills: &dyn preview::PreviewFetch,
    deadline: Duration,
) -> serde_json::Value {
    if config.remote == Remote::Off {
        return GifError::MediaOff.tool_result();
    }
    let (provider, candidates) = match search(service, Some(config), args).await {
        Ok(found) => found,
        Err(failed) => return failed.tool_result(),
    };
    let urls: Vec<&str> = candidates.iter().map(|c| c.preview_url.as_str()).collect();
    let data = preview::previews(stills, provider.hosts(), &urls, deadline).await;
    let candidates: Vec<PageCandidate> = candidates
        .into_iter()
        .zip(data)
        .map(|(candidate, preview_data)| PageCandidate {
            candidate,
            preview_data,
        })
        .collect();
    serde_json::json!({
        "status": "ok",
        "provider": provider,
        "candidates": candidates,
    })
}

/// The app's still client, made on first use.
fn stills() -> Result<std::sync::Arc<preview::Http>, String> {
    static STILLS: std::sync::OnceLock<std::sync::Arc<preview::Http>> = std::sync::OnceLock::new();
    if let Some(http) = STILLS.get() {
        return Ok(http.clone());
    }
    let http = std::sync::Arc::new(preview::Http::new()?);
    Ok(STILLS.get_or_init(|| http).clone())
}

/// `gifSearch` from the Inbox pane: exactly one of `query` and `ids`, as `gif_search` takes
/// them, at the Settings rating ceiling. The dispatcher admits it from the pane only.
#[tauri::command]
pub async fn gif_search_page(
    app: tauri::AppHandle,
    team: crate::commands::agent_inbox::InboxTeam,
    query: Option<String>,
    ids: Option<Vec<String>>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let team = crate::commands::dashboard_launch::LaunchTeam::from(team);
    let config = crate::media::config(&app, &team).await?;
    let service = match super::service(&app) {
        Ok(service) => service,
        Err(e) => {
            log::warn!(target: "gif", "gif search page: unavailable: {e}");
            return Ok(GifError::ProviderUnavailable.tool_result());
        }
    };
    let stills = stills()?;
    let args = SearchArgs {
        query: query.as_deref(),
        ids: ids.as_deref(),
        limit,
        ..Default::default()
    };
    Ok(search_page(&service, &config, args, stills.as_ref(), preview::DEADLINE).await)
}

/// Check a pick of GIF `id` from `provider` and hand it to `register`. Resolves `{status:"ok"}`,
/// or `badQuery` for a provider or id that isn't one, with nothing registered.
pub(crate) fn picked(
    provider: &str,
    id: &str,
    register: impl FnOnce(Provider, String),
) -> serde_json::Value {
    let (Some(provider), true) = (Provider::parse(provider), super::valid_id(id)) else {
        return GifError::BadQuery("unknown GIF").tool_result();
    };
    register(provider, id.to_string());
    serde_json::json!({"status": "ok"})
}

/// `gifPicked` from the Inbox pane: the person picked a GIF in the picker. Its onclick goes
/// out in the background, once per pick; an id no search returned in the last hour, search Off
/// or no key is a quiet no-op. The dispatcher admits it from the pane only.
#[tauri::command]
pub async fn gif_picked(
    app: tauri::AppHandle,
    provider: String,
    id: String,
) -> Result<serde_json::Value, String> {
    Ok(picked(
        &provider,
        &id,
        |provider, id| match super::register::registration(&app) {
            Ok(registration) => super::register::click_in_background(&registration, provider, id),
            Err(e) => log::warn!(target: "gif", "gif pick: registration unavailable: {e}"),
        },
    ))
}
