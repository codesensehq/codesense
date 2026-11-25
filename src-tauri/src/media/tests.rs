// SPDX-License-Identifier: MIT
use super::*;
use sha2::{Digest, Sha256};

#[test]
fn fetch_rule_requires_auto_own_machine_and_allowed_host() {
    for mode in [Remote::Auto, Remote::Ask, Remote::Off] {
        for own in [true, false] {
            for host in ["i.giphy.com", "example.com"] {
                let config = Config {
                    remote: mode,
                    ..Config::default()
                };
                assert_eq!(
                    config.should_auto_fetch(host, own),
                    mode == Remote::Auto && own && host == "i.giphy.com"
                );
                let a = Attachment::remote(&format!("https://{host}/cat.gif"), "cat", &config, own)
                    .unwrap();
                assert_eq!(
                    a.state,
                    if mode == Remote::Off {
                        "blocked"
                    } else {
                        "pending"
                    }
                );
            }
        }
    }
    assert!(!Config::default().allows("giphy.com.evil.test"));
}

#[test]
fn checks_magic_dimensions_and_size() {
    let gif = b"GIF89a\x02\x00\x03\x00";
    assert_eq!(inspect(gif).unwrap(), ("image/gif", 2, 3));
    assert_eq!(
        inspect(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
            .unwrap_err()
            .reason,
        "type"
    );
    assert_eq!(inspect(&vec![0; MAX_BYTES + 1]).unwrap_err().reason, "size");
    assert!(inspect(b"GIF89a\x00\x00\x00\x00").is_err());
}

#[test]
fn media_requires_alt_and_exactly_one_source() {
    let input = |url, path, alt: &str| MediaInput {
        url,
        path,
        alt: alt.into(),
        provider: None,
        provider_id: None,
    };
    assert!(input(None, None, "cat").validate().is_err());
    assert!(input(Some("https://i.giphy.com/cat.gif".into()), None, "")
        .validate()
        .is_err());
    assert!(
        input(Some("http://i.giphy.com/cat.gif".into()), None, "cat")
            .validate()
            .is_err()
    );
    assert!(
        input(Some("https://i.giphy.com/cat.gif".into()), None, "cat")
            .validate()
            .is_ok()
    );
}

#[test]
fn local_media_uses_sender_scope_when_ui_scope_is_parent_team() {
    use crate::agents::content_reader::ContentReader;
    use crate::context_repo::{caller_scope::CallerScope, inheritance};

    let (_temp, root) = inheritance::test_fixture();
    let parent_only = root.join("parent/content/parent.gif");
    let child_image = root.join("child/content/child.gif");
    let gif = b"GIF89a\x02\x00\x03\x00";
    std::fs::write(&parent_only, gif).unwrap();
    std::fs::write(&child_image, gif).unwrap();

    let caller = CallerScope::Team(inheritance::team_view(&root, "acme/ctx", "child"));
    let ui = CallerScope::Team(inheritance::team_view(&root, "acme/ctx", "parent"));
    assert!(ui.open(&parent_only).is_ok());

    let cache = tempfile::tempdir().unwrap();
    let media = MediaState::for_test(cache.path().to_path_buf(), Arc::new(Unreachable));
    assert!(prepare_local_for_scope(&caller, &parent_only, "parent", &media).is_err());
    let own = prepare_local_for_scope(&caller, &child_image, "child", &media).unwrap();
    assert_eq!(own.state, "cached");
    assert_eq!(own.mime.as_deref(), Some("image/gif"));
    assert_eq!(
        read_cached(cache.path(), own.sha256.as_deref().unwrap()).unwrap(),
        gif
    );
}

#[cfg(unix)]
#[test]
fn local_media_workspace_access_is_sender_bound_and_canonical() {
    use crate::context_repo::{caller_scope::CallerScope, inheritance};
    use std::os::unix::fs::symlink;

    let (_temp, root) = inheritance::test_fixture();
    let caller = CallerScope::Team(inheritance::team_view(&root, "acme/ctx", "child"));
    let workspace_parent = tempfile::tempdir().unwrap();
    let workspace = workspace_parent.path().join("sender-session-worktree");
    std::fs::create_dir_all(&workspace).unwrap();
    let other_workspace = tempfile::tempdir().unwrap();
    let arbitrary = tempfile::tempdir().unwrap();
    let image = workspace.join("meme.gif");
    let other_image = other_workspace.path().join("other.gif");
    let arbitrary_image = arbitrary.path().join("unowned.gif");
    let outside = root.join("parent/content/parent.gif");
    let escape = workspace.join("escape.gif");
    let traversal_target = workspace_parent.path().join("escape.gif");
    let gif = b"GIF89a\x02\x00\x03\x00";
    std::fs::write(&image, gif).unwrap();
    std::fs::write(&other_image, gif).unwrap();
    std::fs::write(&arbitrary_image, gif).unwrap();
    std::fs::write(&outside, gif).unwrap();
    std::fs::write(&traversal_target, gif).unwrap();
    symlink(&outside, &escape).unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache = MediaState::for_test(cache.path().to_path_buf(), Arc::new(Unreachable));

    let own =
        prepare_local_for_scope_or_workspace(&caller, &image, Some(&workspace), "own meme", &cache);
    let other = prepare_local_for_scope_or_workspace(
        &caller,
        &other_image,
        Some(&workspace),
        "other meme",
        &cache,
    );
    let parent = prepare_local_for_scope_or_workspace(
        &caller,
        &outside,
        Some(&workspace),
        "parent only",
        &cache,
    );
    let symlink_escape = prepare_local_for_scope_or_workspace(
        &caller,
        &escape,
        Some(&workspace),
        "symlink escape",
        &cache,
    );
    let traversal_escape = prepare_local_for_scope_or_workspace(
        &caller,
        &workspace.join("../escape.gif"),
        Some(&workspace),
        "traversal escape",
        &cache,
    );
    let unowned = prepare_local_for_scope_or_workspace(
        &caller,
        &arbitrary_image,
        Some(&workspace),
        "unowned path",
        &cache,
    );
    let remote_workspace =
        prepare_local_for_scope_or_workspace(&caller, &image, None, "remote worktree", &cache);
    let unknown = prepare_local_for_scope_or_workspace(
        &CallerScope::Unknown,
        &image,
        Some(&workspace),
        "unknown sender",
        &cache,
    );
    assert!(own.is_ok(), "sender can attach from its own workspace");
    assert!(other.is_err(), "another session's workspace is refused");
    assert!(parent.is_err(), "parent-only team content remains refused");
    assert!(
        symlink_escape.is_err(),
        "workspace symlink escape is refused"
    );
    assert!(
        traversal_escape.is_err(),
        "workspace traversal escape is refused"
    );
    assert!(
        unowned.is_err(),
        "arbitrary paths outside team content and sender workspace are refused"
    );
    assert!(
        remote_workspace.is_err(),
        "remote worktrees are not local sender workspaces"
    );
    assert!(unknown.is_err(), "unknown callers cannot use local media");
}

#[test]
fn off_masks_cached_remote_media_without_changing_the_stored_attachment() {
    let a = Attachment::remote(
        "https://i.giphy.com/cat.gif",
        "cat",
        &Config::default(),
        true,
    )
    .unwrap();
    let config = Config {
        remote: Remote::Off,
        ..Config::default()
    };
    let mut masked = vec![a.clone()];
    config.apply(&mut masked);
    assert_eq!(masked[0].state, "blocked");
    assert_ne!(a.state, "blocked");
}

#[tokio::test]
async fn fetch_transport_omits_private_headers_rejects_redirect_and_caps_stream() {
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gif"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("set-cookie", "tracker=private")
                .set_body_bytes(b"GIF89a\x02\x00\x03\x00"),
        )
        .mount(&server)
        .await;
    Mock::given(path("/redirect"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "https://example.com/tracker.gif"),
        )
        .mount(&server)
        .await;
    Mock::given(path("/large"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0; MAX_BYTES + 1]))
        .mount(&server)
        .await;
    let client = client_builder(&Config::default()).build().unwrap();
    for _ in 0..2 {
        let bytes = read_response(
            client
                .get(format!("{}/gif", server.uri()))
                .send()
                .await
                .unwrap(),
        )
        .await
        .unwrap()
        .bytes;
        assert_eq!(inspect(&bytes).unwrap(), ("image/gif", 2, 3));
    }
    Mock::given(path("/same-host"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", format!("{}/gif", server.uri())),
        )
        .mount(&server)
        .await;
    // The HTTP fixture substitutes only redirect admission; production still enforces HTTPS.
    let following = client_builder(&Config::default())
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .unwrap();
    read_response(
        following
            .get(format!("{}/same-host", server.uri()))
            .send()
            .await
            .unwrap(),
    )
    .await
    .unwrap();
    let requests = server.received_requests().await.unwrap();
    for request in &requests {
        assert!(request.headers.get("cookie").is_none());
        assert!(request.headers.get("referer").is_none());
        assert_eq!(
            request.headers.get("user-agent").unwrap(),
            "ImageFetcher/1.0"
        );
    }
    assert!(client
        .get(format!("{}/redirect", server.uri()))
        .send()
        .await
        .unwrap_err()
        .is_redirect());
    assert_eq!(
        read_response(
            client
                .get(format!("{}/large", server.uri()))
                .send()
                .await
                .unwrap()
        )
        .await
        .unwrap_err()
        .reason,
        "size"
    );
    // A body with unknown length must also stop while streaming, rather than buffering the whole file.
    use axum::{body::Body, routing::get, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/",
        get(|| async {
            Body::from_stream(futures_util::stream::iter(
                (0..10).map(|_| Ok::<_, std::io::Error>(vec![0; 1024 * 1024])),
            ))
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let response = client
        .get(format!("http://{address}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.content_length(), None);
    assert_eq!(read_response(response).await.unwrap_err().reason, "size");
    task.abort();
}

#[test]
fn cache_round_trips_verified_bytes_and_all_supported_headers() {
    let dir = tempfile::tempdir().unwrap();
    let media = MediaState::for_test(dir.path().to_path_buf(), Arc::new(Unreachable));
    let mut a = Attachment::empty("cat");
    let bytes = b"GIF89a\x02\x00\x03\x00";
    media.keep(bytes.to_vec(), None, &mut a).unwrap();
    assert_eq!(
        read_cached(dir.path(), a.sha256.as_deref().unwrap()).unwrap(),
        bytes
    );
    assert_eq!(a.state, "cached");
    let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    png.extend_from_slice(&2u32.to_be_bytes());
    png.extend_from_slice(&3u32.to_be_bytes());
    assert_eq!(inspect(&png).unwrap(), ("image/png", 2, 3));
    let mut webp = vec![0u8; 30];
    webp[..4].copy_from_slice(b"RIFF");
    webp[8..12].copy_from_slice(b"WEBP");
    webp[12..16].copy_from_slice(b"VP8X");
    webp[24] = 1;
    webp[27] = 2;
    assert_eq!(inspect(&webp).unwrap(), ("image/webp", 2, 3));
    let jpeg = b"\xff\xd8\xff\xc0\x00\x07\x08\x00\x03\x00\x02";
    assert_eq!(inspect(jpeg).unwrap(), ("image/jpeg", 2, 3));
}

#[test]
fn config_reads_edits_without_polling_or_a_cached_policy() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(Config::load(dir.path()).remote, Remote::Auto);
    std::fs::write(dir.path().join("inbox.yml"), "media: {remote: off}").unwrap();
    assert_eq!(Config::load(dir.path()).remote, Remote::Off);
    std::fs::write(
        dir.path().join("inbox.yml"),
        "media: {remote: ask, hosts: [images.example.com]}",
    )
    .unwrap();
    let config = Config::load(dir.path());
    assert_eq!(config.remote, Remote::Ask);
    assert!(config.allows("images.example.com"));
    assert!(!config.allows("i.giphy.com"));
}

#[test]
fn canonical_config_edits_emit_the_existing_inbox_domain_event() {
    use tauri::{Listener, Manager};
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(crate::live_hub::LiveHub::default());
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = events.clone();
    app.listen(crate::live_hub::inbox_events::INBOX_EVENT, move |e| {
        captured.lock().unwrap().push(e.payload().to_string());
    });
    let team = std::path::Path::new("/ctx/team");
    note_config_path(
        app.handle(),
        team,
        "org",
        "team",
        &team.join("config/other.yml"),
    );
    assert!(events.lock().unwrap().is_empty());
    note_config_path(
        app.handle(),
        team,
        "org",
        "team",
        &team.join("config/inbox.yml"),
    );
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    let event: crate::live_hub::inbox_events::InboxEvent =
        serde_json::from_str(&events[0]).unwrap();
    assert_eq!(event.team.org, "org");
    assert_eq!(event.team.team, "team");
}

#[test]
fn evicted_remote_images_offer_retry_and_local_images_report_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let state = MediaState::for_test(dir.path().to_path_buf(), Arc::new(Unreachable));
    let mut local = Attachment::empty("cat");
    state
        .keep(b"GIF89a\x02\x00\x03\x00".to_vec(), None, &mut local)
        .unwrap();
    let mut remote = local.clone();
    remote.source_url = Some("https://i.giphy.com/cat.gif".into());
    std::fs::remove_file(dir.path().join(local.sha256.as_ref().unwrap())).unwrap();
    let mut images = vec![local, remote];
    state.present(&Config::default(), &mut images);
    assert_eq!(images[0].state, "failed");
    assert_eq!(images[0].reason.as_deref(), Some("cache"));
    assert!(!images[0].retryable);
    assert!(images[1].retryable);
}

#[tokio::test]
async fn review_02_dns_loopback_is_refused() {
    assert_eq!(public_dns("localhost").await.unwrap_err().reason, "address");
}
#[tokio::test]
async fn review_02_private_redirect_is_refused_before_connecting() {
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(path("/redirect"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "https://127.0.0.1:1/image.gif"),
        )
        .mount(&server)
        .await;
    let config = Config {
        hosts: vec!["127.0.0.1".into()],
        ..Config::default()
    };
    let error = client_builder(&config)
        .build()
        .unwrap()
        .get(format!("{}/redirect", server.uri()))
        .send()
        .await
        .unwrap_err();
    assert!(
        error.is_redirect(),
        "private redirect must fail admission: {error:?}"
    );
}
#[test]
fn review_03_decoded_dimensions_are_bounded() {
    assert_eq!(
        inspect(b"GIF89a\x01\x10\x00\x10").unwrap_err().reason,
        "pixels"
    );
}

#[tokio::test]
async fn review_02_nonpublic_address_families_are_refused() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "100.64.0.1",
        "169.254.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "ff02::1",
        "::ffff:10.0.0.1",
        "::ffff:8.8.8.8",
        // NAT64 local-use (RFC 8215) can translate to any IPv4, including private ranges.
        "64:ff9b:1::a00:1",
        // NAT64 well-known prefix and 6to4 carrying private IPv4.
        "64:ff9b::a00:1",
        "2002:a00:1::1",
        // Teredo and documentation ranges.
        "2001::1",
        "2001:db8::1",
    ] {
        assert!(public_dns(ip).await.is_err(), "{ip} must not be fetched");
    }
    assert!(public_dns("8.8.8.8").await.is_ok());
    // Translation prefixes carrying a public IPv4 stay usable (DNS64 networks).
    for ip in ["64:ff9b::808:808", "2002:808:808::1"] {
        assert!(
            public_ip(ip.parse().unwrap()),
            "{ip} embeds a public address"
        );
    }
}

#[test]
fn read_cached_refuses_a_directory_a_symlink_or_an_oversized_file() {
    let dir = tempfile::tempdir().unwrap();
    let sha = |c: char| c.to_string().repeat(64);
    std::fs::create_dir(dir.path().join(sha('a'))).unwrap();
    std::fs::write(dir.path().join(sha('b')), vec![0u8; MAX_BYTES + 1]).unwrap();
    std::fs::write(dir.path().join(sha('c')), b"GIF89a\x02\x00\x03\x00").unwrap();
    let mut refused = vec!['a', 'b'];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join(sha('c')), dir.path().join(sha('d'))).unwrap();
        refused.push('d');
    }
    for refused in refused {
        assert_eq!(
            read_cached(dir.path(), &sha(refused)),
            Err("media unavailable".to_string()),
            "{refused}"
        );
    }
    assert!(read_cached(dir.path(), &sha('c')).is_ok());
}

