// SPDX-License-Identifier: MIT
use super::app_origins::AppOrigins;
use crate::dashboard_stream::frame::{AllowedHosts, FrameRecord, FrameStore};
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use std::sync::Arc;
use tauri::Manager;

#[derive(Clone)]
pub struct FrameBoundary {
    pub frames: Arc<FrameStore>,
    pub port: u16,
    pub app_origins: AppOrigins,
}

pub fn with_boundary<S: Clone + Send + Sync + 'static>(
    router: Router<S>,
    state: FrameBoundary,
) -> Router<S> {
    router.layer(middleware::from_fn_with_state(state, boundary))
}
pub fn presented_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-codesense-proxy-token")
        .and_then(|h| h.to_str().ok())
        .or_else(|| {
            headers
                .get(header::COOKIE)?
                .to_str()
                .ok()?
                .split(';')
                .find_map(|part| part.trim().strip_prefix("csframe="))
        })
}
pub fn request_frame<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    headers: &HeaderMap,
) -> Option<FrameRecord> {
    let port = app.try_state::<super::HttpApiPort>()?.0;
    app.state::<Arc<FrameStore>>()
        .by_host(headers.get(header::HOST)?.to_str().ok()?, port)
}

async fn boundary(
    State(state): State<FrameBoundary>,
    mut request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let frame = state.frames.by_host(host, state.port);
    let loopback = [
        format!("localhost:{}", state.port),
        format!("127.0.0.1:{}", state.port),
        format!("[::1]:{}", state.port),
    ]
    .contains(&host.to_string());
    if !loopback && frame.is_none() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if let Some(origin) = &origin {
        let child_navigation = request
            .headers()
            .get("sec-fetch-dest")
            .is_some_and(|d| d == "iframe")
            && frame
                .as_ref()
                .and_then(|f| f.parent_frame.as_ref())
                .and_then(|id| state.frames.by_id(id))
                .is_some_and(|parent| parent.origin == *origin);
        if !child_navigation
            && !state.app_origins.is_app_origin(origin)
            && (state.frames.by_origin(origin).is_none()
                || frame.as_ref().is_none_or(|f| f.origin != *origin))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let worker_script = request.headers().contains_key("service-worker")
        || request.headers().get("sec-fetch-dest").is_some_and(|dest| {
            dest == "worker" || dest == "sharedworker" || dest == "serviceworker"
        });
    let path = request.uri().path().to_string();
    let file_route = ["/viewer/", "/pane/", "/message/", "/viewer-baseline/"]
        .iter()
        .any(|p| path.starts_with(p));
    if file_route && frame.is_none() {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(frame) = &frame {
        let dest = request
            .headers()
            .get("sec-fetch-dest")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if file_route && dest == "document" && frame.grant.slot != "export" {
            return StatusCode::FORBIDDEN.into_response();
        }
        if frame.policy.blocks_service_workers() && request.headers().contains_key("service-worker")
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        // Initial embedded navigations receive a cookie for relative assets.
        // Every script/API request must carry that cookie or a capability.
        let asset = matches!(
            dest,
            "script"
                | "style"
                | "font"
                | "image"
                | "audio"
                | "video"
                | "track"
                | "worker"
                | "sharedworker"
                | "serviceworker"
        ) && request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|s| s == "same-origin");
        // Opaque baseline documents cannot use same-site cookies. Their own
        // relative resources are identified by the registered baseline host.
        let baseline_asset = frame.grant.slot == "baseline"
            && path.starts_with("/viewer-baseline/")
            && matches!(
                dest,
                "script" | "style" | "image" | "font" | "audio" | "video" | "track"
            );
        let bootstrap = asset
            || baseline_asset
            || file_route
                && (matches!(dest, "iframe" | "frame" | "image")
                    || origin
                        .as_deref()
                        .is_some_and(|origin| state.app_origins.is_app_origin(origin))
                    || frame.grant.slot == "export");
        if !bootstrap
            && !presented_token(request.headers()).is_some_and(|token| {
                FrameStore::resolve(&state.frames, &frame.origin, token).is_some()
            })
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        request.extensions_mut().insert(frame.clone());
    }
    if request.method() == axum::http::Method::OPTIONS && origin.is_some() {
        let mut response = StatusCode::NO_CONTENT.into_response();
        cors(&mut response, origin.as_deref());
        return response;
    }
    // Architecture: only static kit GETs retain their route's immutable cache header.
    // Origin, capability and CSP checks still apply to these requests.
    let cacheable_kit =
        request.method() == axum::http::Method::GET && request.uri().path().starts_with("/kit/");
    let mut response = next.run(request).await;
    cors(&mut response, origin.as_deref());
    if let Some(frame) = frame {
        if !cacheable_kit && !path.starts_with("/media/v1/") {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
        // The CSP below is chosen by the declared type, so no engine may sniff another one.
        response.headers_mut().insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        if let Ok(value) = HeaderValue::from_str(&format!(
            "csframe={}; Path=/; HttpOnly; SameSite=Strict",
            frame.token
        )) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        if worker_script || can_be_a_document(response.headers().get(header::CONTENT_TYPE)) {
            let mut csp = state.app_origins.frame_ancestors();
            if let Some(parent) = frame
                .parent_frame
                .as_ref()
                .and_then(|id| state.frames.by_id(id))
            {
                csp.push(' ');
                csp.push_str(&parent.origin);
            }
            // The frame's own exact origin beside 'self': WebKit matches 'self' to nothing in a
            // sandboxed (opaque-origin) document such as a baseline, so every engine gets the same policy.
            let own = format!("'self' {}", frame.origin);
            if frame.policy.no_outside_network {
                // A policy whose hosts are not all exact HTTPS origins opens none of them.
                let hosts = AllowedHosts::parse(&frame.policy.allowed_hosts)
                    .unwrap_or_default()
                    .0
                    .join(" ");
                // A slot frame may nest the message frames it embeds (`link_child`).
                if crate::verbs::capabilities::SLOTS.contains(&frame.grant.slot.as_str()) {
                    csp.push_str(&format!(
                        "; frame-src {own} http://*.localhost:{} {hosts}",
                        state.port
                    ));
                }
                // Only the outside network is denied: local blob:/data: media and fonts, same-origin
                // workers and WebAssembly keep working. `eval` stays off ('unsafe-eval').
                csp.push_str(&format!("; default-src {own} {hosts}; script-src {own} 'unsafe-inline' 'wasm-unsafe-eval' {hosts}; style-src {own} 'unsafe-inline' {hosts}; img-src {own} data: blob: {hosts}; font-src {own} data: blob: {hosts}; media-src {own} data: blob: {hosts}; connect-src {own} blob: {hosts}; form-action {own} {hosts}; base-uri {own}; object-src 'none'"));
            }
            // Service workers stay refused at the boundary (`blocks_service_workers`); only an
            // explicit switch also turns dedicated and shared workers off.
            if frame.policy.block_service_workers {
                csp.push_str("; worker-src 'none'");
            } else if frame.policy.no_outside_network {
                csp.push_str(&format!("; worker-src {own} blob:"));
            }
            if let Ok(value) = HeaderValue::from_str(&csp) {
                response
                    .headers_mut()
                    .append(header::CONTENT_SECURITY_POLICY, value);
            }
        }
    }
    response
}
/// Policy: any response a nested frame could render as a scripted document (HTML, SVG,
/// XHTML or other XML, or an untyped body) carries the frame CSP; a same-origin URL frame
/// does not inherit its parent's policy.
fn can_be_a_document(content_type: Option<&HeaderValue>) -> bool {
    let Some(value) = content_type.and_then(|v| Result::ok(v.to_str())) else {
        return true;
    };
    let essence = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence == "text/html" || essence.ends_with("/xml") || essence.ends_with("+xml")
}
fn cors(response: &mut Response, origin: Option<&str>) {
    if let Some(origin) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, x-codesense-proxy-token"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST, OPTIONS"),
        );
        response
            .headers_mut()
            .append(header::VARY, HeaderValue::from_static("origin"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard_stream::frame::{FrameGrant, FramePolicy};
    use axum::body::Body;
    use tower::ServiceExt;

    #[test]
    #[cfg(debug_assertions)]
    fn configured_debug_origin_is_accepted_instead_of_the_default_port() {
        let config: tauri::Config = serde_json::from_value(serde_json::json!({
            "identifier": "ai.codesense",
            "build": { "devUrl": "http://localhost:5328" }
        }))
        .unwrap();
        let configured = config
            .build
            .dev_url
            .as_ref()
            .unwrap()
            .origin()
            .ascii_serialization();
        let origins =
            AppOrigins::from_dev_url(config.build.dev_url.as_ref().map(|url| url.as_str()));
        assert!(origins.is_app_origin(&configured));
        assert!(!origins.is_app_origin("http://localhost:1420"));
        assert!(!origins.is_app_origin("http://localhost:5329"));
        assert!(!origins.is_app_origin("http://127.0.0.1:5328"));
        let csp = origins.frame_ancestors();
        assert!(csp.split_whitespace().any(|source| source == configured));
        assert!(!csp.contains("localhost:1420"));
        assert!(!csp.contains('*'));
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn release_excludes_dev_origins_even_with_a_dev_config() {
        let config: tauri::Config = serde_json::from_value(serde_json::json!({
            "identifier": "ai.codesense",
            "build": { "devUrl": "http://localhost:5328" }
        }))
        .unwrap();
        let origins =
            AppOrigins::from_dev_url(config.build.dev_url.as_ref().map(|url| url.as_str()));
        for origin in [
            config
                .build
                .dev_url
                .as_ref()
                .unwrap()
                .as_str()
                .trim_end_matches('/'),
            "http://localhost:1420",
            "http://127.0.0.1:5328",
            "http://[::1]:5328",
            "https://example.com",
            "null",
        ] {
            assert!(!origins.is_app_origin(origin), "{origin}");
        }
        assert_eq!(
            origins.frame_ancestors(),
            "frame-ancestors tauri://localhost http://tauri.localhost https://tauri.localhost"
        );
    }
    fn fixture(policy: FramePolicy) -> (Router, FrameRecord) {
        fixture_with_origins(policy, AppOrigins::default())
    }
    fn fixture_with_origins(policy: FramePolicy, app_origins: AppOrigins) -> (Router, FrameRecord) {
        fixture_in_slot("centre", policy, app_origins)
    }
    fn fixture_in_slot(
        slot: &str,
        policy: FramePolicy,
        app_origins: AppOrigins,
    ) -> (Router, FrameRecord) {
        let frames = Arc::new(FrameStore::default());
        let record = frames.mint(
            9321,
            FrameGrant {
                frame_id: String::new(),
                principal: "human".into(),
                dashboard: "board".into(),
                slot: slot.into(),
                team: None,
                scope: "open".into(),
            },
            String::new(),
            String::new(),
            String::new(),
            policy,
            None,
        );
        let app = Router::new()
            .merge(crate::http::routes::dashboard_kit::router())
            .fallback(|uri: axum::http::Uri| async move {
                let content_type = match uri.path().rsplit('.').next() {
                    Some("svg") => "image/svg+xml",
                    Some("xhtml") => "application/xhtml+xml; charset=utf-8",
                    Some("png") => "image/png",
                    Some("json") => "application/json",
                    _ => "text/html",
                };
                ([(header::CONTENT_TYPE, content_type)], "<p>board</p>")
            });
        (
            with_boundary(
                app,
                FrameBoundary {
                    frames,
                    port: 9321,
                    app_origins,
                },
            ),
            record,
        )
    }
    // The Inbox renders cached media with a same-origin `<img>`. WebKit sends no
    // SameSite=Strict cookie from a cross-site embed, so the boundary must admit
    // such an image by its frame host and hand the route the frame record.
    #[tokio::test]
    async fn same_origin_media_image_reaches_route_with_its_frame_without_cookie() {
        let (_, frame) = fixture(FramePolicy::default());
        let frames = Arc::new(FrameStore::default());
        let frame = frames.mint(
            9321,
            frame.grant.clone(),
            String::new(),
            String::new(),
            String::new(),
            FramePolicy::default(),
            None,
        );
        let app = with_boundary(
            Router::new().route(
                "/media/v1/{sha}",
                axum::routing::get(|frame: Option<axum::Extension<FrameRecord>>| async move {
                    if frame.is_some() {
                        StatusCode::OK
                    } else {
                        StatusCode::FORBIDDEN
                    }
                }),
            ),
            FrameBoundary {
                frames,
                port: 9321,
                app_origins: AppOrigins::default(),
            },
        );
        let image = |site: &str| {
            axum::http::Request::builder()
                .uri(format!("/media/v1/{}", "a".repeat(64)))
                .header("host", frame.origin.trim_start_matches("http://"))
                .header("sec-fetch-dest", "image")
                .header("sec-fetch-site", site)
                .body(Body::empty())
                .unwrap()
        };
        let same = app.clone().oneshot(image("same-origin")).await.unwrap();
        assert_eq!(same.status(), StatusCode::OK);
        let cross = app.oneshot(image("cross-site")).await.unwrap();
        assert_eq!(cross.status(), StatusCode::FORBIDDEN);
    }
    async fn request(policy: FramePolicy, worker: bool) -> Response {
        request_from(policy, worker).await.0
    }
    /// The response and the frame's own origin, which its policy names beside 'self'.
    async fn request_from(policy: FramePolicy, worker: bool) -> (Response, String) {
        let (app, frame) = fixture(policy);
        let own = frame.origin.clone();
        let mut request = axum::http::Request::builder()
            .uri("/viewer/root/board.html")
            .header("host", frame.origin.trim_start_matches("http://"))
            .header("origin", &frame.origin)
            .header("x-codesense-proxy-token", frame.token);
        if worker {
            request = request.header("service-worker", "script");
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        (response, own)
    }

    #[tokio::test]
    #[cfg(debug_assertions)]
    async fn configured_origin_bootstraps_frames_but_other_ports_cannot() {
        let config: tauri::Config = serde_json::from_value(serde_json::json!({
            "identifier": "ai.codesense",
            "build": { "devUrl": "http://localhost:5328" }
        }))
        .unwrap();
        let origins =
            AppOrigins::from_dev_url(config.build.dev_url.as_ref().map(|url| url.as_str()));
        let (app, frame) = fixture_with_origins(FramePolicy::default(), origins.clone());
        for method in ["HEAD", "GET", "OPTIONS"] {
            for origin in [
                "http://localhost:5328",
                "http://localhost:1420",
                "http://localhost:5329",
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        axum::http::Request::builder()
                            .method(method)
                            .uri("/pane/root/board.html")
                            .header("host", frame.origin.trim_start_matches("http://"))
                            .header("origin", origin)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                if origin == "http://localhost:5328" {
                    assert_eq!(
                        response.status(),
                        if method == "OPTIONS" {
                            StatusCode::NO_CONTENT
                        } else {
                            StatusCode::OK
                        }
                    );
                    assert_eq!(
                        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                        origin
                    );
                    if method != "OPTIONS" {
                        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
                            .to_str()
                            .unwrap();
                        assert!(csp.starts_with(&format!("{}; ", origins.frame_ancestors())));
                        assert!(csp.contains(&format!("; default-src 'self' {} ;", frame.origin)));
                    }
                } else {
                    assert_eq!(
                        response.status(),
                        StatusCode::FORBIDDEN,
                        "{method} {origin}"
                    );
                    assert!(!response
                        .headers()
                        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
                }
            }
        }
    }
    #[tokio::test]
    async fn kit_gets_keep_immutable_caching_inside_a_restricted_frame() {
        for path in [
            "/kit/v1/editor.js?v=stamp",
            "/kit/v1/editor.css",
            "/kit/v1/fonts/geist.woff2",
        ] {
            let (app, frame) = fixture(FramePolicy {
                no_outside_network: true,
                ..Default::default()
            });
            let response = app
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .header("host", frame.origin.trim_start_matches("http://"))
                        .header("origin", &frame.origin)
                        .header("x-codesense-proxy-token", frame.token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
        }
        for (method, path) in [
            ("HEAD", "/kit/v1/editor.js"),
            ("POST", "/kit/v1/editor.js"),
            ("GET", "/viewer/root/board.html"),
        ] {
            let (app, frame) = fixture(FramePolicy::default());
            let response = app
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header("host", frame.origin.trim_start_matches("http://"))
                        .header("origin", &frame.origin)
                        .header("x-codesense-proxy-token", frame.token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
    }

    #[tokio::test]
    async fn loopback_serves_non_content_routes_but_never_content() {
        for host in ["localhost:9321", "127.0.0.1:9321", "[::1]:9321"] {
            for path in [
                "/viewer/root/doc.html",
                "/pane/root/panes/doc.html",
                "/message/org/team/1",
                "/viewer-baseline/root/doc.js",
            ] {
                let (app, _) = fixture(FramePolicy::default());
                let response = app
                    .oneshot(
                        axum::http::Request::builder()
                            .uri(path)
                            .header("host", host)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host}{path}");
            }
            for path in [
                "/health",
                "/terminal",
                "/api/v1/terminal/status",
                "/api/v1/sprints",
                "/kit/cs.js",
            ] {
                let (app, _) = fixture(FramePolicy::default());
                let response = app
                    .oneshot(
                        axum::http::Request::builder()
                            .uri(path)
                            .header("host", host)
                            .header("x-codesense-proxy-token", "cli-secret")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK, "{host}{path}");
            }
        }
    }
    #[tokio::test]
    async fn service_workers_load_only_for_an_open_network_without_the_switch() {
        assert_eq!(
            request(
                FramePolicy {
                    no_outside_network: false,
                    ..Default::default()
                },
                true
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(
                FramePolicy {
                    block_service_workers: true,
                    ..Default::default()
                },
                true
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn no_outside_network_alone_blocks_service_worker_scripts() {
        assert_eq!(
            request(FramePolicy::default(), true).await.status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn outside_network_is_denied_by_default_and_only_exact_declared_hosts_survive() {
        // Each policy names the frame's own exact origin beside 'self', so an opaque-origin
        // (sandboxed) document keeps its own scripts and media in every engine.
        let csp = |(response, own): (Response, String)| {
            let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .to_owned();
            assert!(own.starts_with("http://f-") && own.ends_with(".localhost:9321"));
            csp.replace(&format!("'self' {own}"), "'self' <own>")
        };
        let denied = csp(request_from(FramePolicy::default(), false).await);
        for directive in [
            "default-src 'self' <own> ;",
            "script-src 'self' <own> 'unsafe-inline' 'wasm-unsafe-eval' ;",
            "style-src 'self' <own> 'unsafe-inline' ;",
            "img-src 'self' <own> data: blob: ;",
            "font-src 'self' <own> data: blob: ;",
            "media-src 'self' <own> data: blob: ;",
            "connect-src 'self' <own> blob: ;",
            "form-action 'self' <own> ;",
            "base-uri 'self' <own>;",
            "object-src 'none'",
            "worker-src 'self' <own> blob:",
        ] {
            assert!(denied.contains(directive), "{directive}: {denied}");
        }
        assert!(
            !denied.contains("'self' ;") && !denied.contains("'self';"),
            "{denied}"
        );
        assert!(!denied.contains("'unsafe-eval'"), "{denied}");
        // An explicit service-worker switch still turns every worker off.
        let workers_off = csp(request_from(
            FramePolicy {
                block_service_workers: true,
                ..Default::default()
            },
            false,
        )
        .await);
        assert!(
            workers_off.ends_with("; worker-src 'none'"),
            "{workers_off}"
        );
        let declared = csp(request_from(
            FramePolicy {
                allowed_hosts: vec!["https://api.example.com".into()],
                ..Default::default()
            },
            false,
        )
        .await);
        for directive in [
            "default-src 'self' <own> https://api.example.com;",
            "script-src 'self' <own> 'unsafe-inline' 'wasm-unsafe-eval' https://api.example.com;",
            "img-src 'self' <own> data: blob: https://api.example.com;",
            "connect-src 'self' <own> blob: https://api.example.com;",
        ] {
            assert!(declared.contains(directive), "{directive}: {declared}");
        }
        assert!(!declared.contains('*'));
        // A host the resolver would refuse never reaches the header, nor do its siblings.
        let refused = csp(request_from(
            FramePolicy {
                allowed_hosts: vec![
                    "https://api.example.com".into(),
                    "http://plain.example.com".into(),
                ],
                ..Default::default()
            },
            false,
        )
        .await);
        assert!(
            refused.contains("connect-src 'self' <own> blob: ;"),
            "{refused}"
        );
        assert!(!refused.contains("example.com"), "{refused}");
    }
    #[tokio::test]
    async fn only_slot_frames_may_nest_their_message_frames() {
        for (slot, nests) in [
            ("right-pane", true),
            ("dock", true),
            ("file-nav", true),
            ("centre", false),
            ("message", false),
        ] {
            let (app, frame) = fixture_in_slot(slot, FramePolicy::default(), AppOrigins::default());
            let response = app
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/viewer/root/board.html")
                        .header("host", frame.origin.trim_start_matches("http://"))
                        .header("origin", &frame.origin)
                        .header("x-codesense-proxy-token", &frame.token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .to_owned();
            let own = &frame.origin;
            assert_eq!(
                csp.contains(&format!(
                    "; frame-src 'self' {own} http://*.localhost:9321 ;"
                )),
                nests,
                "{slot}: {csp}"
            );
            assert!(
                csp.contains(&format!("; default-src 'self' {own} ;")),
                "{slot}: {csp}"
            );
        }
        // Declared hosts may be framed by a slot frame exactly as default-src allows them.
        let (app, frame) = fixture_in_slot(
            "dock",
            FramePolicy {
                allowed_hosts: vec!["https://api.example.com".into()],
                ..Default::default()
            },
            AppOrigins::default(),
        );
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/viewer/root/board.html")
                    .header("host", frame.origin.trim_start_matches("http://"))
                    .header("origin", &frame.origin)
                    .header("x-codesense-proxy-token", &frame.token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        let own = &frame.origin;
        assert!(
            csp.contains(&format!(
                "; frame-src 'self' {own} http://*.localhost:9321 https://api.example.com;"
            )),
            "{csp}"
        );
        assert!(!csp.contains("http://*.localhost:9321 ;"), "{csp}");
    }
    #[tokio::test]
    async fn every_scriptable_document_type_carries_the_network_policy() {
        let (app, frame) = fixture(FramePolicy::default());
        for (path, guarded) in [
            ("/viewer/root/board.html", true),
            ("/viewer/root/image.svg", true),
            ("/viewer/root/page.xhtml", true),
            ("/viewer/root/photo.png", false),
            ("/viewer/root/data.json", false),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .header("host", frame.origin.trim_start_matches("http://"))
                        .header("origin", &frame.origin)
                        .header("x-codesense-proxy-token", &frame.token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff",
                "{path}"
            );
            let csp = response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .map(|v| v.to_str().unwrap().to_owned());
            assert_eq!(
                csp.is_some_and(|csp| {
                    csp.contains(&format!("connect-src 'self' {} blob: ;", frame.origin))
                }),
                guarded,
                "{path}"
            );
        }
        assert!(can_be_a_document(None));
        assert!(can_be_a_document(Some(&HeaderValue::from_static(
            "Text/HTML; charset=utf-8"
        ))));
        assert!(can_be_a_document(Some(&HeaderValue::from_static(
            "text/xml"
        ))));
        assert!(!can_be_a_document(Some(&HeaderValue::from_static(
            "text/css"
        ))));
    }
    #[tokio::test]
    async fn app_and_live_frame_cors_are_pinned_and_teardown_revokes_access() {
        let (app, frame) = fixture(FramePolicy::default());
        for origin in [frame.origin.as_str(), "tauri://localhost"] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/viewer/root/board.html")
                        .header("host", frame.origin.trim_start_matches("http://"))
                        .header("origin", origin)
                        .header("x-codesense-proxy-token", &frame.token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                origin
            );
        }
    }
}
