// SPDX-License-Identifier: MIT
//! The provider transport both adapters and registration share: https only, no redirects, at
//! most [`MAX_BODY`] read, and a failure that keeps only its kind. Also [`classify`], which maps
//! a provider's answer to the typed error.
use super::{GifError, Provider};
use futures_util::future::BoxFuture;
use std::time::Duration;

/// The largest API response read: a page of results is well under this.
pub(crate) const MAX_BODY: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const USER_AGENT: &str = "CodeSense-GifSearch/1.0";

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

/// Gets or posts to an API URL. Production is [`Http`]; tests stand in recorded replies.
pub(crate) trait Transport: Send + Sync {
    fn get<'a>(&'a self, url: &'a url::Url) -> BoxFuture<'a, Result<Reply, Failure>>;
    /// POST `body` as JSON. A transport that can't post fails every one as [`Failure::Network`].
    fn post_json<'a>(
        &'a self,
        url: &'a url::Url,
        body: &'a serde_json::Value,
    ) -> BoxFuture<'a, Result<Reply, Failure>> {
        let _ = (url, body);
        Box::pin(async { Err(Failure::Network) })
    }
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

    /// Send `request` and read its reply, at most [`MAX_BODY`] of it.
    async fn send(request: reqwest::RequestBuilder) -> Result<Reply, Failure> {
        let request = request.header(reqwest::header::ACCEPT, "application/json");
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
        Box::pin(Self::send(self.client.get(url.clone())))
    }
    fn post_json<'a>(
        &'a self,
        url: &'a url::Url,
        body: &'a serde_json::Value,
    ) -> BoxFuture<'a, Result<Reply, Failure>> {
        Box::pin(async move {
            let Ok(bytes) = serde_json::to_vec(body) else {
                return Err(Failure::Network);
            };
            let request = self
                .client
                .post(url.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes);
            Self::send(request).await
        })
    }
}

/// The text a provider's other 4xx carries, as [`GifError::BadQuery`] needs it.
fn refused(provider: Provider) -> &'static str {
    match provider {
        Provider::Giphy => "GIPHY refused the request",
        Provider::Klipy => "KLIPY refused the request",
    }
}

/// A provider's answer as its body or the typed error: 401 and 403 are `InvalidKey`, 429 is
/// `RateLimited` (its `Retry-After` dated by `now_ms`), any other 4xx is `BadQuery`, and a 5xx
/// or a failure is `ProviderUnavailable`. Log lines name the provider and the status or the
/// failure, never the URL, which holds the key.
pub(crate) fn classify(
    provider: Provider,
    reply: Result<Reply, Failure>,
    now_ms: i64,
) -> Result<Vec<u8>, GifError> {
    let name = Provider::display_name(provider);
    let reply = match reply {
        Ok(reply) => reply,
        Err(failure) => {
            log::warn!(target: "gif", "gif search: the {name} request failed ({failure:?})");
            return Err(GifError::ProviderUnavailable);
        }
    };
    match reply.status {
        200..=299 => Ok(reply.body),
        401 | 403 => {
            log::warn!(target: "gif", "gif search: {name} refused the key (HTTP {})", reply.status);
            Err(GifError::InvalidKey)
        }
        429 => {
            let retry_after = super::bucket::retry_after_secs(reply.retry_after.as_deref(), now_ms);
            log::warn!(target: "gif", "gif search: {name} rate limited searches for {retry_after} s");
            Err(GifError::RateLimited { retry_after })
        }
        status @ 400..=499 => {
            log::warn!(target: "gif", "gif search: {name} refused the request (HTTP {status})");
            Err(GifError::BadQuery(refused(provider)))
        }
        status => {
            log::warn!(target: "gif", "gif search: {name} answered HTTP {status}");
            Err(GifError::ProviderUnavailable)
        }
    }
}