// Provider media is held in memory only.

const GIF: &[u8] = b"GIF89a\x02\x00\x03\x00";

/// A distinct GIF the inspector accepts.
fn gif(n: u8) -> Vec<u8> {
    let mut bytes = GIF.to_vec();
    bytes.push(n);
    bytes
}

fn sha_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn remote(url: &str, own: bool) -> Attachment {
    Attachment::remote(url, "cat", &Config::default(), own).unwrap()
}

fn owner(team: &str, message_id: i64) -> index::Owner {
    index::Owner {
        org: "acme".into(),
        team: team.into(),
        message_id,
        chat: None,
    }
}

/// The files in the disk cache.
fn files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn state_over(fetch: &Arc<FakeFetch>) -> (tempfile::TempDir, Arc<MediaState>) {
    let dir = tempfile::tempdir().unwrap();
    let state = MediaState::for_test(dir.path().join("inbox-media"), fetch.clone());
    (dir, state)
}

use std::sync::Arc;

/// A fetcher for tests that must not reach the network.
struct Unreachable;
impl Fetch for Unreachable {
    fn get<'a>(
        &'a self,
        _url: &'a str,
        _config: &'a Config,
    ) -> futures_util::future::BoxFuture<'a, Result<Downloaded, Failure>> {
        Box::pin(async { Err(failure("http")) })
    }
}

