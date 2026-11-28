// SPDX-License-Identifier: MIT
//! The API listener's connections: HTTP/1.1 only, served by the API router.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
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
pub async fn serve_api(listener: TcpListener, router: Router) -> std::io::Result<()> {
    let api = Api { router };
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

/// What every connection of one listener shares.
#[derive(Clone)]
struct Api {
    router: Router,
}

impl Api {
    /// One client connection, HTTP/1.1 only.
    async fn serve_connection<I>(self, io: I)
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let service = service_fn(move |request| {
            let api = self.clone();
            async move { Ok::<_, Infallible>(api.route(request).await) }
        });
        if let Err(e) = http1::Builder::new()
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades()
            .await
        {
            log::debug!(target: "http", "Connection ended: {}", e);
        }
    }

    /// A request for the router.
    async fn route(&self, request: Request<Incoming>) -> Response<Body> {
        let router = TowerToHyperService::new(self.router.clone());
        match hyper::service::Service::call(&router, request).await {
            Ok(response) => response,
            Err(never) => match never {},
        }
    }
}
