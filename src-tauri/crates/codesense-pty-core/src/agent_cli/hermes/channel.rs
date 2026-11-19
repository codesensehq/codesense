// SPDX-License-Identifier: MIT
//! The private control socket grants a ticket; session RPC uses the keeper's relay.
use super::*;
use serde_json::{json, Value};
use std::{fs, io, net::SocketAddr, path::Path};
use tungstenite::client::IntoClientRequest;

/// The gateway's control socket and its engine relay: over Unix sockets, or off where
/// those are not available yet.
#[cfg_attr(unix, path = "channel/unix.rs")]
#[cfg_attr(not(unix), path = "channel/off.rs")]
mod transport;

const PROTOCOL: &str = "hermes-gateway-v1";

fn unavailable() -> io::Error {
    io::Error::other("Hermes's authenticated gateway is unavailable")
}

/// The node at `path`, opened without following a link, when only this user may use it.
fn private_node(path: &Path) -> io::Result<fs::File> {
    let node = codesense_platform::fs::open_nofollow(fs::OpenOptions::new().read(true), path)?;
    if !codesense_platform::fs::is_owner_only(&node)? {
        return Err(unavailable());
    }
    Ok(node)
}

fn control(home: &Path, verb: &str, params: Value) -> io::Result<Value> {
    let home_node = private_node(home)?;
    let mut path = home.join("gateway.sock");
    if !path.exists() {
        let pointer = home.join("gateway.sock.path");
        if !private_node(&pointer)?.metadata()?.is_file() {
            return Err(unavailable());
        }
        path = fs::read_to_string(pointer)?.trim().into();
        private_node(path.parent().ok_or_else(unavailable)?)?;
    }
    let mut request =
        serde_json::to_vec(&json!({"protocol":1,"id":1,"verb":verb,"params":params}))?;
    request.push(b'\n');
    let line = transport::call(&path, &home_node, &request)?;
    if line.len() > 65536 || !line.ends_with('\n') {
        return Err(unavailable());
    }
    let response: Value = serde_json::from_str(&line)?;
    if response["ok"] != true || response["protocol"] != 1 || response["id"] != 1 {
        return Err(unavailable());
    }
    Ok(response["result"].clone())
}

struct Endpoint {
    addr: SocketAddr,
    profile: String,
    instance: String,
}
fn discover(home: &Path) -> io::Result<Endpoint> {
    let payload = control(home, "identify", json!({}))?;
    if payload["runtime_protocol"] != 1 || payload["state"] != "ready" {
        return Err(unavailable());
    }
    let canonical = fs::canonicalize(home)?;
    let profiles = payload["served_profiles"]
        .as_array()
        .ok_or_else(unavailable)?;
    let mut matches = profiles.iter().filter(|profile| {
        profile["home"]
            .as_str()
            .and_then(|home| fs::canonicalize(home).ok())
            .as_ref()
            == Some(&canonical)
    });
    let profile = matches
        .next()
        .and_then(|profile| profile["profile_id"].as_str())
        .ok_or_else(unavailable)?;
    if matches.next().is_some() {
        return Err(unavailable());
    }
    let origin = payload["api_origin"]
        .as_str()
        .and_then(|url| url.strip_prefix("http://"))
        .ok_or_else(unavailable)?;
    let addr: SocketAddr = origin.parse().map_err(|_| unavailable())?;
    if !addr.ip().is_loopback() || addr.port() == 0 {
        return Err(unavailable());
    }
    let instance = payload["instance_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(unavailable)?;
    Ok(Endpoint {
        addr,
        profile: profile.into(),
        instance: instance.into(),
    })
}

pub(super) fn connect(
    endpoint: &Path,
    session: Option<&str>,
    home: Option<&Path>,
) -> io::Result<Box<dyn Channel>> {
    let home = home.ok_or_else(unavailable)?;
    let found = discover(home)?;
    let grant = control(
        home,
        "session-ticket",
        json!({"profile_id":found.profile,"instance_id":found.instance,"purpose":"interactive"}),
    )?;
    if grant["profile_id"] != found.profile
        || grant["instance_id"] != found.instance
        || grant["runtime_protocol"] != 1
    {
        return Err(unavailable());
    }
    let ticket = grant["ticket"]
        .as_str()
        .filter(|ticket| !ticket.is_empty())
        .ok_or_else(unavailable)?;
    let mut request = format!("ws://{}/api/ws", found.addr)
        .into_client_request()
        .map_err(|_| unavailable())?;
    request.headers_mut().insert(
        tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL,
        format!("{PROTOCOL}, hermes-gateway-ticket.{ticket}")
            .parse()
            .map_err(|_| unavailable())?,
    );
    transport::connect(endpoint, request, session, || lifecycle_hooks_ready(home))
}

fn lifecycle_hooks_ready(home: &Path) -> bool {
    let config = fs::read(home.join("config.yaml"))
        .ok()
        .and_then(|raw| serde_yaml::from_slice::<Value>(&raw).ok());
    let Some(config) = config else {
        return false;
    };
    config["hooks_auto_accept"] == true
        && OBSERVER_EVENTS.iter().all(|event| {
            config["hooks"][*event].as_array().is_some_and(|hooks| {
                hooks.iter().any(|hook| {
                    hook["command"]
                        .as_str()
                        .is_some_and(|command| command.ends_with(" --activity-hook hermes"))
                })
            })
        })
}

pub(super) fn resolve(home: &Path) -> io::Result<SocketAddr> {
    Ok(discover(home)?.addr)
}