#[test]
fn provider_host_lists_are_fixed_and_their_union_is_provider_hosts() {
    let union: Vec<_> = GIPHY_HOSTS.iter().chain(KLIPY_HOSTS).copied().collect();
    assert_eq!(PROVIDER_HOSTS, union.as_slice());
    for (host, provider) in [
        ("giphy.com", MediaProvider::Giphy),
        ("media2.giphy.com", MediaProvider::Giphy),
        ("I.GIPHY.COM.", MediaProvider::Giphy),
        ("klipy.com", MediaProvider::Klipy),
        ("static.klipy.com", MediaProvider::Klipy),
        ("giphy.com.evil.test", MediaProvider::None),
        ("notgiphy.com", MediaProvider::None),
        ("example.com", MediaProvider::None),
    ] {
        assert_eq!(MediaProvider::of_host(host), provider, "{host}");
    }
}

#[test]
fn the_default_allowlist_is_every_giphy_and_klipy_subdomain() {
    let config = Config::default();
    assert_eq!(config.hosts, vec!["*.giphy.com", "*.klipy.com"]);
    for host in ["i.giphy.com", "static.klipy.com", "media.klipy.com"] {
        assert!(config.allows(host), "{host}");
    }
}

#[test]
fn new_attachment_fields_are_optional_and_old_messages_read_unchanged() {
    let old = r#"{"kind":"image","sha256":"ab","alt":"cat","sourceHost":"i.giphy.com","state":"cached","retryable":false}"#;
    let a: Attachment = serde_json::from_str(old).unwrap();
    assert_eq!(a.media_provider, None);
    assert!(!a.own_sender);
    assert!(
        a.is_provider_media(),
        "an old provider-host attachment counts as provider media"
    );
    assert_eq!(serde_json::to_string(&a).unwrap(), old);
    let mut new = a.clone();
    new.media_provider = Some(MediaProvider::None);
    new.own_sender = true;
    let json = serde_json::to_string(&new).unwrap();
    assert!(json.contains(r#""mediaProvider":"none""#) && json.contains(r#""ownSender":true"#));
    assert!(
        !new.is_provider_media(),
        "`none` wins over a provider source host"
    );
    assert_eq!(serde_json::from_str::<Attachment>(&json).unwrap(), new);
}

#[tokio::test]
async fn provider_bytes_from_a_send_or_a_tap_never_reach_disk() {
    let fetch = Arc::new(FakeFetch::default());
    let url = "https://i.giphy.com/cat.gif";
    fetch.serve(url, &gif(1), url, None);
    let (_dir, state) = state_over(&fetch);
    // The send-time fetch (automatic) and a tap-to-load (consent) take the same decision.
    for automatic in [true, false] {
        let a = state
            .fetch(&Config::default(), remote(url, true), automatic)
            .await
            .unwrap();
        assert_eq!(a.state, "cached");
        assert_eq!(a.media_provider, Some(MediaProvider::Giphy));
        assert!(files(state.dir()).is_empty(), "nothing under the cache dir");
        assert!(state
            .memory
            .contains(a.sha256.as_deref().unwrap(), std::time::Instant::now()));
    }
}

/// Fetches through the real HTTP stack, with the named hosts pointed at a local server.
struct Local(reqwest::Client);
impl Fetch for Local {
    fn get<'a>(
        &'a self,
        url: &'a str,
        _config: &'a Config,
    ) -> futures_util::future::BoxFuture<'a, Result<Downloaded, Failure>> {
        Box::pin(send(&self.0, url::Url::parse(url).unwrap()))
    }
}

