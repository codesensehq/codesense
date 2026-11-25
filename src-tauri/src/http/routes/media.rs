// SPDX-License-Identifier: MIT
use crate::{commands::agent_inbox::AppInboxHost, http::AppState};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Router,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/media/v1/{sha256}", get(serve))
}

async fn serve(
    State(state): State<AppState>,
    frame: Option<Extension<crate::dashboard_stream::frame::FrameRecord>>,
    Path(sha): Path<String>,
) -> Response {
    // The frame boundary has already admitted this request for its frame: a
    // same-origin asset request (such as this `<img>`) by its frame host, since
    // WebKit sends no SameSite cookie from a cross-site embed; anything else only
    // with the frame's token. Grant and visibility below bind to that frame.
    let Some(Extension(frame)) = frame else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !inbox_granted(&frame) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let host = AppInboxHost::port(state.app_handle.clone());
    let teams =
        if crate::verbs::check_frame_capability(&frame, "inboxRollup", &serde_json::json!({}))
            .is_ok()
        {
            host.synced_teams().await.unwrap_or_default()
        } else {
            frame
                .grant
                .team
                .iter()
                .map(|t| crate::commands::dashboard_launch::LaunchTeam {
                    org: t.org.clone(),
                    team: t.team.clone(),
                })
                .collect()
        };
    let mut allowed = None;
    for team in teams {
        if let Ok(view) = crate::commands::agent_inbox::list_messages_unbounded(
            &*host,
            &team,
            crate::commands::agent_inbox::InboxScope::All,
            None,
            &[],
        )
        .await
        {
            if let Some(attachment) = view
                .messages
                .iter()
                .find_map(|m| crate::media::cached_attachment(&m.attachments, &sha))
            {
                allowed = Some((team, attachment.clone()));
                break;
            }
        }
    }
    let Some((team, attachment)) = allowed else {
        return StatusCode::FORBIDDEN.into_response();
    };
    // Authorized: the bytes come from memory or the disk cache, or are fetched again
    // under the config of the team that carries the image.
    let Some(media) = crate::media::app_state(&state.app_handle) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The team is indexed before its media is served.
    crate::media::index_new_teams(&media, &*host, std::slice::from_ref(&team)).await;
    respond(&media, &host.media_config(&team), &attachment).await
}

