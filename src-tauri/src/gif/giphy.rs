// SPDX-License-Identifier: MIT
//! The GIPHY adapter: `/v1/gifs/search` and `/v1/gifs?ids=`, straight from this machine with the
//! user's own key, every request carrying the rating.
use super::transport::{classify, Transport};
use super::{Found, GifError, GifProvider, Pingbacks, Provider, Rating, Rendition};
use crate::commands::credential_store::Secret;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

const API: &str = "https://api.giphy.com/v1/gifs";
/// The most results one search asks for: twice the limit, so results dropped by the rating or
/// the rendition rule still leave enough.
const MAX_FETCH: usize = 25;

/// GIPHY with one key. `now_ms` dates a `Retry-After` given as an HTTP-date.
pub(crate) struct Giphy {
    key: Secret,
    transport: Arc<dyn Transport>,
    now_ms: i64,
}

impl Giphy {
    pub(crate) fn new(key: Secret, transport: Arc<dyn Transport>, now_ms: i64) -> Self {
        Self {
            key,
            transport,
            now_ms,
        }
    }

    fn api_url(&self, path: &str, pairs: &[(&str, &str)], rating: Rating) -> url::Url {
        let mut url: url::Url = format!("{API}{path}").parse().expect("the GIPHY API URL");
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("api_key", self.key.expose());
            for (name, value) in pairs {
                query.append_pair(name, value);
            }
            query.append_pair("rating", rating.as_str());
        }
        url
    }

    /// The `data` array of a GET, or the typed error. Log lines name the status or the failure,
    /// never the URL, which holds the key.
    async fn api_data(&self, url: url::Url) -> Result<Vec<Value>, GifError> {
        let reply = self.transport.get(&url).await;
        let body = classify(Provider::Giphy, reply, self.now_ms)?;
        match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Object(mut body)) => match body.remove("data") {
                Some(Value::Array(data)) => Ok(data),
                _ => Err(malformed()),
            },
            _ => Err(malformed()),
        }
    }
}

fn malformed() -> GifError {
    log::warn!(target: "gif", "gif search: GIPHY's response was not the expected JSON");
    GifError::ProviderUnavailable
}

impl GifProvider for Giphy {
    fn search_gifs<'a>(
        &'a self,
        query: &'a str,
        rating: Rating,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move {
            let fetch = (limit * 2).min(MAX_FETCH).to_string();
            let url = self.api_url(
                "/search",
                &[("q", query), ("limit", fetch.as_str())],
                rating,
            );
            let data = self.api_data(url).await?;
            Ok(data
                .iter()
                .filter_map(|gif| found(gif, rating))
                .take(limit)
                .collect())
        })
    }

    fn lookup_gifs<'a>(
        &'a self,
        ids: &'a [String],
        rating: Rating,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move {
            let joined = ids.join(",");
            let url = self.api_url("", &[("ids", joined.as_str())], rating);
            let data = self.api_data(url).await?;
            let mut by_id: HashMap<String, Found> = data
                .iter()
                .filter_map(|gif| found(gif, rating))
                .map(|f| (f.candidate.id.clone(), f))
                .collect();
            Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
        })
    }
}

/// A GIF's rating is within `ceiling`. GIPHY's `y` (youth) counts as g; a missing or unknown
/// rating, or `r`, is not within any ceiling.
fn within(gif: &Value, ceiling: Rating) -> bool {
    let rating = gif.get("rating").and_then(Value::as_str).unwrap_or("");
    let rating = if rating.eq_ignore_ascii_case("y") {
        Some(Rating::G)
    } else {
        Rating::parse(rating)
    };
    rating.is_some_and(|r| r <= ceiling)
}

/// One GIPHY result as a candidate with its pingbacks, or `None` when it is above the rating or
/// has no qualifying rendition.
fn found(gif: &Value, rating: Rating) -> Option<Found> {
    if !within(gif, rating) {
        return None;
    }
    let id = gif.get("id")?.as_str()?;
    let title = gif.get("title").and_then(Value::as_str).unwrap_or("");
    let images = gif.get("images")?.as_object()?;
    let candidate = super::candidate(Provider::Giphy, id, title, &renditions(images))?;
    Some(Found {
        candidate,
        pingbacks: pingbacks(gif.get("analytics")),
    })
}

/// GIPHY's `analytics.{onload,onclick,onsent}.url`, each kept only on GIPHY's hosts over https.
fn pingbacks(analytics: Option<&Value>) -> Option<Pingbacks> {
    let url = |event: &str| {
        let url = analytics?.get(event)?.get("url")?.as_str();
        Pingbacks::keep_url(Provider::Giphy, url)
    };
    Pingbacks {
        onload: url("onload"),
        onclick: url("onclick"),
        onsent: url("onsent"),
    }
    .if_any()
}

/// Every GIF and WebP rendition GIPHY lists: each image's `url` (GIF, or a still for the
/// `*_still` names) and its `webp`. mp4 renditions are never candidates, so they are not read.
fn renditions(images: &serde_json::Map<String, Value>) -> Vec<Rendition> {
    let mut renditions = Vec::new();
    for (name, image) in images {
        let still = name.ends_with("_still");
        let size = |field: &str| number(image.get(field));
        let side = |field: &str| size(field).and_then(|n| u32::try_from(n).map_or(None, Some));
        let (width, height) = (side("width"), side("height"));
        for (url_field, size_field) in [("url", "size"), ("webp", "webp_size")] {
            if let Some(url) = image.get(url_field).and_then(Value::as_str) {
                renditions.push(Rendition {
                    name: name.clone(),
                    url: url.to_string(),
                    format: super::Format::of_url(url),
                    still,
                    width,
                    height,
                    bytes: size(size_field),
                });
            }
        }
    }
    renditions
}

/// GIPHY sends sizes as strings of digits; a number is read too.
fn number(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::String(text) => text.trim().parse().map_or(None, Some),
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}