#[tokio::test]
async fn the_final_host_after_redirects_decides_storage() {
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    let port = server.address().port();
    let redirect = |to: String| ResponseTemplate::new(302).insert_header("location", to);
    Mock::given(path("/to-giphy"))
        .respond_with(redirect(format!("http://i.giphy.com:{port}/gif-a")))
        .mount(&server)
        .await;
    Mock::given(path("/gif-a"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(gif(1)))
        .mount(&server)
        .await;
    Mock::given(path("/to-plain"))
        .respond_with(redirect(format!("http://example.test:{port}/gif-b")))
        .mount(&server)
        .await;
    Mock::given(path("/gif-b"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(gif(2)))
        .mount(&server)
        .await;
    // The HTTP fixture substitutes only the redirect admission and DNS; production still
    // enforces HTTPS, the allowlist and public addresses.
    let client = client_builder(&Config::default())
        .redirect(reqwest::redirect::Policy::limited(3))
        .resolve("i.giphy.com", *server.address())
        .resolve("example.test", *server.address())
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let state = MediaState::for_test(dir.path().join("inbox-media"), Arc::new(Local(client)));
    let at = |url: String| {
        let mut a = Attachment::empty("cat");
        a.source_host = url::Url::parse(&url).unwrap().host_str().map(String::from);
        a.source_url = Some(url);
        a.own_sender = true;
        a
    };
    let config = Config::default();

    let to_giphy = state
        .fetch(
            &config,
            at(format!("http://example.test:{port}/to-giphy")),
            false,
        )
        .await
        .unwrap();
    assert_eq!(to_giphy.state, "cached");
    assert_eq!(to_giphy.media_provider, Some(MediaProvider::Giphy));
    assert!(
        files(state.dir()).is_empty(),
        "a redirect to GIPHY is held in memory"
    );

    let to_plain = state
        .fetch(
            &config,
            at(format!("http://i.giphy.com:{port}/to-plain")),
            false,
        )
        .await
        .unwrap();
    assert_eq!(to_plain.state, "cached");
    assert_eq!(to_plain.media_provider, Some(MediaProvider::None));
    assert_eq!(files(state.dir()), vec![to_plain.sha256.clone().unwrap()]);
}

fn cached_ref(url: &str, own: bool, sha: &str, provider: MediaProvider) -> Attachment {
    let mut a = remote(url, own);
    a.sha256 = Some(sha.into());
    a.state = "cached".into();
    a.reason = None;
    a.media_provider = Some(provider);
    a
}

#[tokio::test]
async fn after_a_restart_only_an_own_sender_url_is_fetched_automatically() {
    let fetch = Arc::new(FakeFetch::default());
    let (own_url, remote_url) = (
        "https://media.giphy.com/own.gif",
        "https://i.giphy.com/theirs.gif",
    );
    let bytes = gif(3);
    fetch.serve(own_url, &bytes, own_url, None);
    fetch.serve(remote_url, &bytes, remote_url, None);
    let sha = sha_of(&bytes);
    // A new state: memory cleared and the sender's tab gone; only the saved `ownSender`.
    let (_dir, state) = state_over(&fetch);
    let own = cached_ref(own_url, true, &sha, MediaProvider::Giphy);
    let theirs = cached_ref(remote_url, false, &sha, MediaProvider::Giphy);
    state.note(&owner("a", 1), 1, std::slice::from_ref(&own));
    state.note(&owner("b", 2), 2, std::slice::from_ref(&theirs));
    let config = Config::default();
    let mut listed = vec![own.clone(), theirs.clone()];
    state.present(&config, &mut listed);
    assert!(
        listed.iter().all(|a| a.state == "cached"),
        "re-fetchable: {listed:?}"
    );
    let got = read(&state, &config, &sha).await.unwrap();
    assert_eq!(got.as_ref(), bytes.as_slice());
    assert_eq!(fetch.calls(), vec![own_url.to_string()]);
    // The remote sender's URL is fetched only on a tap.
    let mut tapped = theirs.clone();
    tapped.state = "pending".into();
    state.fetch(&config, tapped, false).await.unwrap();
    assert_eq!(
        fetch.calls(),
        vec![own_url.to_string(), remote_url.to_string()]
    );
}

#[tokio::test]
async fn a_non_provider_copy_is_deleted_when_a_provider_reference_arrives() {
    let fetch = Arc::new(FakeFetch::default());
    let plain = "https://example.com/p.gif";
    let bytes = gif(4);
    fetch.serve(plain, &bytes, plain, None);
    let (_dir, state) = state_over(&fetch);
    let config = Config {
        hosts: vec!["example.com".into()],
        ..Config::default()
    };
    let a = state
        .fetch(&config, remote(plain, true), false)
        .await
        .unwrap();
    let sha = a.sha256.clone().unwrap();
    state.note(&owner("a", 1), 1, &[a]);
    assert_eq!(files(state.dir()), vec![sha.clone()]);
    assert!(!state.is_memory_only(&sha, None));
    let giphy = cached_ref(
        "https://i.giphy.com/same.gif",
        false,
        &sha,
        MediaProvider::Giphy,
    );
    state.note(&owner("b", 2), 2, &[giphy]);
    assert!(state.is_memory_only(&sha, None));
    assert!(
        files(state.dir()).is_empty(),
        "the shared copy goes at once"
    );
    // And a later fetch of the plain URL keeps it in memory: the memory-only rule wins.
    state
        .fetch(&config, remote(plain, true), false)
        .await
        .unwrap();
    assert!(files(state.dir()).is_empty());
}

#[test]
fn listing_shows_tap_to_load_without_an_own_sender_and_the_link_card_when_off() {
    let (_dir, state) = state_over(&Arc::new(FakeFetch::default()));
    let sha = sha_of(&gif(5));
    let theirs = cached_ref(
        "https://i.giphy.com/x.gif",
        false,
        &sha,
        MediaProvider::Giphy,
    );
    state.note(&owner("a", 1), 1, std::slice::from_ref(&theirs));
    let mut listed = vec![theirs.clone()];
    state.present(&Config::default(), &mut listed);
    assert_eq!(listed[0].state, "pending");
    assert_eq!(listed[0].reason.as_deref(), Some("sender"));
    // An own sender, but remote media off: the link card.
    let own = cached_ref(
        "https://i.giphy.com/x.gif",
        true,
        &sha,
        MediaProvider::Giphy,
    );
    state.note(&owner("a", 2), 2, std::slice::from_ref(&own));
    let off = Config {
        remote: Remote::Off,
        ..Config::default()
    };
    let mut listed = vec![own];
    state.present(&off, &mut listed);
    assert_eq!(listed[0].state, "blocked");
}

#[tokio::test]
async fn ask_or_an_unlisted_host_shows_tap_to_load_and_never_refetches_by_itself() {
    let fetch = Arc::new(FakeFetch::default());
    let url = "https://i.giphy.com/ask.gif";
    let bytes = gif(12);
    fetch.serve(url, &bytes, url, None);
    let (_dir, state) = state_over(&fetch);
    let sha = sha_of(&bytes);
    let own = cached_ref(url, true, &sha, MediaProvider::Giphy);
    state.note(&owner("a", 1), 1, std::slice::from_ref(&own));
    let ask = Config {
        remote: Remote::Ask,
        ..Config::default()
    };
    let unlisted = Config {
        hosts: vec!["example.com".into()],
        ..Config::default()
    };
    let off = Config {
        remote: Remote::Off,
        ..Config::default()
    };
    // With no source link (else `off` shows the link card), off has its own reason.
    let mut unlinked = own.clone();
    unlinked.source_url = None;
    for (config, a, reason) in [
        (&ask, &own, "ask"),
        (&unlisted, &own, "host"),
        (&off, &unlinked, "off"),
    ] {
        let mut listed = vec![a.clone()];
        state.present(config, &mut listed);
        assert_eq!(listed[0].state, "pending");
        assert_eq!(listed[0].reason.as_deref(), Some(reason));
        assert!(state.read(config, a).await.is_err());
    }
    assert!(fetch.calls().is_empty(), "no automatic re-fetch");
}

#[tokio::test(start_paused = true)]
async fn reads_wait_for_the_startup_index_at_most_ready_wait_from_install() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(MediaState::new(
        dir.path().join("inbox-media"),
        Arc::new(Unreachable),
    ));
    let sha = sha_of(&gif(16));
    let start = tokio::time::Instant::now();
    assert!(state.fetch_or_cached(&sha, None, None).await.is_err());
    assert!(
        start.elapsed() >= state::READY_WAIT,
        "the first read waits out the window"
    );
    // The window has passed: later reads proceed at once, though the index never came.
    let later = tokio::time::Instant::now();
    assert!(state.fetch_or_cached(&sha, None, None).await.is_err());
    assert!(later.elapsed() < std::time::Duration::from_secs(1));
    assert!(!state.is_ready());
}

#[test]
fn before_the_startup_index_is_ready_listings_leave_cached_images_alone() {
    let dir = tempfile::tempdir().unwrap();
    let state = MediaState::new(dir.path().join("inbox-media"), Arc::new(Unreachable));
    let theirs = cached_ref(
        "https://i.giphy.com/x.gif",
        false,
        &sha_of(&gif(13)),
        MediaProvider::Giphy,
    );
    let mut plain = Attachment::empty("cat");
    plain.sha256 = Some(sha_of(&gif(14)));
    plain.state = "cached".into();
    let mut listed = vec![theirs, plain];
    state.present(&Config::default(), &mut listed);
    assert!(listed.iter().all(|a| a.state == "cached"), "{listed:?}");
    state.set_ready();
    state.present(&Config::default(), &mut listed);
    assert_eq!(listed[0].state, "pending");
    assert_eq!(listed[1].state, "failed");
}

#[test]
fn local_bytes_of_a_memory_only_sha_are_held_in_memory_never_on_disk() {
    let (_dir, state) = state_over(&Arc::new(FakeFetch::default()));
    let bytes = gif(15);
    let sha = sha_of(&bytes);
    let giphy = cached_ref(
        "https://i.giphy.com/saved.gif",
        false,
        &sha,
        MediaProvider::Giphy,
    );
    state.note(&owner("a", 1), 1, &[giphy]);
    let a = cache_local_media(bytes, "saved", &state).unwrap();
    assert_eq!(a.state, "cached");
    assert_eq!(a.media_provider, Some(MediaProvider::None));
    assert!(files(state.dir()).is_empty());
    assert!(state.memory.contains(&sha, std::time::Instant::now()));
}

#[tokio::test]
async fn concurrent_misses_on_one_sha_make_one_fetch() {
    let fetch = Arc::new(FakeFetch::default());
    let url = "https://i.giphy.com/one.gif";
    let bytes = gif(6);
    fetch.serve(url, &bytes, url, Some("no-store"));
    fetch.slow(std::time::Duration::from_millis(50));
    let (_dir, state) = state_over(&fetch);
    let sha = sha_of(&bytes);
    state.note(
        &owner("a", 1),
        1,
        &[cached_ref(url, true, &sha, MediaProvider::Giphy)],
    );
    let config = Config::default();
    let reads = (0..8).map(|_| read(&state, &config, &sha));
    for got in futures_util::future::join_all(reads).await {
        assert_eq!(got.unwrap().as_ref(), bytes.as_slice());
    }
    assert_eq!(fetch.calls().len(), 1);
}

/// A reader's path: admission from the index, then memory, disk or a re-fetch.
async fn read(
    state: &Arc<MediaState>,
    config: &Config,
    sha: &str,
) -> Result<axum::body::Bytes, String> {
    state
        .fetch_or_cached(sha, None, state.admission(config, sha).ok())
        .await
}

#[tokio::test]
async fn a_permanent_refetch_failure_is_not_retried_and_a_transient_one_once() {
    let fetch = Arc::new(FakeFetch::default());
    let (gone, flaky) = (
        "https://i.giphy.com/gone.gif",
        "https://i.giphy.com/flaky.gif",
    );
    fetch.fail(gone, failure("http"));
    fetch.fail(flaky, network("timeout"));
    let (_dir, state) = state_over(&fetch);
    let config = Config::default();
    let (gone_sha, flaky_sha) = (sha_of(&gif(7)), sha_of(&gif(8)));
    let gone_a = cached_ref(gone, true, &gone_sha, MediaProvider::Giphy);
    let flaky_a = cached_ref(flaky, true, &flaky_sha, MediaProvider::Giphy);
    state.note(&owner("a", 1), 1, std::slice::from_ref(&gone_a));
    state.note(&owner("a", 2), 2, std::slice::from_ref(&flaky_a));
    let calls = |url: &str| fetch.calls().iter().filter(|c| *c == url).count();

    for _ in 0..3 {
        assert!(read(&state, &config, &gone_sha).await.is_err());
    }
    assert_eq!(
        calls(gone),
        1,
        "a permanent failure is not retried this session"
    );
    for _ in 0..3 {
        assert!(read(&state, &config, &flaky_sha).await.is_err());
    }
    assert_eq!(
        calls(flaky),
        2,
        "a transient failure is retried once per session"
    );

    let mut listed = vec![gone_a.clone(), flaky_a];
    state.present(&config, &mut listed);
    assert_eq!(listed[0].state, "failed");
    assert_eq!(listed[0].reason.as_deref(), Some("http"));
    assert!(listed[0].retryable, "the person can retry");
    assert_eq!(listed[1].state, "failed");
    assert_eq!(listed[1].reason.as_deref(), Some("network"));
    // A tap on retry always fetches.
    state.fetch(&config, gone_a, false).await.unwrap();
    assert_eq!(calls(gone), 2);
}

#[tokio::test]
async fn a_refetch_that_hashes_differently_is_a_permanent_failure() {
    let fetch = Arc::new(FakeFetch::default());
    let url = "https://i.giphy.com/changed.gif";
    fetch.serve(url, &gif(9), url, None);
    let (_dir, state) = state_over(&fetch);
    let sha = sha_of(&gif(10));
    state.note(
        &owner("a", 1),
        1,
        &[cached_ref(url, true, &sha, MediaProvider::Giphy)],
    );
    let config = Config::default();
    assert!(read(&state, &config, &sha).await.is_err());
    assert!(read(&state, &config, &sha).await.is_err());
    assert_eq!(fetch.calls().len(), 1);
}

#[tokio::test]
async fn disk_shas_are_read_from_disk_and_never_fetched() {
    let (_dir, state) = state_over(&Arc::new(FakeFetch::default()));
    let mut local = Attachment::empty("cat");
    state.keep(gif(11), None, &mut local).unwrap();
    let sha = local.sha256.unwrap();
    assert_eq!(
        state
            .fetch_or_cached(&sha, None, None)
            .await
            .unwrap()
            .as_ref(),
        gif(11).as_slice()
    );
    std::fs::remove_file(state.dir().join(&sha)).unwrap();
    assert!(state.fetch_or_cached(&sha, None, None).await.is_err());
}

fn claim(
    url: Option<&str>,
    path: Option<&str>,
    provider: Option<MediaProvider>,
    id: Option<&str>,
) -> MediaInput {
    MediaInput {
        url: url.map(String::from),
        path: path.map(String::from),
        alt: "cat".into(),
        provider,
        provider_id: id.map(String::from),
    }
}

#[test]
fn a_provider_claim_is_paired_known_well_formed_and_on_its_own_hosts() {
    use MediaProvider::{Giphy, Klipy};
    let giphy_url = Some("https://media.giphy.com/media/abc/giphy.gif");
    let klipy_url = Some("https://static.klipy.com/a.gif");
    let refused = [
        (
            claim(giphy_url, None, Some(Giphy), None),
            ClaimError::Unpaired,
        ),
        (
            claim(giphy_url, None, None, Some("abc")),
            ClaimError::Unpaired,
        ),
        (
            claim(giphy_url, None, Some(MediaProvider::None), Some("abc")),
            ClaimError::NotAProvider,
        ),
        (
            claim(giphy_url, None, Some(Giphy), Some("bad id!")),
            ClaimError::BadId,
        ),
        (
            claim(giphy_url, None, Some(Giphy), Some(&"a".repeat(129))),
            ClaimError::BadId,
        ),
        (
            claim(klipy_url, None, Some(Giphy), Some("abc")),
            ClaimError::WrongHost,
        ),
        (
            claim(giphy_url, None, Some(Klipy), Some("abc")),
            ClaimError::WrongHost,
        ),
        (
            claim(
                Some("https://giphy.com.evil.test/a.gif"),
                None,
                Some(Giphy),
                Some("abc"),
            ),
            ClaimError::WrongHost,
        ),
        (
            claim(None, Some("cat.gif"), Some(Giphy), Some("abc")),
            ClaimError::LocalFile,
        ),
    ];
    for (input, error) in refused {
        assert_eq!(input.provider_claim(), Err(error), "{input:?}");
        assert_eq!(input.validate(), Err(error.to_string()), "{input:?}");
    }
    let good = claim(giphy_url, None, Some(Giphy), Some("abc-12_X"));
    assert_eq!(good.provider_claim(), Ok(Some((Giphy, "abc-12_X"))));
    assert!(good.validate().is_ok());
    let klipy = claim(klipy_url, None, Some(Klipy), Some("k1"));
    assert_eq!(klipy.provider_claim(), Ok(Some((Klipy, "k1"))));
    // A provider-host URL with no claim is sent, untagged.
    let bare = claim(giphy_url, None, None, None);
    assert_eq!(bare.provider_claim(), Ok(None));
    assert!(bare.validate().is_ok());
    // An unknown provider is refused when the input is read.
    let unknown = serde_json::json!({"url": giphy_url, "alt": "cat", "provider": "tenor", "providerId": "abc"});
    assert!(serde_json::from_value::<MediaInput>(unknown).is_err());
    // The wire names are camelCase, and an input with no claim serializes as before, so a
    // request id's payload hash is unchanged.
    let wire = serde_json::json!({"url": giphy_url, "alt": "cat", "provider": "giphy", "providerId": "abc"});
    let read: MediaInput = serde_json::from_value(wire).unwrap();
    assert_eq!(read.provider_claim(), Ok(Some((Giphy, "abc"))));
    assert_eq!(
        serde_json::to_value(&bare).unwrap(),
        serde_json::json!({"url": giphy_url, "path": null, "alt": "cat"})
    );
}

#[test]
fn provider_fields_round_trip_and_messages_without_them_read_unchanged() {
    let old = r#"{"kind":"image","alt":"cat","sourceUrl":"https://i.giphy.com/a.gif","sourceHost":"i.giphy.com","state":"pending","retryable":false}"#;
    let a: Attachment = serde_json::from_str(old).unwrap();
    assert_eq!(
        (a.provider, a.provider_id.as_deref(), a.onload_sent),
        (None, None, false)
    );
    assert_eq!(serde_json::to_string(&a).unwrap(), old);
    let input = claim(
        Some("https://i.giphy.com/a.gif"),
        None,
        Some(MediaProvider::Giphy),
        Some("abc"),
    );
    let mut tagged = Attachment::claimed(a.clone(), &input);
    assert_eq!(tagged.provider, Some(MediaProvider::Giphy));
    assert_eq!(tagged.provider_id.as_deref(), Some("abc"));
    tagged.onload_sent = true;
    let json = serde_json::to_string(&tagged).unwrap();
    for field in [
        r#""provider":"giphy""#,
        r#""providerId":"abc""#,
        r#""onloadSent":true"#,
    ] {
        assert!(json.contains(field), "{json}");
    }
    assert_eq!(serde_json::from_str::<Attachment>(&json).unwrap(), tagged);
    // A claim that fails its check never tags the attachment.
    let wrong = claim(
        Some("https://i.giphy.com/a.gif"),
        None,
        Some(MediaProvider::Klipy),
        Some("abc"),
    );
    assert_eq!(Attachment::claimed(a, &wrong).provider, None);
}

#[test]
fn attribution_comes_from_the_claim_then_the_final_host_then_the_url_host() {
    let with =
        |url: &str, state: &str, claim: Option<MediaProvider>, media: Option<MediaProvider>| {
            let mut a = remote(url, true);
            a.state = state.into();
            a.provider = claim;
            a.media_provider = media;
            a.attribution()
        };
    use MediaProvider::{Giphy, Klipy};
    let giphy = "https://i.giphy.com/a.gif";
    let klipy = "https://static.klipy.com/a.gif";
    let plain = "https://example.com/a.gif";
    // The claim first.
    assert_eq!(with(klipy, "cached", Some(Klipy), Some(Klipy)), Some(Klipy));
    // Then the final host: a plain URL redirected to GIPHY, a GIPHY URL redirected away.
    assert_eq!(with(plain, "cached", None, Some(Giphy)), Some(Giphy));
    assert_eq!(with(giphy, "cached", None, Some(MediaProvider::None)), None);
    // Never fetched (pending, blocked) or an old message: the URL's host.
    for state in ["pending", "blocked", "failed", "cached"] {
        assert_eq!(with(giphy, state, None, None), Some(Giphy), "{state}");
        assert_eq!(
            with(giphy, state, Some(Giphy), None),
            Some(Giphy),
            "{state}"
        );
    }
    assert_eq!(with(klipy, "pending", None, None), Some(Klipy));
    assert_eq!(with(plain, "cached", None, None), None);
    assert_eq!(with(plain, "cached", None, Some(MediaProvider::None)), None);
}

#[tokio::test]
async fn a_tagged_url_redirected_off_its_provider_loses_its_tag() {
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    let port = server.address().port();
    Mock::given(path("/away"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("http://example.test:{port}/plain")),
        )
        .mount(&server)
        .await;
    Mock::given(path("/plain"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(gif(7)))
        .mount(&server)
        .await;
    Mock::given(path("/stays"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(gif(8)))
        .mount(&server)
        .await;
    let client = client_builder(&Config::default())
        .redirect(reqwest::redirect::Policy::limited(3))
        .resolve("i.giphy.com", *server.address())
        .resolve("example.test", *server.address())
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let state = MediaState::for_test(dir.path().join("inbox-media"), Arc::new(Local(client)));
    let tagged = |path: &str| {
        let url = format!("http://i.giphy.com:{port}{path}");
        let mut a = Attachment::empty("cat");
        a.source_host = Some("i.giphy.com".into());
        a.source_url = Some(url);
        a.own_sender = true;
        a.provider = Some(MediaProvider::Giphy);
        a.provider_id = Some("abc".into());
        a
    };
    let config = Config::default();
    let away = state.fetch(&config, tagged("/away"), false).await.unwrap();
    assert_eq!(away.state, "cached");
    assert_eq!(away.media_provider, Some(MediaProvider::None));
    assert_eq!((away.provider, away.provider_id.as_deref()), (None, None));
    assert_eq!(
        away.attribution(),
        None,
        "attribution follows the final host"
    );
    let stays = state.fetch(&config, tagged("/stays"), false).await.unwrap();
    assert_eq!(stays.media_provider, Some(MediaProvider::Giphy));
    assert_eq!(stays.provider, Some(MediaProvider::Giphy));
    assert_eq!(stays.provider_id.as_deref(), Some("abc"));
}

#[tokio::test]
async fn every_serve_is_told_to_the_serve_hook_and_a_failed_read_is_not() {
    let fetch = Arc::new(FakeFetch::default());
    let url = "https://i.giphy.com/served.gif";
    fetch.serve(url, &gif(9), url, None);
    let (_dir, state) = state_over(&fetch);
    let served = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = served.clone();
    state.when_served(Arc::new(move |sha: &str| {
        seen.lock().unwrap().push(sha.to_string())
    }));
    let config = Config::default();
    let a = state
        .fetch(&config, remote(url, true), false)
        .await
        .unwrap();
    let sha = a.sha256.clone().unwrap();
    state.note(&owner("a", 1), 1, std::slice::from_ref(&a));
    for _ in 0..2 {
        assert!(state.read(&config, &a).await.is_ok());
    }
    assert_eq!(*served.lock().unwrap(), vec![sha.clone(), sha]);
    // Bytes that can't be read are not a serve.
    let mut gone = remote("https://i.giphy.com/gone.gif", false);
    gone.sha256 = Some(sha_of(b"never fetched"));
    gone.state = "cached".into();
    assert!(state.read(&config, &gone).await.is_err());
    assert_eq!(served.lock().unwrap().len(), 2);
}

// ---- GIF picker stills (media::preview) ----

/// Stills from memory, counting every fetch.
#[derive(Default)]
struct Stills {
    calls: std::sync::Mutex<Vec<String>>,
    bytes: Vec<u8>,
}
impl preview::PreviewFetch for Stills {
    fn get<'a>(
        &'a self,
        url: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<Vec<u8>, Failure>> {
        self.calls.lock().unwrap().push(url.to_string());
        Box::pin(async move { Ok(self.bytes.clone()) })
    }
}

#[tokio::test]
async fn preview_refuses_private_ip_and_non_provider_host() {
    let stills = Stills {
        bytes: gif(1),
        ..Default::default()
    };
    for url in [
        "https://example.com/still.gif",
        "https://giphy.com.example.net/still.gif",
        "http://media.giphy.com/still.gif",
        format!("https://{}@media.giphy.com/still.gif", "user").as_str(),
        "https://127.0.0.1/still.gif",
    ] {
        let error = preview::preview(&stills, GIPHY_HOSTS, url)
            .await
            .unwrap_err();
        assert_eq!(error.reason, "host", "{url}");
    }
    // A literal private address is refused even where the host list names it.
    let private: [std::net::IpAddr; 3] = [
        std::net::Ipv4Addr::LOCALHOST.into(),
        std::net::Ipv4Addr::new(10, 0, 0, 1).into(),
        std::net::Ipv6Addr::LOCALHOST.into(),
    ];
    for ip in private {
        let host = match ip {
            std::net::IpAddr::V4(v4) => v4.to_string(),
            std::net::IpAddr::V6(v6) => format!("[{v6}]"),
        };
        let url = format!("https://{host}/still.gif");
        let error = preview::preview(&stills, &[host.as_str()], &url)
            .await
            .unwrap_err();
        assert_eq!(error.reason, "address", "{url}");
    }
    assert!(stills.calls.lock().unwrap().is_empty(), "no fetch was made");
    // A name that resolves to a private address is refused by the still client's resolver.
    let http = preview::Http::new().unwrap();
    let error = preview::preview(&http, &["localhost"], "https://localhost:1/still.gif")
        .await
        .unwrap_err();
    assert_eq!(error.reason, "address");
    // A provider still comes back as a data: URI.
    let data = preview::preview(
        &stills,
        GIPHY_HOSTS,
        "https://media1.giphy.com/m/200w_s.gif",
    )
    .await
    .unwrap();
    assert!(data.starts_with("data:image/gif;base64,"), "{data}");
}

#[tokio::test]
async fn preview_refuses_a_redirect_off_the_provider_host() {
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    let port = server.address().port();
    let redirect = |to: String| ResponseTemplate::new(302).insert_header("location", to);
    Mock::given(path("/off-host"))
        .respond_with(redirect("https://example.com/still.gif".into()))
        .mount(&server)
        .await;
    Mock::given(path("/lookalike"))
        .respond_with(redirect("https://giphy.com.example.net/still.gif".into()))
        .mount(&server)
        .await;
    Mock::given(path("/other-provider"))
        .respond_with(redirect("https://static.klipy.com/still.gif".into()))
        .mount(&server)
        .await;
    Mock::given(path("/private"))
        .respond_with(redirect("https://127.0.0.1/still.gif".into()))
        .mount(&server)
        .await;
    Mock::given(path("/plain-http"))
        .respond_with(redirect(format!("http://media.giphy.com:{port}/still")))
        .mount(&server)
        .await;
    Mock::given(path("/still"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(gif(1)))
        .mount(&server)
        .await;
    // The fixture serves plain HTTP on GIPHY's name; production also sets `https_only`.
    let client = preview::client_builder()
        .resolve("media.giphy.com", *server.address())
        .build()
        .unwrap();
    for hop in [
        "off-host",
        "lookalike",
        "other-provider",
        "private",
        "plain-http",
    ] {
        let error = preview::read(&client, &format!("http://media.giphy.com:{port}/{hop}"))
            .await
            .unwrap_err();
        assert_eq!(error.reason, "redirect", "{hop}");
    }
    let still = preview::read(&client, &format!("http://media.giphy.com:{port}/still"))
        .await
        .unwrap();
    assert_eq!(still, gif(1));
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 6, "no refused hop was requested");
    for request in &requests {
        assert!(request.headers.get("cookie").is_none());
        assert!(request.headers.get("referer").is_none());
    }
}

#[tokio::test]
async fn preview_stops_reading_past_256_kb() {
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(path("/large"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0; preview::MAX_BYTES + 1]))
        .mount(&server)
        .await;
    Mock::given(path("/fits"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0; preview::MAX_BYTES]))
        .mount(&server)
        .await;
    let client = preview::client_builder().build().unwrap();
    let large = preview::read(&client, &format!("{}/large", server.uri())).await;
    assert_eq!(large.unwrap_err().reason, "size");
    let fits = preview::read(&client, &format!("{}/fits", server.uri())).await;
    assert_eq!(fits.unwrap().len(), preview::MAX_BYTES);
    // A body with no length stops once it passes the cap, rather than reading it all.
    use axum::{body::Body, routing::get, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/",
        get(|| async {
            Body::from_stream(futures_util::stream::iter(
                (0..64).map(|_| Ok::<_, std::io::Error>(vec![0; 64 * 1024])),
            ))
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let streamed = preview::read(&client, &format!("http://{address}/")).await;
    assert_eq!(streamed.unwrap_err().reason, "size");
    task.abort();
}

#[tokio::test]
async fn preview_bytes_never_reach_memory_store_or_disk() {
    let fetch = Arc::new(FakeFetch::default());
    let (_dir, state) = state_over(&fetch);
    let bytes = gif(7);
    let stills = Stills {
        bytes: bytes.clone(),
        ..Default::default()
    };
    let urls = [
        "https://media1.giphy.com/m/a/200w_s.gif",
        "https://media1.giphy.com/m/b/200w_s.gif",
    ];
    let data = preview::previews(&stills, GIPHY_HOSTS, &urls, preview::DEADLINE).await;
    assert!(data.iter().all(Option::is_some));
    let sha = sha_of(&bytes);
    assert!(files(state.dir()).is_empty(), "nothing under the cache dir");
    assert!(!state.memory.contains(&sha, std::time::Instant::now()));
    assert_eq!(state.memory.total(), 0);
    assert!(
        state.index.references(&sha).is_empty(),
        "no sha index entry"
    );
    assert!(
        state.index.provider_shas().is_empty(),
        "nothing for the purge to find"
    );
    assert!(fetch.calls().is_empty(), "the inbox fetcher is never used");
}

#[tokio::test]
async fn previews_take_at_most_ten_stills_in_order() {
    let stills = Stills {
        bytes: gif(1),
        ..Default::default()
    };
    let urls: Vec<String> = (0..12)
        .map(|n| format!("https://media1.giphy.com/m/{n}/200w_s.gif"))
        .collect();
    let urls: Vec<&str> = urls.iter().map(String::as_str).collect();
    let data = preview::previews(&stills, GIPHY_HOSTS, &urls, preview::DEADLINE).await;
    assert_eq!(data.len(), 12);
    assert!(data[..10].iter().all(Option::is_some));
    assert!(data[10..].iter().all(Option::is_none));
    assert_eq!(*stills.calls.lock().unwrap(), urls[..10]);
}
