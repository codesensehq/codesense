// SPDX-License-Identifier: MIT
//! PDF rendering: a hidden web view loads a page and turns it into PDF bytes.
//!
//! [`render`] checks the source with [`allowed_source`] before any web view is
//! made, then hands it to this OS's renderer: `pdf/macos.rs` (WKWebView
//! `createPDF`) or `pdf/linux.rs` (a WebKitGTK print operation). Callers keep
//! the timeout and where the bytes go.
//!
//! The renderers are behind the `pdf` feature, which only the app enables, so
//! no sidecar links WebKit. [`ContentSource`] and [`allowed_source`] are
//! OS-neutral and also compile for this crate's own tests.
//!
//! The host must run its main-thread event loop: macOS dispatches the web view
//! work to the main queue and Linux to GLib's default main context, and
//! [`render`] only waits for it. The app's event loop does both.
//!
//! [`allowed_source`] checks the top-level source only. Redirects and
//! subresources stay under each renderer's own navigation policy.

#[cfg(all(feature = "pdf", target_os = "linux"))]
mod linux;
#[cfg(all(feature = "pdf", target_os = "linux"))]
use self::linux as sys;
#[cfg(all(feature = "pdf", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "pdf", target_os = "macos"))]
use self::macos as sys;

use std::net::Ipv4Addr;

/// What an export loads: a URL, or an HTML string.
pub enum ContentSource {
    Url(String),
    Html(String),
}

/// Whether an export may load `source`. Every HTML string may. A URL may only
/// when it is `http` on this machine as the viewer serves it: `127.0.0.1`,
/// `localhost` or a `*.localhost` subdomain, on any port, with no user info.
/// Anything else is refused, with the reason as the error.
pub fn allowed_source(source: &ContentSource) -> Result<(), String> {
    let url = match source {
        ContentSource::Html(_) => return Ok(()),
        ContentSource::Url(url) => url,
    };
    let refused = || {
        format!(
            "PDF export only loads http pages served on this machine \
             (127.0.0.1, localhost or *.localhost); refused {url}"
        )
    };
    let parsed = url::Url::parse(url).map_err(|_| refused())?;
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(refused());
    }
    // The parser lowercases an http host, so `LOCALHOST` matches too.
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) if ip == Ipv4Addr::LOCALHOST => Ok(()),
        Some(url::Host::Domain(host)) if host == "localhost" || host.ends_with(".localhost") => {
            Ok(())
        }
        _ => Err(refused()),
    }
}

/// Render `source` to PDF bytes, after [`allowed_source`] lets it through. A
/// refused source is an error, and no web view is made for it.
#[cfg(all(feature = "pdf", any(target_os = "macos", target_os = "linux")))]
pub async fn render(source: ContentSource) -> Result<Vec<u8>, String> {
    allowed_source(&source)?;
    sys::render(source).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(url: &str) -> Result<(), String> {
        allowed_source(&ContentSource::Url(url.to_string()))
    }

    fn assert_refused(urls: &[&str]) {
        for url in urls {
            let err = check(url).expect_err(url);
            assert!(err.contains("refused"), "{url}: {err}");
        }
    }

    #[test]
    fn http_on_this_machine_is_allowed() {
        for url in [
            "http://127.0.0.1/",
            "http://127.0.0.1:4310/notes/a.md",
            "http://localhost",
            "http://localhost:4310/",
            "http://f-1a2b.localhost:4310/view?x=1",
            "http://a.b.localhost/",
        ] {
            assert_eq!(check(url), Ok(()), "{url}");
        }
    }

    #[test]
    fn host_matching_ignores_case() {
        for url in ["http://LOCALHOST:4310/", "http://F-1A2B.LocalHost/"] {
            assert_eq!(check(url), Ok(()), "{url}");
        }
    }

    #[test]
    fn every_html_string_is_allowed() {
        for html in ["", "<p>hi</p>", "<img src=\"file:///etc/passwd\">"] {
            assert_eq!(
                allowed_source(&ContentSource::Html(html.to_string())),
                Ok(())
            );
        }
    }

    #[test]
    fn other_schemes_are_refused() {
        assert_refused(&[
            "https://localhost/",
            "https://127.0.0.1:4310/",
            "file:///etc/passwd",
            "file://localhost/etc/passwd",
            "data:text/html,<p>hi</p>",
            "javascript:alert(1)",
            "ftp://localhost/",
            "ws://localhost/",
            // Parses with the scheme `localhost`.
            "localhost:4310",
        ]);
    }

    #[test]
    fn other_hosts_are_refused() {
        assert_refused(&[
            "http://example.com/",
            "http://127.0.0.2/",
            "http://192.0.2.1/",
            "http://0.0.0.0/",
        ]);
    }

    #[test]
    fn lookalike_hosts_are_refused() {
        assert_refused(&[
            "http://localhost.evil.test/",
            "http://evillocalhost/",
            "http://localhost.evil.test:4310/",
            "http://127.0.0.1.evil.test/",
        ]);
    }

    /// `http://<user>:<placeholder>@localhost/`, built at run time so the
    /// source holds no URL with a password in it for secret scanners to flag.
    fn with_password(user: &str) -> String {
        let mut url = url::Url::parse("http://localhost/").unwrap();
        url.set_username(user).unwrap();
        url.set_password(Some("placeholder")).unwrap();
        url.into()
    }

    #[test]
    fn user_info_is_refused() {
        assert_refused(&["http://a@127.0.0.1/", "http://a@localhost:4310/"]);
        assert_refused(&[with_password("a").as_str(), with_password("").as_str()]);
    }

    #[test]
    fn ipv6_loopback_is_refused() {
        assert_refused(&["http://[::1]/", "http://[::1]:4310/"]);
    }

    #[test]
    fn unparsable_urls_are_refused() {
        assert_refused(&["", "not a url", "http://", "//localhost/"]);
    }
}
