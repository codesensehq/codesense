// SPDX-License-Identifier: MIT
//! One index from image sha256 to every message attachment that references it, across
//! every synced team. Listing, the media route, hosted media and the app window read
//! it for a sha's source URL, re-fetch admission and memory-only status, so they agree
//! whichever team is viewed. It holds no bytes.
use super::{Attachment, MediaProvider};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

/// The message an attachment belongs to: org, team and message id.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Owner {
    pub org: String,
    pub team: String,
    pub message_id: i64,
}

/// One attachment's reference to a sha.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub url: Option<String>,
    pub own_sender: bool,
    pub media_provider: Option<MediaProvider>,
    pub source_host: Option<String>,
    /// When the reference was made (ms), so the newest comes first.
    pub at: i64,
    owner: Owner,
}

impl Reference {
    fn new(owner: &Owner, at: i64, a: &Attachment) -> Self {
        Self {
            url: a.source_url.clone(),
            own_sender: a.own_sender,
            media_provider: a.media_provider,
            source_host: a.source_host.clone(),
            at,
            owner: owner.clone(),
        }
    }
    /// A provider reference: `mediaProvider` says so, or (an old message only, with no
    /// `mediaProvider`) its source host is a provider host.
    pub fn is_provider(&self) -> bool {
        match self.media_provider {
            Some(provider) => provider.is_provider(),
            None => self
                .source_host
                .as_deref()
                .is_some_and(|h| MediaProvider::of_host(h).is_provider()),
        }
    }
    fn url_is_provider(&self) -> bool {
        self.url
            .as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .and_then(|u| u.host_str().map(MediaProvider::of_host))
            .is_some_and(MediaProvider::is_provider)
    }
}

#[derive(Default)]
struct Inner {
    by_sha: HashMap<String, Vec<Reference>>,
    by_owner: HashMap<Owner, Vec<String>>,
    teams: HashSet<(String, String)>,
}

impl Inner {
    fn forget(&mut self, owner: &Owner) {
        for sha in self.by_owner.remove(owner).unwrap_or_default() {
            if let Some(refs) = self.by_sha.get_mut(&sha) {
                refs.retain(|r| &r.owner != owner);
                if refs.is_empty() {
                    self.by_sha.remove(&sha);
                }
            }
        }
    }
    fn memory_only(&self, sha: &str) -> bool {
        self.by_sha
            .get(sha)
            .is_some_and(|refs| refs.iter().any(Reference::is_provider))
    }
}

#[derive(Default)]
pub struct ShaIndex {
    inner: Mutex<Inner>,
}

impl ShaIndex {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replace `owner`'s references with those of its `attachments` that carry a sha.
    /// Returns the shas among them that are memory-only afterwards.
    pub fn set_message(&self, owner: &Owner, at: i64, attachments: &[Attachment]) -> Vec<String> {
        let mut inner = self.lock();
        inner.forget(owner);
        let mut shas = Vec::new();
        for a in attachments {
            let Some(sha) = a.sha256.clone() else {
                continue;
            };
            let refs = inner.by_sha.entry(sha.clone()).or_default();
            let at_index = refs.partition_point(|r| r.at >= at);
            refs.insert(at_index, Reference::new(owner, at, a));
            if !shas.contains(&sha) {
                shas.push(sha);
            }
        }
        if !shas.is_empty() {
            inner.by_owner.insert(owner.clone(), shas.clone());
        }
        shas.retain(|sha| inner.memory_only(sha));
        shas
    }

    /// Mark a team indexed.
    pub fn mark_team(&self, org: &str, team: &str) {
        self.lock().teams.insert((org.into(), team.into()));
    }

    pub fn is_team_indexed(&self, org: &str, team: &str) -> bool {
        self.lock().teams.contains(&(org.into(), team.into()))
    }

    /// Whether any reference to `sha` is provider media: then every attachment that
    /// references it is served from memory and never written to disk.
    pub fn is_memory_only(&self, sha: &str) -> bool {
        self.lock().memory_only(sha)
    }

    /// The URL an automatic re-fetch of `sha` may use: the newest one whose own
    /// attachment was sent from this machine, preferring a provider-host URL for a
    /// provider sha. A remote sender's URL is never returned.
    pub fn refetch_url(&self, sha: &str) -> Option<String> {
        let inner = self.lock();
        let refs = inner.by_sha.get(sha)?;
        let own = || refs.iter().filter(|r| r.own_sender && r.url.is_some());
        let provider = refs.iter().any(Reference::is_provider);
        provider
            .then(|| own().find(|r| r.url_is_provider()))
            .flatten()
            .or_else(|| own().next())
            .and_then(|r| r.url.clone())
    }

