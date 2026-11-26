// SPDX-License-Identifier: MIT
//! `gif_search`: agents find GIFs to send with a message. The provider call, the key and the rate
//! limit live in `crate::gif`; this checks the input and marks what the caller's team shows
//! inline. No argument carries a key: the key is entered in Settings only.
use rmcp::schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::dashboard_launch::LaunchTeam;
use crate::gif::{self, GifError, GifService};
use crate::media::Config;

/// `gif_search` inputs: exactly one of `query` and `ids`.
#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GifSearchParams {
    /// What the GIF should show: 1 to 100 characters, no control characters.
    #[serde(default)]
    pub query: Option<String>,
    /// Provider ids from an earlier result, to fetch those GIFs again: 1 to 10, each
    /// `^[A-Za-z0-9_-]{1,128}$`.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    /// How many candidates a search returns: 1 to 10, default 6.
    #[serde(default)]
    pub limit: Option<i64>,
    /// `g`, `pg` or `pg-13`, at most the ceiling set in Settings; omitted or higher means the
    /// ceiling.
    #[serde(default)]
    pub rating: Option<String>,
    /// Whose ids `ids` are: `giphy` or `klipy`. Omitted means the active one.
    #[serde(default)]
    pub provider: Option<String>,
}

/// Run `gif_search` for a caller whose team is `team` (none: nothing auto-loads).
pub(crate) async fn gif_search(
    app: &tauri::AppHandle,
    team: Option<&LaunchTeam>,
    params: GifSearchParams,
) -> serde_json::Value {
    let service = match gif::service(app) {
        Ok(service) => service,
        Err(e) => {
            log::warn!(target: "gif", "gif search: unavailable: {e}");
            return GifError::tool_result(GifError::ProviderUnavailable);
        }
    };
    let config = match team {
        Some(team) => match crate::media::config(app, team).await {
            Ok(config) => Some(config),
            Err(_) => None,
        },
        None => None,
    };
    search_with(&service, config.as_ref(), params).await
}

/// The tool result for `params` on `service`: `{status:"ok", provider, candidates}` or
/// `{status:"error", error, message}`. With no team `config`, nothing auto-loads.
pub(crate) async fn search_with(
    service: &GifService,
    config: Option<&Config>,
    params: GifSearchParams,
) -> serde_json::Value {
    let args = gif::SearchArgs {
        query: params.query.as_deref(),
        ids: params.ids.as_deref(),
        limit: params.limit,
        rating: params.rating.as_deref(),
        provider: params.provider.as_deref(),
    };
    match gif::search(service, config, args).await {
        Ok((provider, candidates)) => serde_json::json!({
            "status": "ok",
            "provider": provider,
            "candidates": candidates,
        }),
        Err(failed) => failed.tool_result(),
    }
}
