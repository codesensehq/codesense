// SPDX-License-Identifier: MIT
//! `gif_search`: agents find GIFs to send with a message. The provider call, the key and the rate
//! limit live in `crate::gif`; this checks the input and marks what the caller's team shows
//! inline. No argument carries a key: the key is entered in Settings only.
use rmcp::schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::dashboard_launch::LaunchTeam;
use crate::gif::{self, GifError, Provider};

/// `gif_search` inputs: exactly one of `query` and `ids`.
#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GifSearchParams {
    /// What the GIF should show: 1 to 100 characters, no control characters.
    #[serde(default)]
    pub query: Option<String>,
    /// Provider ids from an earlier result, to fetch those GIFs again: 1 to 10, each
    /// `^[A-Za-z0-9_-]{1,64}$`.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// How many candidates a search returns: 1 to 10, default 6.
    #[serde(default)]
    pub limit: Option<i64>,
    /// `g`, `pg` or `pg-13`, at most the ceiling set in Settings; omitted or higher means the
    /// ceiling.
    #[serde(default)]
    pub rating: Option<String>,
    /// Whose ids `ids` are: `giphy`, the only provider today. Omitted means the active one.
    #[serde(default)]
    pub provider: Option<String>,
}

/// Run `gif_search` for a caller whose team is `team` (none: nothing auto-loads). Returns the
/// tool result: `{status:"ok", provider, candidates}` or `{status:"error", error, message}`.
pub(crate) async fn gif_search(
    app: &tauri::AppHandle,
    team: Option<&LaunchTeam>,
    params: GifSearchParams,
) -> serde_json::Value {
    match run(app, team, params).await {
        Ok((provider, candidates)) => serde_json::json!({
            "status": "ok",
            "provider": provider,
            "candidates": candidates,
        }),
        Err(error) => error.tool_result(),
    }
}

async fn run(
    app: &tauri::AppHandle,
    team: Option<&LaunchTeam>,
    params: GifSearchParams,
) -> Result<(Provider, Vec<gif::Candidate>), GifError> {
    let request = gif::normalize(params.query.as_deref(), params.ids.as_deref(), params.limit)?;
    let provider = match params.provider.as_deref() {
        None => Provider::Giphy,
        Some(name) => Provider::parse(name).ok_or(GifError::BadQuery("provider is giphy"))?,
    };
    let service = gif::service(app).map_err(|e| {
        log::warn!(target: "gif", "gif search: unavailable: {e}");
        GifError::ProviderUnavailable
    })?;
    let mut candidates = gif::GifService::run(&service, &request, params.rating.as_deref()).await?;
    let config = match team {
        Some(team) => crate::media::config(app, team).await.ok(),
        None => None,
    }
    .unwrap_or(crate::media::Config {
        remote: crate::media::Remote::Off,
        ..Default::default()
    });
    gif::set_auto_loads(&mut candidates, &config);
    Ok((provider, candidates))
}