/// The authorized image `attachment`: from memory or the disk cache, or fetched again
/// when the config of the team that carries it admits a re-fetch.
pub(crate) async fn respond(
    media: &std::sync::Arc<crate::media::MediaState>,
    config: &crate::media::Config,
    attachment: &crate::media::Attachment,
) -> Response {
    let sha = attachment.sha256.as_deref().unwrap_or_default();
    match media.read(config, attachment).await {
        Ok(bytes) => image_response(bytes, media.is_memory_only(sha, Some(attachment))),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn inbox_granted(frame: &crate::dashboard_stream::frame::FrameRecord) -> bool {
    crate::verbs::check_frame_capability(frame, "inbox", &serde_json::json!({})).is_ok()
}
/// The image, typed by its bytes. A memory-only (provider) sha is `no-store`, so the
/// WebView's HTTP cache never writes it to disk; any other sha is immutable by hash.
fn image_response(bytes: impl Into<axum::body::Bytes>, memory_only: bool) -> Response {
    let bytes = bytes.into();
    let cache = if memory_only {
        "no-store"
    } else {
        "private, max-age=31536000, immutable"
    };
    match crate::media::inspect(&bytes) {
        Ok((mime, _, _)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CACHE_CONTROL, cache),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard_stream::frame::{FrameCallerKind, FrameGrant, FramePolicy, FrameStore};
    #[tokio::test]
    async fn media_bytes_require_inbox_read_and_serve_verified_type_and_cache_headers() {
        let frames = FrameStore::default();
        let grant = FrameGrant {
            frame_id: String::new(),
            principal: "human".into(),
            dashboard: "inbox".into(),
            slot: "right-pane".into(),
            team: None,
            scope: "open".into(),
        };
        let mut frame = frames.mint_with_grant(
            9321,
            grant,
            "/ctx".into(),
            "builtin:inbox".into(),
            "/ctx".into(),
            FramePolicy::default(),
            None,
            vec!["context:read".into()],
            FrameCallerKind::Builtin,
        );
        assert!(!inbox_granted(&frame));
        frame.effective_grant = vec!["inbox:read:team".into()];
        assert!(inbox_granted(&frame));
        let response = image_response(b"GIF89a\x02\x00\x03\x00".to_vec(), false);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/gif");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert!(response.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable"));
        assert_eq!(
            image_response(b"<svg/>".to_vec(), false).status(),
            StatusCode::NOT_FOUND
        );
    }

    fn image(
        url: &str,
        own: bool,
        sha: &str,
        provider: crate::media::MediaProvider,
    ) -> crate::media::Attachment {
        let mut a =
            crate::media::Attachment::remote(url, "cat", &crate::media::Config::default(), own)
                .unwrap();
        a.sha256 = Some(sha.into());
        a.state = "cached".into();
        a.media_provider = Some(provider);
        a
    }

    fn cache_control(response: &Response) -> String {
        response.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn provider_shas_are_no_store_and_disk_shas_stay_immutable() {
        use crate::media::{Config, FakeFetch, MediaProvider, MediaState};
        use sha2::Digest as _;
        let gif = |n: u8| [b"GIF89a\x02\x00\x03\x00".as_slice(), &[n][..]].concat();
        let sha = |bytes: &[u8]| format!("{:x}", sha2::Sha256::digest(bytes));
        let fetch = std::sync::Arc::new(FakeFetch::default());
        let dir = tempfile::tempdir().unwrap();
        let media = MediaState::for_test(dir.path().join("inbox-media"), fetch.clone());
        // Every serve the route makes reaches the serve hook (the provider view pings).
        let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = served.clone();
        media.when_served(std::sync::Arc::new(move |_: &str| {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        let config = Config {
            hosts: vec!["*.giphy.com".into(), "example.com".into()],
            ..Config::default()
        };
        let owner = |id| crate::media::index::Owner {
            org: "acme".into(),
            team: "a".into(),
            message_id: id,
            chat: None,
        };

        // Sent from GIPHY by this machine: after a restart the route fetches it again
        // and serves it from memory, `no-store`.
        let giphy = "https://i.giphy.com/a.gif";
        fetch.serve(giphy, &gif(1), giphy, None);
        let direct = image(giphy, true, &sha(&gif(1)), MediaProvider::Giphy);
        media.note(&owner(1), 1, std::slice::from_ref(&direct));
        let response = respond(&media, &config, &direct).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(cache_control(&response), "no-store");
        assert_eq!(fetch.calls(), vec![giphy.to_string()]);
        assert_eq!(
            served.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a re-fetch is a serve"
        );

        // Reached GIPHY through a redirect: its `mediaProvider` is giphy, so `no-store` too.
        let plain = "https://example.com/b.gif";
        fetch.serve(plain, &gif(2), "https://media.giphy.com/b.gif", None);
        let fetched = media
            .fetch(
                &config,
                crate::media::Attachment::remote(plain, "cat", &config, true).unwrap(),
                true,
            )
            .await
            .unwrap();
        assert_eq!(fetched.media_provider, Some(MediaProvider::Giphy));
        media.note(&owner(2), 2, std::slice::from_ref(&fetched));
        let response = respond(&media, &config, &fetched).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(cache_control(&response), "no-store");
        // The attachment's own fields count before the index has it.
        let mut unindexed = fetched.clone();
        unindexed.source_url = Some("https://example.com/unindexed.gif".into());
        let fresh = MediaState::for_test(dir.path().join("other-cache"), fetch.clone());
        assert!(fresh.is_memory_only(fetched.sha256.as_deref().unwrap(), Some(&unindexed)));

        // Anything else is on disk and immutable by hash.
        let other = "https://example.com/c.gif";
        fetch.serve(other, &gif(3), other, None);
        let fetched = media
            .fetch(
                &config,
                crate::media::Attachment::remote(other, "cat", &config, true).unwrap(),
                true,
            )
            .await
            .unwrap();
        media.note(&owner(3), 3, std::slice::from_ref(&fetched));
        assert!(media
            .dir()
            .join(fetched.sha256.as_deref().unwrap())
            .is_file());
        let response = respond(&media, &config, &fetched).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!cache_control(&response).contains("no-store"));
        assert!(cache_control(&response).contains("immutable"));
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 3);
    }
}
