// SPDX-License-Identifier: MIT
//! The `localhost` CONNECT proxy on the default WKWebsiteDataStore (macOS 14+).

use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr::{null_mut, NonNull};

use objc2::runtime::{AnyObject, NSObjectProtocol};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_foundation::NSArray;
use objc2_web_kit::WKWebsiteDataStore;

use super::{plan, Skip, Symbols};

/// Network.framework, which WebKit already loads. Opened by path so the lookup
/// does not depend on load order; never closed.
const NETWORK: &CStr = c"/System/Library/Frameworks/Network.framework/Network";

// The SDK signatures (`Network/endpoint.h`, `Network/proxy_config.h`,
// `Network/object.h`). Every `nw_*_t` is an OS object, which is an ObjC object.
type EndpointCreateHost =
    unsafe extern "C" fn(hostname: *const c_char, port: *const c_char) -> *mut AnyObject;
type ProxyConfigCreateHttpConnect = unsafe extern "C" fn(
    proxy_endpoint: *mut AnyObject,
    proxy_tls_options: *mut AnyObject,
) -> *mut AnyObject;
type ProxyConfigAddMatchDomain =
    unsafe extern "C" fn(config: *mut AnyObject, match_domain: *const c_char);
type Release = unsafe extern "C" fn(object: *mut c_void);

pub(super) fn install(port: u16) -> Result<(), Skip> {
    let mtm = MainThreadMarker::new().ok_or(Skip::NotMainThread)?;
    // SAFETY: on the main thread, as the marker proves.
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    let responds = store.respondsToSelector(sel!(setProxyConfigurations:));
    // SAFETY: a NUL-terminated path. The handle is never closed.
    let network = unsafe { libc::dlopen(NETWORK.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
    let symbols = plan(responds, |name| lookup(network, name))?;
    // SAFETY: each address was found under its name, and the types above are
    // that function's SDK signature.
    let (create_host, create_http_connect, add_match_domain, release) = unsafe {
        let Symbols {
            endpoint_create_host,
            proxy_config_create_http_connect,
            proxy_config_add_match_domain,
            release,
        } = symbols;
        (
            std::mem::transmute::<*mut c_void, EndpointCreateHost>(endpoint_create_host.as_ptr()),
            std::mem::transmute::<*mut c_void, ProxyConfigCreateHttpConnect>(
                proxy_config_create_http_connect.as_ptr(),
            ),
            std::mem::transmute::<*mut c_void, ProxyConfigAddMatchDomain>(
                proxy_config_add_match_domain.as_ptr(),
            ),
            std::mem::transmute::<*mut c_void, Release>(release.as_ptr()),
        )
    };
    let port = CString::new(port.to_string()).expect("a number has no NUL");

    // SAFETY: the arguments are NUL-terminated strings and live OS objects;
    // each object this creates is released once, after its last use. The
    // config keeps its own reference to the endpoint, and the array to the
    // config, so the store holds the proxy after both releases.
    unsafe {
        let endpoint = create_host(c"127.0.0.1".as_ptr(), port.as_ptr());
        if endpoint.is_null() {
            return Err(Skip::CreateFailed);
        }
        let config = create_http_connect(endpoint, null_mut());
        release(endpoint.cast());
        if config.is_null() {
            return Err(Skip::CreateFailed);
        }
        add_match_domain(config, c"localhost".as_ptr());
        let proxies = NSArray::<AnyObject>::from_slice(&[&*config]);
        let () = msg_send![&*store, setProxyConfigurations: &*proxies];
        release(config.cast());
    }
    Ok(())
}

/// `dlsym` in the opened Network.framework, if it opened.
fn lookup(network: *mut c_void, name: &CStr) -> Option<NonNull<c_void>> {
    if network.is_null() {
        return None;
    }
    // SAFETY: a live handle and a NUL-terminated name.
    NonNull::new(unsafe { libc::dlsym(network, name.as_ptr()) })
}
