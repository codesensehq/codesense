// SPDX-License-Identifier: MIT
//! GIF picker stills: a provider's preview image, fetched in the host and handed back as a
//! `data:` URI in the search result. The bytes live only in that result: never in the memory
//! store, the disk cache, the sha index or the purge set, so the frame CSP and `/media/v1`
//! stay as they are.
use super::{
    failure, hardened_client_builder, inspect, on_hosts, public_url, Failure, MediaProvider,
};
use base64::Engine as _;
use futures_util::future::BoxFuture;
use std::time::Duration;

/// The largest still read. [`read`] enforces it while streaming, the one place it is checked.
pub(crate) const MAX_BYTES: usize = 256 * 1024;
/// The most stills one search fetches: the search `limit` cap. The search already clamps its
/// `limit` to this; [`previews`] bounds its own fetches too, on purpose, so no caller's URL list
/// can make it fetch more.
pub(crate) const MAX_STILLS: usize = crate::gif::MAX_LIMIT;
/// One search's stills share this deadline, fetched concurrently.
pub(crate) const DEADLINE: Duration = Duration::from_secs(3);
const MAX_REDIRECTS: usize = 3;

/// Fetches one still's bytes, at most [`MAX_BYTES`]: the fetcher holds the cap, since it has to
/// stop reading past it. Tests stand in a counting fake.
pub(crate) trait PreviewFetch: Send + Sync {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, Failure>>;
}

/// The still client, before `https_only`: rustls, no referrer, no proxy, public addresses only,
/// and a redirect policy that requires https, a public address and, on every hop, a host of the
/// provider the first URL named. It never follows the team's media hosts.
pub(crate) fn client_builder() -> reqwest::ClientBuilder {
    hardened_client_builder(DEADLINE)
        .user_agent("ImageFetcher/1.0")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let hosts = attempt
                .previous()
                .first()
                .and_then(|first| first.host_str())
                .map_or(MediaProvider::None, MediaProvider::of_host)
                .host_list();
            if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error("redirect limit")
            } else if !public_url(attempt.url()) || !on_hosts(hosts, attempt.url().as_str()) {
                attempt.error("redirect host")
            } else {
                attempt.follow()
            }
        }))
}

/// Stills over HTTPS from the provider hosts.
pub(crate) struct Http(reqwest::Client);
impl Http {
    pub(crate) fn new() -> Result<Self, String> {
        client_builder()
            .https_only(true)
            .build()
            .map(Self)
            .map_err(|e| format!("preview client: {e}"))
    }
}
impl PreviewFetch for Http {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, Failure>> {
        Box::pin(read(&self.0, url))
    }
}

/// `url`'s body through `client`, capped at [`MAX_BYTES`].
pub(crate) async fn read(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, Failure> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(super::request_failure)?;
    Ok(super::read_capped(response, MAX_BYTES).await?.bytes)
}

/// One still as `data:<mime>;base64,…`. A URL off `hosts`, not https, or naming a private
/// address is refused before any request; the bytes must be an image `inspect` accepts.
pub(crate) async fn preview(
    fetch: &dyn PreviewFetch,
    hosts: &[&str],
    url: &str,
) -> Result<String, Failure> {
    if !on_hosts(hosts, url) {
        return Err(failure("host"));
    }
    let parsed = super::remote_url(url)?;
    if !public_url(&parsed) {
        return Err(failure("address"));
    }
    let bytes = fetch.get(url).await?;
    let (mime, _, _) = inspect(&bytes)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// The first [`MAX_STILLS`] of `urls` as `data:` URIs, in order, fetched concurrently under one
/// `deadline`. A still that fails or misses the deadline is `None`, not an error.
pub(crate) async fn previews(
    fetch: &dyn PreviewFetch,
    hosts: &[&str],
    urls: &[&str],
    deadline: Duration,
) -> Vec<Option<String>> {
    let until = tokio::time::Instant::now() + deadline;
    let stills = urls.iter().take(MAX_STILLS).map(|url| async move {
        match tokio::time::timeout_at(until, preview(fetch, hosts, url)).await {
            Ok(Ok(data)) => Some(data),
            Ok(Err(failure)) => {
                log::debug!(target: "gif", "gif preview skipped: {}", failure.reason);
                None
            }
            Err(_) => None,
        }
    });
    let mut out = futures_util::future::join_all(stills).await;
    out.resize(urls.len(), None);
    out
}
