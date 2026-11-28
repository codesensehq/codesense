// SPDX-License-Identifier: MIT
//! Sending the web views' `localhost` loads to the app's API listener.
//!
//! On macOS 14 and later, [`install`] sets one HTTP CONNECT proxy on the
//! default `WKWebsiteDataStore`, the store every app web view uses, pointing at
//! `127.0.0.1:<port>` with the match domain `localhost`. WebKit then hands
//! `localhost` and `*.localhost` names to the proxy instead of asking the
//! system resolver, which on macOS 15 does not map `*.localhost` subdomains.
//! Loopback IP literals and every other host still load directly.
//!
//! The Network.framework functions are looked up at run time with `dlsym`, and
//! the store is asked whether it answers `setProxyConfigurations:`, so the
//! binary still launches on macOS 11–13, where `install` does nothing. On
//! other OSes it does nothing too.
//!
//! The module is behind the `webview-proxy` feature, which only the app
//! enables. [`plan`] is OS-neutral and also compiles for this crate's tests.
#![cfg_attr(
    not(all(feature = "webview-proxy", target_os = "macos")),
    allow(dead_code)
)]

#[cfg(all(feature = "webview-proxy", target_os = "macos"))]
mod macos;

use std::ffi::{c_void, CStr};
use std::ptr::NonNull;

/// The Network.framework functions `install` calls, in lookup order.
pub(crate) const SYMBOLS: [&CStr; 4] = [
    c"nw_endpoint_create_host",
    c"nw_proxy_config_create_http_connect",
    c"nw_proxy_config_add_match_domain",
    c"nw_release",
];

/// The addresses of [`SYMBOLS`], all found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Symbols {
    pub endpoint_create_host: NonNull<c_void>,
    pub proxy_config_create_http_connect: NonNull<c_void>,
    pub proxy_config_add_match_domain: NonNull<c_void>,
    pub release: NonNull<c_void>,
}

/// Why no proxy was installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// Called off the main thread, where WebKit may not be touched.
    NotMainThread,
    /// The data store has no `setProxyConfigurations:` (before macOS 14).
    NoProxyApi,
    /// A Network.framework function was not found.
    MissingSymbol(&'static CStr),
    /// Network.framework returned no endpoint or proxy configuration.
    CreateFailed,
}

/// Whether to install, from whether the store answers
/// `setProxyConfigurations:` and a symbol lookup. All of [`SYMBOLS`] must be
/// found, or none is used.
pub(crate) fn plan(
    responds_to_set_proxy: bool,
    mut lookup: impl FnMut(&CStr) -> Option<NonNull<c_void>>,
) -> Result<Symbols, Skip> {
    if !responds_to_set_proxy {
        return Err(Skip::NoProxyApi);
    }
    let mut found = [NonNull::dangling(); 4];
    for (slot, name) in found.iter_mut().zip(SYMBOLS) {
        *slot = lookup(name).ok_or(Skip::MissingSymbol(name))?;
    }
    let [endpoint_create_host, proxy_config_create_http_connect, proxy_config_add_match_domain, release] =
        found;
    Ok(Symbols {
        endpoint_create_host,
        proxy_config_create_http_connect,
        proxy_config_add_match_domain,
        release,
    })
}

/// Point the default web view data store's `localhost` loads at
/// `127.0.0.1:<port>` (macOS 14 and later). Call it once, on the main thread.
/// Where it can't, it logs one line and does nothing. A no-op on other OSes.
#[cfg(feature = "webview-proxy")]
pub fn install(port: u16) {
    #[cfg(target_os = "macos")]
    match macos::install(port) {
        Ok(()) => log::info!(
            target: "webview_proxy",
            "localhost loads go through 127.0.0.1:{port}"
        ),
        Err(skip) => log::warn!(
            target: "webview_proxy",
            "localhost proxy not installed: {skip:?}"
        ),
    }
    #[cfg(not(target_os = "macos"))]
    let _ = port;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(n: usize) -> NonNull<c_void> {
        NonNull::new(n as *mut c_void).unwrap()
    }

    /// Finds every symbol except `missing`, at its index plus one.
    fn lookup_without(missing: Option<&CStr>) -> impl FnMut(&CStr) -> Option<NonNull<c_void>> + '_ {
        move |name| {
            let index = SYMBOLS.iter().position(|s| *s == name).unwrap();
            (Some(name) != missing).then(|| address(index + 1))
        }
    }

    #[test]
    fn installs_when_the_api_and_every_symbol_are_there() {
        assert_eq!(
            plan(true, lookup_without(None)),
            Ok(Symbols {
                endpoint_create_host: address(1),
                proxy_config_create_http_connect: address(2),
                proxy_config_add_match_domain: address(3),
                release: address(4),
            })
        );
    }

    #[test]
    fn skips_without_the_proxy_api_and_looks_nothing_up() {
        let mut lookups = 0;
        let result = plan(false, |_| {
            lookups += 1;
            Some(address(1))
        });
        assert_eq!(result, Err(Skip::NoProxyApi));
        assert_eq!(lookups, 0);
    }

    #[test]
    fn any_missing_symbol_skips_the_whole_install() {
        for name in SYMBOLS {
            assert_eq!(
                plan(true, lookup_without(Some(name))),
                Err(Skip::MissingSymbol(name)),
                "{name:?}"
            );
        }
    }

    #[test]
    fn nothing_found_names_the_first_symbol() {
        assert_eq!(plan(true, |_| None), Err(Skip::MissingSymbol(SYMBOLS[0])));
    }
}
