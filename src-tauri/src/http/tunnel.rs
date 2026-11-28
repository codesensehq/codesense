// SPDX-License-Identifier: MIT
//! The API listener's connections: HTTP/1.1 only, served by the API router.
//!
//! The web views reach `localhost` names through a CONNECT proxy pointing at
//! this listener (macOS 14+, `codesense_platform::webview_proxy`). A CONNECT
//! to `localhost` or `f-<id>.localhost` at the API port opens a tunnel whose
//! stream is served by the same router, behind the same frame boundary, with
//! its requests untouched. Absolute-form requests, which a plain HTTP proxy
//! client sends, are served as their origin form.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;

/// Serve `router` on every connection `listener` accepts, until the process ends.
/// Only a failure to read the listener's own address returns.
pub async fn serve_api(listener: TcpListener, router: Router) -> std::io::Result<()> {
    let api = Api::new(router, listener.local_addr()?.port());
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let api = api.clone();
                tokio::spawn(async move { api.serve_connection(stream).await });
            }
            // Out of descriptors or a connection reset before accept: wait a little
            // rather than spin, and keep listening.
            Err(e) => {
                log::warn!(target: "http", "Accept failed: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Whether a CONNECT authority is opened as a tunnel into the router.
fn tunnels(authority: &str, api_port: u16) -> bool {
    let authority = authority.to_ascii_lowercase();
    let Some(host) = authority.strip_suffix(&format!(":{api_port}")) else {
        return false;
    };
    host == "localhost"
        || host.strip_suffix(".localhost").is_some_and(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// What every connection of one listener shares.
#[derive(Clone)]
struct Api {
    router: Router,
    port: u16,
}

impl Api {
    fn new(router: Router, port: u16) -> Self {
        Self { router, port }
    }

    /// One client connection.
    async fn serve_connection<I>(self, io: I)
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_http(io, false).await
    }

    /// HTTP/1.1 on `io`, a client connection or, `in_tunnel`, a tunnel's
    /// stream, where CONNECT is refused.
    async fn serve_http<I>(self, io: I, in_tunnel: bool)
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let service = service_fn(move |request: Request<Incoming>| {
            let api = self.clone();
            async move {
                Ok::<_, Infallible>(if request.method() != Method::CONNECT {
                    api.route(request).await
                } else if in_tunnel {
                    refuse(StatusCode::METHOD_NOT_ALLOWED)
                } else {
                    api.connect(request)
                })
            }
        });
        if let Err(e) = http1::Builder::new()
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades()
            .await
        {
            log::debug!(target: "http", "Connection ended: {}", e);
        }
    }

    /// A CONNECT. Accepted ones answer 200 and serve the stream that follows.
    fn connect(&self, request: Request<Incoming>) -> Response<Body> {
        let uri = request.uri();
        let authority = match (uri.scheme(), uri.authority(), uri.path_and_query()) {
            (None, Some(authority), None) => authority.as_str(),
            _ => return refuse(StatusCode::BAD_REQUEST),
        };
        if !tunnels(authority, self.port) {
            return refuse(StatusCode::FORBIDDEN);
        }
        let api = self.clone();
        tokio::spawn(async move {
            // The upgraded stream starts with any bytes the client sent after
            // the CONNECT head, so they reach the tunnel, not this connection.
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => api.serve_http(TokioIo::new(upgraded), true).await,
                Err(e) => log::debug!(target: "http", "Tunnel not opened: {}", e),
            }
        });
        Response::new(Body::empty())
    }

    /// A request for the router, in origin form.
    async fn route(&self, request: Request<Incoming>) -> Response<Body> {
        let request = match origin_form(request) {
            Ok(request) => request,
            Err(status) => return refuse(status),
        };
        let router = TowerToHyperService::new(self.router.clone());
        match hyper::service::Service::call(&router, request).await {
            Ok(response) => response,
            Err(never) => match never {},
        }
    }
}

/// `request` with an absolute-form target (`GET http://host/path`) rewritten
/// to its origin form. The authority must be the request's one Host, so the
/// boundary checks the host that was asked for.
fn origin_form<B>(mut request: Request<B>) -> Result<Request<B>, StatusCode> {
    let Some(authority) = request.uri().authority().cloned() else {
        return Ok(request);
    };
    if request.uri().scheme_str() != Some("http") || authority.as_str().contains('@') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut hosts = request.headers().get_all(header::HOST).iter();
    match (hosts.next(), hosts.next()) {
        (Some(host), None)
            if host
                .as_bytes()
                .eq_ignore_ascii_case(authority.as_str().as_bytes()) => {}
        _ => return Err(StatusCode::BAD_REQUEST),
    }
    let target = request
        .uri()
        .path_and_query()
        .map_or("/", |target| target.as_str())
        .parse()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    *request.uri_mut() = target;
    Ok(request)
}

/// An error answer that closes the connection.
fn refuse(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard_stream::frame::{FrameGrant, FramePolicy, FrameStore};
    use crate::http::app_origins::AppOrigins;
    use crate::http::frame_boundary::{with_boundary, FrameBoundary};
    use axum::http::{HeaderMap, Uri};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    const PORT: u16 = 4999;

    /// The API, as served: a route that echoes its target and headers, behind
    /// the frame boundary, with one frame minted. Returns the frame's Host and
    /// token.
    fn api() -> (Api, String, String) {
        let frames = Arc::new(FrameStore::default());
        let frame = frames.mint(
            PORT,
            FrameGrant {
                frame_id: String::new(),
                principal: "human".into(),
                dashboard: "board".into(),
                slot: "centre".into(),
                team: None,
                scope: "open".into(),
            },
            String::new(),
            String::new(),
            String::new(),
            FramePolicy::default(),
            None,
        );
        let router = Router::new().route(
            "/echo",
            axum::routing::get(|uri: Uri, headers: HeaderMap| async move {
                let mut echo = format!("{uri}\n");
                for (name, value) in &headers {
                    echo += &format!("{name}: {}\n", value.to_str().unwrap());
                }
                echo
            }),
        );
        let router = with_boundary(
            router,
            FrameBoundary {
                frames,
                port: PORT,
                app_origins: AppOrigins::default(),
            },
        );
        let host = frame.origin.trim_start_matches("http://").to_owned();
        (Api::new(router, PORT), host, frame.token)
    }

    /// A client connection to `api`.
    fn connect(api: Api) -> DuplexStream {
        let (client, server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(api.serve_connection(server));
        client
    }

    /// Sends `bytes` and reads until the server closes.
    async fn exchange(api: Api, bytes: &str) -> String {
        let mut client = connect(api);
        client.write_all(bytes.as_bytes()).await.unwrap();
        let mut read = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut read))
            .await
            .expect("the server closes")
            .unwrap();
        String::from_utf8(read).unwrap()
    }

    /// Reads one response head, and nothing after it.
    async fn read_head(client: &mut DuplexStream) -> String {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(client.read_u8().await.unwrap());
        }
        String::from_utf8(head).unwrap()
    }

    /// The status codes of every response in `read`, in order.
    fn statuses(read: &str) -> Vec<u16> {
        read.match_indices("HTTP/1.1 ")
            .map(|(at, _)| read[at + 9..at + 12].parse().unwrap())
            .collect()
    }

    fn echo_request(target: &str, host: &str, token: &str) -> String {
        format!(
            "GET {target} HTTP/1.1\r\nhost: {host}\r\nx-codesense-proxy-token: {token}\r\n\
             connection: close\r\n\r\n"
        )
    }

    fn connect_head(authority: &str) -> String {
        format!("CONNECT {authority} HTTP/1.1\r\nhost: {authority}\r\n\r\n")
    }

    #[tokio::test]
    async fn a_connect_to_the_api_port_tunnels_into_the_router_untouched() {
        let (api, host, token) = api();
        let inner = echo_request("/echo", &host, &token);
        let read = exchange(api, &(connect_head(&format!("localhost:{PORT}")) + &inner)).await;
        assert_eq!(statuses(&read), [200, 200], "{read}");
        let body = &read[read.find("\r\n\r\n/echo").unwrap() + 4..];
        assert_eq!(
            body,
            format!("/echo\nhost: {host}\nx-codesense-proxy-token: {token}\nconnection: close\n")
        );
    }

    #[tokio::test]
    async fn a_frame_host_connect_tunnels_too() {
        let (api, host, token) = api();
        let inner = echo_request("/echo", &host, &token);
        let read = exchange(api, &(connect_head(&host) + &inner)).await;
        assert_eq!(statuses(&read), [200, 200], "{read}");
    }

    #[tokio::test]
    async fn the_boundary_still_refuses_a_bad_host_inside_the_tunnel() {
        let (api, _, token) = api();
        let inner = echo_request("/echo", &format!("evil.test:{PORT}"), &token);
        let read = exchange(api, &(connect_head(&format!("localhost:{PORT}")) + &inner)).await;
        assert_eq!(statuses(&read), [200, 403], "{read}");
    }

    #[tokio::test]
    async fn bytes_after_the_connect_head_are_the_tunnel_s_first_request() {
        // Sent before the 200. Had this connection parsed them, the second
        // CONNECT would have opened a tunnel; the tunnel refuses it.
        let (api, _, _) = api();
        let authority = format!("localhost:{PORT}");
        let read = exchange(api, &(connect_head(&authority) + &connect_head(&authority))).await;
        assert_eq!(statuses(&read), [200, 405], "{read}");
    }

    #[tokio::test]
    async fn a_nested_connect_is_refused() {
        let (api, _, _) = api();
        let mut client = connect(api);
        let authority = format!("localhost:{PORT}");
        client
            .write_all(connect_head(&authority).as_bytes())
            .await
            .unwrap();
        assert_eq!(statuses(&read_head(&mut client).await), [200]);
        client
            .write_all(connect_head(&authority).as_bytes())
            .await
            .unwrap();
        let mut read = String::new();
        client.read_to_string(&mut read).await.unwrap();
        assert_eq!(statuses(&read), [405], "{read}");
        assert!(read.contains("connection: close\r\n"), "{read}");
    }

    #[tokio::test]
    async fn an_absolute_form_request_reaches_the_route_in_origin_form() {
        let (api, host, token) = api();
        let read = exchange(
            api,
            &echo_request(&format!("http://{host}/echo?q=1"), &host, &token),
        )
        .await;
        assert_eq!(statuses(&read), [200], "{read}");
        assert!(
            read.contains(&format!("\r\n\r\n/echo?q=1\nhost: {host}\n")),
            "{read}"
        );
    }

    #[tokio::test]
    async fn an_absolute_form_authority_must_be_the_host() {
        let (api, host, token) = api();
        let other = format!("f-other.localhost:{PORT}");
        for (target, host) in [
            (format!("http://{other}/echo"), host.clone()),
            (format!("http://{host}/echo"), other.clone()),
            (format!("https://{host}/echo"), host.clone()),
            (format!("http://u@{host}/echo"), host.clone()),
        ] {
            let read = exchange(api.clone(), &echo_request(&target, &host, &token)).await;
            assert_eq!(statuses(&read), [400], "{target} {host}: {read}");
        }
        let twice = format!(
            "GET http://{host}/echo HTTP/1.1\r\nhost: {host}\r\nhost: {host}\r\n\
             connection: close\r\n\r\n"
        );
        assert_eq!(statuses(&exchange(api, &twice).await), [400]);
    }

    #[tokio::test]
    async fn plain_requests_still_reach_the_router() {
        let (api, host, token) = api();
        let read = exchange(api, &echo_request("/echo", &host, &token)).await;
        assert_eq!(statuses(&read), [200], "{read}");
    }

    #[tokio::test]
    async fn an_http2_preface_gets_no_answer() {
        let (api, _, _) = api();
        let read = exchange(api, "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").await;
        assert_eq!(read, "");
    }

    #[tokio::test]
    async fn a_connect_elsewhere_is_refused_and_closed() {
        let (api, _, _) = api();
        let read = exchange(api, &connect_head(&format!("example.com:{PORT}"))).await;
        assert_eq!(statuses(&read), [403], "{read}");
        assert!(read.contains("connection: close\r\n"), "{read}");
    }
}
