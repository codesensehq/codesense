// SPDX-License-Identifier: MIT
//! The API listener's connections: HTTP/1.1 only, served by the API router.
//!
//! The web views reach `localhost` names through a CONNECT proxy pointing at
//! this listener (macOS 14+, `codesense_platform::webview_proxy`). A CONNECT
//! to `localhost` or `f-<id>.localhost` at the API port opens a tunnel whose
//! stream is served by the same router, behind the same frame boundary, with
//! its requests untouched. A CONNECT to a `localhost` name at another port is
//! spliced to that loopback port; [`verdict`] refuses every other authority.
//! Absolute-form requests, which a plain HTTP proxy client sends, are served
//! as their origin form.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::{Instant, Sleep};

/// Open tunnels and splices, together, per listener. The next CONNECT gets 503.
const MAX_TUNNELS: usize = 256;
/// How long a client has to send a whole request head, outside a tunnel.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// A tunnel or splice with no bytes either way for this long is closed.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Serve `router` on every connection `listener` accepts, until the process ends.
/// Only a failure to read the listener's own address returns.
pub async fn serve_api(listener: TcpListener, router: Router) -> io::Result<()> {
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

/// What a CONNECT to an authority gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// A `localhost` name at the API port: served by the router.
    Tunnel,
    /// A `localhost` name at another port: spliced to that loopback port.
    Splice(u16),
    /// Any other host: 403.
    Forbidden,
    /// Not a `host:port` authority: 400.
    BadRequest,
}

/// The verdict for a CONNECT `authority`. Only `localhost` and single-label
/// `<label>.localhost` names pass, in any case. IP literals and a trailing dot
/// do not.
fn verdict(authority: &str, api_port: u16) -> Verdict {
    if authority.is_empty()
        || authority.bytes().any(|b| {
            b.is_ascii_whitespace()
                || b.is_ascii_control()
                || matches!(b, b'%' | b'@' | b'/' | b'?' | b'#' | b'\\')
        })
    {
        return Verdict::BadRequest;
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return Verdict::BadRequest;
    };
    let port = match port {
        digits if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            digits.parse::<u16>().ok().filter(|&port| port != 0)
        }
        _ => None,
    };
    let Some(port) = port else {
        return Verdict::BadRequest;
    };
    if host.is_empty() {
        return Verdict::BadRequest;
    }
    let host = host.to_ascii_lowercase();
    let localhost = host == "localhost"
        || host.strip_suffix(".localhost").is_some_and(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    match (localhost, port == api_port) {
        (false, _) => Verdict::Forbidden,
        (true, true) => Verdict::Tunnel,
        (true, false) => Verdict::Splice(port),
    }
}

/// What every connection of one listener shares.
#[derive(Clone)]
struct Api {
    router: Router,
    port: u16,
    tunnels: Arc<Semaphore>,
}

impl Api {
    fn new(router: Router, port: u16) -> Self {
        Self {
            router,
            port,
            tunnels: Arc::new(Semaphore::new(MAX_TUNNELS)),
        }
    }