    /// Every sha with a provider reference.
    pub fn provider_shas(&self) -> Vec<String> {
        let inner = self.lock();
        inner
            .by_sha
            .keys()
            .filter(|sha| inner.memory_only(sha))
            .cloned()
            .collect()
    }

    /// The references to `sha`, newest first.
    #[cfg(test)]
    pub fn references(&self, sha: &str) -> Vec<Reference> {
        self.lock().by_sha.get(sha).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(team: &str, id: i64) -> Owner {
        Owner {
            org: "acme".into(),
            team: team.into(),
            message_id: id,
        }
    }

    fn image(
        sha: &str,
        url: Option<&str>,
        own: bool,
        provider: Option<MediaProvider>,
    ) -> Attachment {
        let mut a = Attachment::empty("cat");
        a.sha256 = Some(sha.into());
        a.state = "cached".into();
        a.source_url = url.map(String::from);
        a.source_host = url.and_then(|u| url::Url::parse(u).ok()?.host_str().map(String::from));
        a.own_sender = own;
        a.media_provider = provider;
        a
    }

    #[test]
    fn one_provider_reference_makes_a_sha_memory_only_across_teams() {
        let index = ShaIndex::default();
        let plain = image(
            "s",
            Some("https://example.com/a.gif"),
            true,
            Some(MediaProvider::None),
        );
        assert!(index.set_message(&owner("a", 1), 1, &[plain]).is_empty());
        assert!(!index.is_memory_only("s"));
        let giphy = image(
            "s",
            Some("https://i.giphy.com/a.gif"),
            false,
            Some(MediaProvider::Giphy),
        );
        assert_eq!(
            index.set_message(&owner("b", 1), 2, &[giphy]),
            vec!["s".to_string()]
        );
        assert!(index.is_memory_only("s"));
        // Replacing the message drops its old reference.
        index.set_message(&owner("b", 1), 3, &[]);
        assert!(!index.is_memory_only("s"));
    }

    #[test]
    fn a_missing_media_provider_falls_back_to_the_source_host_only_for_old_messages() {
        let index = ShaIndex::default();
        index.set_message(
            &owner("a", 1),
            1,
            &[image(
                "old",
                Some("https://media.giphy.com/x.gif"),
                false,
                None,
            )],
        );
        assert!(index.is_memory_only("old"));
        // Written after the upgrade: `none` wins over a provider source host (a redirect away).
        index.set_message(
            &owner("a", 2),
            1,
            &[image(
                "new",
                Some("https://i.giphy.com/x.gif"),
                true,
                Some(MediaProvider::None),
            )],
        );
        assert!(!index.is_memory_only("new"));
    }

    #[test]
    fn the_refetch_url_is_the_newest_own_sender_url_preferring_a_provider_host() {
        let index = ShaIndex::default();
        let remote = image(
            "s",
            Some("https://i.giphy.com/remote.gif"),
            false,
            Some(MediaProvider::Giphy),
        );
        index.set_message(&owner("a", 1), 30, &[remote]);
        assert_eq!(
            index.refetch_url("s"),
            None,
            "a remote sender's URL is never automatic"
        );
        let own_plain = image(
            "s",
            Some("https://example.com/own.gif"),
            true,
            Some(MediaProvider::Giphy),
        );
        index.set_message(&owner("a", 2), 20, &[own_plain]);
        assert_eq!(
            index.refetch_url("s").as_deref(),
            Some("https://example.com/own.gif")
        );
        let own_giphy = image(
            "s",
            Some("https://media.giphy.com/own.gif"),
            true,
            Some(MediaProvider::Giphy),
        );
        index.set_message(&owner("b", 3), 10, &[own_giphy]);
        assert_eq!(
            index.refetch_url("s").as_deref(),
            Some("https://media.giphy.com/own.gif")
        );
        let refs = index.references("s");
        assert!(refs.windows(2).all(|w| w[0].at >= w[1].at), "newest first");
    }

    #[test]
    fn teams_are_tracked_once_indexed() {
        let index = ShaIndex::default();
        assert!(!index.is_team_indexed("acme", "a"));
        index.mark_team("acme", "a");
        assert!(index.is_team_indexed("acme", "a"));
    }
}
