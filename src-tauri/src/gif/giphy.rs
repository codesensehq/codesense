// SPDX-License-Identifier: MIT
//! The GIPHY adapter: `/v1/gifs/search` and `/v1/gifs?ids=`, straight from this machine with the
//! user's own key, every request carrying the rating.
use super::{Found, GifError, GifProvider, Pingbacks, Provider, Rating, Rendition};
use crate::commands::credential_store::Secret;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};

const API: &str = "https://api.giphy.com/v1/gifs";
/// The largest API response read: a page of results is well under this.
pub(crate) const MAX_BODY: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const USER_AGENT: &str = "CodeSense-GifSearch/1.0";
/// The most results one search asks for: twice the limit, so results dropped by the rating or
/// the rendition rule still leave enough.
const MAX_FETCH: usize = 25;

/// An API response: the status, its `Retry-After` and the body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reply {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: Vec<u8>,
}

/// Why no response came back. It names no URL, so it can be logged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    Timeout,
    Network,
    TooLarge,
}

/// Gets an API URL. Production is [`Http`]; tests stand in recorded replies.
pub(crate) trait Transport: Send + Sync {
    fn get<'a>(&'a self, url: &'a url::Url) -> BoxFuture<'a, Result<Reply, Failure>>;
}

/// The network transport: the shared hardened client, https only, no redirects, at most
/// [`MAX_BODY`] read. A failure keeps only its kind: the reqwest error, whose text holds the
/// URL and so the key, is dropped.
pub(crate) struct Http {
    client: reqwest::Client,
}
impl Http {
    pub(crate) fn new() -> Result<Self, String> {
        Self::on(crate::media::hardened_client_builder(TIMEOUT).https_only(true))
    }

    /// The transport over `base`, with the user agent and no redirects. Tests pass a plain
    /// builder so a local server can answer.
    pub(crate) fn on(base: reqwest::ClientBuilder) -> Result<Self, String> {
        let client = base
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "the GIF search client could not start".to_string())?;
        Ok(Self { client })
    }
}
fn failure(error: &reqwest::Error) -> Failure {
    if reqwest::Error::is_timeout(error) {
        Failure::Timeout
    } else {
        Failure::Network
    }
}
impl Transport for Http {
    fn get<'a>(&'a self, url: &'a url::Url) -> BoxFuture<'a, Result<Reply, Failure>> {
        Box::pin(async move {
            let request = self
                .client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json");
            let mut response = match request.send().await {
                Ok(response) => response,
                Err(error) => return Err(failure(&error)),
            };
            let status = reqwest::Response::status(&response).as_u16();
            let retry_after = match response.headers().get(reqwest::header::RETRY_AFTER) {
                Some(value) => match value.to_str() {
                    Ok(text) => Some(text.to_owned()),
                    Err(_) => None,
                },
                None => None,
            };
            if reqwest::Response::content_length(&response).is_some_and(|n| n > MAX_BODY as u64) {
                return Err(Failure::TooLarge);
            }
            let mut body = Vec::new();
            loop {
                let chunk = match response.chunk().await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => break,
                    Err(error) => return Err(failure(&error)),
                };
                if body.len() + chunk.len() > MAX_BODY {
                    return Err(Failure::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Reply {
                status,
                retry_after,
                body,
            })
        })
    }
}

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
        let reply = match self.transport.get(&url).await {
            Ok(reply) => reply,
            Err(failure) => {
                log::warn!(target: "gif", "gif search: the GIPHY request failed ({failure:?})");
                return Err(GifError::ProviderUnavailable);
            }
        };
        match reply.status {
            200..=299 => {}
            401 | 403 => {
                log::warn!(target: "gif", "gif search: GIPHY refused the key (HTTP {})", reply.status);
                return Err(GifError::InvalidKey);
            }
            429 => {
                let retry_after =
                    super::bucket::retry_after_secs(reply.retry_after.as_deref(), self.now_ms);
                log::warn!(target: "gif", "gif search: GIPHY rate limited searches for {retry_after} s");
                return Err(GifError::RateLimited { retry_after });
            }
            status @ 400..=499 => {
                log::warn!(target: "gif", "gif search: GIPHY refused the request (HTTP {status})");
                return Err(GifError::BadQuery("GIPHY refused the request"));
            }
            status => {
                log::warn!(target: "gif", "gif search: GIPHY answered HTTP {status}");
                return Err(GifError::ProviderUnavailable);
            }
        }
        match serde_json::from_slice::<Value>(&reply.body) {
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