    /// One client connection.
    async fn serve_connection<I>(self, io: I)
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_http(io, false).await
    }

    /// HTTP/1.1 on `io`, a client connection or, `in_tunnel`, a tunnel's
    /// stream, where CONNECT is refused. Request heads time out only outside
    /// a tunnel; a tunnel's stream has its own idle timeout.
    async fn serve_http<I>(self, io: I, in_tunnel: bool)
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let mut builder = http1::Builder::new();
        if in_tunnel {
            builder.header_read_timeout(None);
        } else {
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(HEAD_TIMEOUT);
        }
        let service = service_fn(move |request: Request<Incoming>| {
            let api = self.clone();
            async move {
                Ok::<_, Infallible>(if request.method() != Method::CONNECT {
                    api.route(request).await
                } else if in_tunnel {
                    refuse(StatusCode::METHOD_NOT_ALLOWED)
                } else {
                    api.connect(request).await
                })
            }
        });
        if let Err(e) = builder
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades()
            .await
        {
            log::debug!(target: "http", "Connection ended: {}", e);
        }
    }

    /// A tunnel's stream, boxed: serving a stream can open a tunnel, which serves one.
    fn serve_tunnel<I>(self, io: I) -> Pin<Box<dyn Future<Output = ()> + Send>>
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        Box::pin(self.serve_http(io, true))
    }

    /// A CONNECT, with one `tunnel` log line naming its authority and outcome.
    async fn connect(&self, request: Request<Incoming>) -> Response<Body> {
        let uri = request.uri();
        let authority = match (uri.scheme(), uri.authority(), uri.path_and_query()) {
            (None, Some(authority), None) => authority.as_str().to_owned(),
            _ => {
                log::debug!(target: "tunnel", "CONNECT not to an authority: 400");
                return refuse(StatusCode::BAD_REQUEST);
            }
        };
        let (response, outcome) = self.open(request, &authority).await;
        log::debug!(target: "tunnel", "CONNECT {authority:?}: {outcome}");
        response
    }

    /// Answers a CONNECT to `authority`. Accepted ones answer 200 and serve,
    /// or splice, the stream that follows.
    async fn open(&self, request: Request<Incoming>, authority: &str) -> (Response<Body>, String) {
        let splice = match verdict(authority, self.port) {
            Verdict::Tunnel => None,
            Verdict::Splice(port) => Some(port),
            Verdict::Forbidden => return (refuse(StatusCode::FORBIDDEN), "403".into()),
            Verdict::BadRequest => return (refuse(StatusCode::BAD_REQUEST), "400".into()),
        };
        let Ok(permit) = self.tunnels.clone().try_acquire_owned() else {
            return (
                refuse(StatusCode::SERVICE_UNAVAILABLE),
                format!("503, {MAX_TUNNELS} open"),
            );
        };
        let (target, outcome) = match splice {
            None => (None, "tunnelled".to_owned()),
            Some(port) => match dial(port).await {
                Ok(target) => (Some(target), format!("spliced to port {port}")),
                Err(e) => return (refuse(StatusCode::BAD_GATEWAY), format!("502, {e}")),
            },
        };
        let api = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            // The upgraded stream starts with any bytes the client sent after
            // the CONNECT head, so they reach the tunnel, not this connection.
            let client = match hyper::upgrade::on(request).await {
                Ok(upgraded) => Idle::new(TokioIo::new(upgraded), IDLE_TIMEOUT),
                Err(e) => {
                    log::debug!(target: "tunnel", "Not opened: {}", e);
                    return;
                }
            };
            match target {
                None => api.serve_tunnel(client).await,
                Some(mut target) => {
                    let mut client = client;
                    if let Err(e) = tokio::io::copy_bidirectional(&mut client, &mut target).await {
                        log::debug!(target: "tunnel", "Splice ended: {}", e);
                    }
                }
            }
        });
        (Response::new(Body::empty()), outcome)
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

/// Connects to a loopback `port`: `127.0.0.1`, then `[::1]` only when that is
/// refused (a dev server may listen on `::1` alone).
async fn dial(port: u16) -> io::Result<TcpStream> {
    match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {
            TcpStream::connect((Ipv6Addr::LOCALHOST, port)).await
        }
        dialled => dialled,
    }
}

/// A stream that fails with `TimedOut` once no byte has moved either way for
/// `limit`. Any read or write that moves bytes restarts the clock.
struct Idle<T> {
    io: T,
    limit: Duration,
    timer: Pin<Box<Sleep>>,
}

impl<T> Idle<T> {
    fn new(io: T, limit: Duration) -> Self {
        Self {
            io,
            limit,
            timer: Box::pin(tokio::time::sleep(limit)),
        }
    }

    fn moved(&mut self) {
        let deadline = Instant::now() + self.limit;
        self.timer.as_mut().reset(deadline);
    }

