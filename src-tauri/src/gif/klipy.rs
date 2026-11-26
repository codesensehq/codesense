// SPDX-License-Identifier: MIT
//! The KLIPY adapter: `gifs/search` and `gifs/items?slugs=`, straight from this machine with the
//! user's own key, which KLIPY takes in the URL path. A GIF's id is its slug. A lookup takes no
//! rating: [`super::GifService::run_in`] cuts its ids to the ones a rated search returned.
use super::transport::{classify, Transport};
use super::{Found, GifError, GifProvider, Provider, Rating, Rendition};
use crate::commands::credential_store::Secret;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

const API: &str = "https://api.klipy.com/api/v1";
/// The fewest results a KLIPY page holds.
const MIN_PER_PAGE: usize = 8;
/// The sizes and formats a result lists under `file`; `jpg` is the still.
const SIZES: [&str; 4] = ["hd", "md", "sm", "xs"];
const FORMATS: [&str; 3] = ["gif", "webp", "jpg"];

/// KLIPY with one key. `customer_id` is this install's id for the key, sent with each search.
/// `now_ms` dates a `Retry-After` given as an HTTP-date.
pub(crate) struct Klipy {
    key: Secret,
    customer_id: Option<String>,
    transport: Arc<dyn Transport>,
    now_ms: i64,
}

impl Klipy {
    pub(crate) fn new(
        key: Secret,
        customer_id: Option<String>,
        transport: Arc<dyn Transport>,
        now_ms: i64,
    ) -> Self {
        Self {
            key,
            customer_id,
            transport,
            now_ms,
        }
    }

    /// `api/v1/{key}/{path…}` with `pairs`. The key is pushed as one path segment, so a `/`,
    /// `?`, `#` or `%` in it is escaped and never ends the segment.
    fn api_url(&self, path: &[&str], pairs: &[(&str, &str)]) -> url::Url {
        api_url(&self.key, path, pairs)
    }

    /// The `data.data` array of a GET, or the typed error. Log lines name the status or the
    /// failure, never the URL, which holds the key.
    async fn api_data(&self, url: url::Url) -> Result<Vec<Value>, GifError> {
        let reply = self.transport.get(&url).await;
        let body = classify(Provider::Klipy, reply, self.now_ms)?;
        let Ok(Value::Object(mut body)) = serde_json::from_slice::<Value>(&body) else {
            return Err(malformed());
        };
        if body.get("result") != Some(&Value::Bool(true)) {
            log::warn!(target: "gif", "gif search: KLIPY answered without a result");
            return Err(GifError::ProviderUnavailable);
        }
        match body
            .remove("data")
            .and_then(|mut data| data.get_mut("data").map(Value::take))
        {
            Some(Value::Array(items)) => Ok(items),
            _ => Err(malformed()),
        }
    }
}

/// A KLIPY API URL for `key`: see [`Klipy::api_url`].
pub(crate) fn api_url(key: &Secret, path: &[&str], pairs: &[(&str, &str)]) -> url::Url {
    let mut url: url::Url = API.parse().expect("the KLIPY API URL");
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.push(key.expose());
        segments.extend(path);
    }
    if !pairs.is_empty() {
        let mut query = url.query_pairs_mut();
        for (name, value) in pairs {
            query.append_pair(name, value);
        }
    }
    url
}

/// Whether `url` holds `key`, as it is or escaped as [`api_url`] escapes it.
fn holds_key(url: &str, key: &Secret) -> bool {
    let escaped = api_url(key, &[], &[]);
    let escaped = url::Url::path_segments(&escaped).and_then(|mut s| s.nth(2));
    let escaped = escaped.unwrap_or("");
    url.contains(key.expose()) || (escaped != "" && url.contains(escaped))
}

fn malformed() -> GifError {
    log::warn!(target: "gif", "gif search: KLIPY's response was not the expected JSON");
    GifError::ProviderUnavailable
}

/// KLIPY's `content_filter` for a rating. `off` is never sent: no rating maps to it.
pub(crate) fn content_filter(rating: Rating) -> &'static str {
    match rating {
        Rating::G => "high",
        Rating::Pg => "medium",
        Rating::Pg13 => "low",
    }
}

impl GifProvider for Klipy {
    fn search_gifs<'a>(
        &'a self,
        query: &'a str,
        rating: Rating,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move {
            let per_page = limit.max(MIN_PER_PAGE).to_string();
            let mut pairs = vec![
                ("q", query),
                ("per_page", per_page.as_str()),
                ("page", "1"),
                ("content_filter", content_filter(rating)),
            ];
            if let Some(customer_id) = &self.customer_id {
                pairs.push(("customer_id", customer_id.as_str()));
            }
            let url = self.api_url(&["gifs", "search"], &pairs);
            let items = self.api_data(url).await?;
            let candidates = items.iter().filter_map(|item| found(item, &self.key));
            Ok(candidates.take(limit).collect())
        })
    }

    fn lookup_gifs<'a>(
        &'a self,
        ids: &'a [String],
        _: Rating,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move {
            let joined = ids.join(",");
            let url = self.api_url(&["gifs", "items"], &[("slugs", joined.as_str())]);
            let items = self.api_data(url).await?;
            let mut by_slug: HashMap<String, Found> = items
                .iter()
                .filter_map(|item| found(item, &self.key))
                .map(|f| (f.candidate.id.clone(), f))
                .collect();
            Ok(ids.iter().filter_map(|id| by_slug.remove(id)).collect())
        })
    }
}

/// One KLIPY result as a candidate, or `None` for an ad, a missing or invalid slug, no
/// qualifying rendition, a URL off KLIPY's media hosts or a URL that holds `key`.
fn found(item: &Value, key: &Secret) -> Option<Found> {
    if item.get("type").and_then(Value::as_str) == Some("ad") {
        return None;
    }
    let slug = item.get("slug")?.as_str()?;
    let title = item.get("title").and_then(Value::as_str).unwrap_or("");
    let file = item.get("file")?.as_object()?;
    let candidate = super::candidate(Provider::Klipy, slug, title, &renditions(file))?;
    if holds_key(&candidate.url, key) || holds_key(&candidate.preview_url, key) {
        return None;
    }
    Some(Found {
        candidate,
        pingbacks: None,
    })
}

/// Every GIF, WebP and JPEG rendition under `file.{hd,md,sm,xs}`, named like `hd.gif`. mp4 and
/// webm are never candidates, so they are not read.
fn renditions(file: &serde_json::Map<String, Value>) -> Vec<Rendition> {
    let mut renditions = Vec::new();
    for size in SIZES {
        let Some(formats) = file.get(size) else {
            continue;
        };
        for format in FORMATS {
            let Some(image) = formats.get(format) else {
                continue;
            };
            let Some(url) = image.get("url").and_then(Value::as_str) else {
                continue;
            };
            let number = |field: &str| image.get(field).and_then(Value::as_u64);
            let side = |field: &str| number(field).and_then(|n| u32::try_from(n).ok());
            renditions.push(Rendition {
                name: format!("{size}.{format}"),
                url: url.to_string(),
                format: super::Format::of_url(url),
                still: format == "jpg",
                width: side("width"),
                height: side("height"),
                bytes: number("size"),
            });
        }
    }
    renditions
}