    /// What a pending read or write becomes: still pending, or timed out.
    fn pending<R>(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<R>> {
        match self.timer.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err(io::ErrorKind::TimedOut.into())),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for Idle<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        match Pin::new(&mut this.io).poll_read(cx, buf) {
            Poll::Pending => this.pending(cx),
            Poll::Ready(Ok(())) if buf.filled().len() > before => {
                this.moved();
                Poll::Ready(Ok(()))
            }
            ready => ready,
        }
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Idle<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.io).poll_write(cx, buf) {
            Poll::Pending => this.pending(cx),
            Poll::Ready(Ok(written)) => {
                if written > 0 {
                    this.moved();
                }
                Poll::Ready(Ok(written))
            }
            ready => ready,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.io).poll_flush(cx) {
            Poll::Pending => this.pending(cx),
            ready => ready,
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_shutdown(cx)
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

    #[test]
    fn each_authority_gets_one_verdict() {
        use Verdict::*;
        let long = "a".repeat(63);
        let too_long = "a".repeat(64);
        let rows = [
            // Tunnelled into the router.
            ("localhost:4999".to_owned(), Tunnel),
            ("LocalHost:4999".into(), Tunnel),
            ("f-abc123.localhost:4999".into(), Tunnel),
            ("F-ABC123.LOCALHOST:4999".into(), Tunnel),
            // Spliced to that loopback port.
            ("localhost:1420".into(), Splice(1420)),
            ("vite.Localhost:5173".into(), Splice(5173)),
            (format!("{long}.localhost:1"), Splice(1)),
            ("localhost:65535".into(), Splice(65535)),
            // Refused.
            ("localhost.:4999".into(), Forbidden),
            ("f-x.localhost.evil.test:4999".into(), Forbidden),
            ("127.0.0.1:4999".into(), Forbidden),
            ("[::1]:4999".into(), Forbidden),
            ("203.0.113.7:4999".into(), Forbidden),
            ("example.com:4999".into(), Forbidden),
            ("a.b.localhost:4999".into(), Forbidden),
            (".localhost:4999".into(), Forbidden),
            ("f_x.localhost:4999".into(), Forbidden),
            (format!("{too_long}.localhost:4999"), Forbidden),
            ("localhostx:4999".into(), Forbidden),
            // Not a host:port authority.
            ("u@localhost:4999".into(), BadRequest),
            ("localhost".into(), BadRequest),
            ("[::1]".into(), BadRequest),
            ("localhost:".into(), BadRequest),
            ("localhost:0".into(), BadRequest),
            ("localhost:65536".into(), BadRequest),
            ("localhost:99999999999".into(), BadRequest),
            ("localhost:80a".into(), BadRequest),
            ("localhost:+80".into(), BadRequest),
            ("".into(), BadRequest),
            (":4999".into(), BadRequest),
            ("local%68ost:4999".into(), BadRequest),
            ("localhost :4999".into(), BadRequest),
            (" localhost:4999".into(), BadRequest),
            ("localhost:4999\t".into(), BadRequest),
            ("localhost:4999/x".into(), BadRequest),
        ];
        for (authority, expected) in rows {
            assert_eq!(verdict(&authority, PORT), expected, "{authority:?}");
        }
    }

    /// Reads to the end, failing after 5 s.
    async fn read_to_end(client: &mut DuplexStream) -> String {
        let mut read = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut read))
            .await
            .expect("the server closes")
            .unwrap();
        String::from_utf8(read).unwrap()
    }

    #[tokio::test]
    async fn another_localhost_port_is_spliced_byte_for_byte() {
        let (api, _, _) = api();
        let target = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = target.local_addr().unwrap().port();
        let early = "GET /@vite/client HTTP/1.1\r\nhost: anything\r\n\r\n";
        let mut client = connect(api);
        client
            .write_all((connect_head(&format!("Localhost:{port}")) + early).as_bytes())
            .await
            .unwrap();
        let (mut peer, _) = target.accept().await.unwrap();
        let mut received = vec![0; early.len()];
        peer.read_exact(&mut received).await.unwrap();
        assert_eq!(received, early.as_bytes());
        assert_eq!(statuses(&read_head(&mut client).await), [200]);
        peer.write_all(b"pong").await.unwrap();
        drop(peer);
        assert_eq!(read_to_end(&mut client).await, "pong");
    }

    #[tokio::test]
    async fn a_splice_tries_ipv6_loopback_only_when_ipv4_refuses() {
        // Skipped where the host has no IPv6 loopback.
        let Ok(target) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await else {
            return;
        };
        let port = target.local_addr().unwrap().port();
        let (api, _, _) = api();
        let mut client = connect(api);
        client
            .write_all(connect_head(&format!("localhost:{port}")).as_bytes())
            .await
            .unwrap();
        let (mut peer, _) = target.accept().await.unwrap();
        assert_eq!(statuses(&read_head(&mut client).await), [200]);
        peer.write_all(b"v6").await.unwrap();
        drop(peer);
        assert_eq!(read_to_end(&mut client).await, "v6");
    }

    #[tokio::test]
    async fn a_splice_nobody_listens_on_gets_502() {
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let (api, _, _) = api();
        let read = exchange(api, &connect_head(&format!("localhost:{port}"))).await;
        assert_eq!(statuses(&read), [502], "{read}");
        assert!(read.contains("connection: close\r\n"), "{read}");
    }

    #[tokio::test]
    async fn the_connect_after_the_cap_gets_503_until_a_tunnel_closes() {
        let (api, _, _) = api();
        let authority = format!("localhost:{PORT}");
        let mut open = Vec::new();
        for _ in 0..MAX_TUNNELS {
            let mut client = connect(api.clone());
            client
                .write_all(connect_head(&authority).as_bytes())
                .await
                .unwrap();
            assert_eq!(statuses(&read_head(&mut client).await), [200]);
            open.push(client);
        }
        let read = exchange(api.clone(), &connect_head(&authority)).await;
        assert_eq!(statuses(&read), [503], "{read}");
        assert!(read.contains("connection: close\r\n"), "{read}");

        drop(open.pop());
        for _ in 0..500 {
            let mut client = connect(api.clone());
            client
                .write_all(connect_head(&authority).as_bytes())
                .await
                .unwrap();
            if statuses(&read_head(&mut client).await) == [200] {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the closed tunnel's slot was never freed");
    }

    #[tokio::test(start_paused = true)]
    async fn an_unfinished_request_head_is_dropped_after_10_s() {
        let (api, _, _) = api();
        let mut client = connect(api);
        client
            .write_all(format!("CONNECT localhost:{PORT} HTTP/1.1\r\n").as_bytes())
            .await
            .unwrap();
        let start = Instant::now();
        let mut read = Vec::new();
        let early = HEAD_TIMEOUT - Duration::from_millis(100);
        assert!(
            tokio::time::timeout(early, client.read_to_end(&mut read))
                .await
                .is_err(),
            "still open before the head timeout"
        );
        client.read_to_end(&mut read).await.unwrap();
        assert!(read.is_empty(), "{read:?}");
        assert!(start.elapsed() >= HEAD_TIMEOUT, "{:?}", start.elapsed());
        assert!(start.elapsed() < HEAD_TIMEOUT + Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_tunnel_closes_after_300_s() {
        let (api, _, _) = api();
        let mut client = connect(api);
        client
            .write_all(connect_head(&format!("localhost:{PORT}")).as_bytes())
            .await
            .unwrap();
        assert_eq!(statuses(&read_head(&mut client).await), [200]);
        let start = Instant::now();
        let mut read = Vec::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(299), client.read_to_end(&mut read))
                .await
                .is_err(),
            "still open at 299 s"
        );
        client.read_to_end(&mut read).await.unwrap();
        assert!(read.is_empty(), "{read:?}");
        assert!(start.elapsed() >= IDLE_TIMEOUT, "{:?}", start.elapsed());
        assert!(start.elapsed() < IDLE_TIMEOUT + Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn bytes_either_way_keep_an_idle_stream_open() {
        let limit = Duration::from_secs(10);
        let (io, mut peer) = tokio::io::duplex(64);
        let mut idle = Idle::new(io, limit);
        let mut byte = [0; 1];
        for _ in 0..5 {
            tokio::time::sleep(Duration::from_secs(6)).await;
            peer.write_all(b"r").await.unwrap();
            idle.read_exact(&mut byte).await.unwrap();
            tokio::time::sleep(Duration::from_secs(6)).await;
            idle.write_all(b"w").await.unwrap();
            peer.read_exact(&mut byte).await.unwrap();
        }
        let start = Instant::now();
        let error = idle.read(&mut byte).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() >= limit && start.elapsed() < limit + Duration::from_secs(1));
    }
}
