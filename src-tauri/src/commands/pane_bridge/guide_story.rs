// SPDX-License-Identifier: MIT
//! The setup page's one extra `codesense.openFile`: a story file it just created, read-only.
//!
//! A page's open normally runs in its own content root's scope, which for the setup page is
//! the docs team, so a story in the person's own team is out of reach. The page whose bytes
//! match its pin in the page list (see `foreman_launch::is_guide_page`) gets this narrow route
//! instead. It checks its own conditions and never asks the caller scope, so it neither
//! depends on nor widens what that scope admits. Every refusal is the same "File not found",
//! so a refused path looks like a missing one.

use std::ffi::OsStr;
use std::path::{Component, Path};

use crate::context_query::index::IndexRoot;
use crate::context_query::model::Layer;
use crate::context_repo::caller_scope::MISSING;

use super::{path_str, OpenTarget};

const STORIES: &str = "stories";

/// An existing `.md` file under `stories/` of a synced team's content root, named by an
/// absolute path with no `.` or `..`. `team` is refused: the path alone says where it is.
pub(crate) fn resolve(
    roots: &[IndexRoot],
    path: &str,
    team: Option<&str>,
) -> Result<OpenTarget, String> {
    let refused = || String::from(MISSING);
    let file = Path::new(path.trim());
    if team.is_some()
        || !file.is_absolute()
        || file.extension() != Some(OsStr::new("md"))
        || file
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(refused());
    }
    let root = roots
        .iter()
        .filter(|root| root.layer == Layer::Team && file.starts_with(&root.dir))
        .max_by_key(|root| root.dir.components().count())
        .ok_or_else(refused)?;
    let (Some(org), Some(team)) = (root.org.clone(), root.team.clone()) else {
        return Err(refused());
    };
    // Under `stories/`, at least one name deep, through plain names only.
    let inside: Vec<_> = file
        .strip_prefix(&root.dir)
        .map_err(|_| refused())?
        .components()
        .collect();
    if inside.len() < 2
        || inside[0] != Component::Normal(OsStr::new(STORIES))
        || !inside
            .iter()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(refused());
    }
    // The real file must sit in the real `stories/` folder, and that folder in the real root, so
    // no link on the way out of either is followed.
    let real_root = std::fs::canonicalize(&root.dir).map_err(|_| refused())?;
    let real_stories = std::fs::canonicalize(root.dir.join(STORIES)).map_err(|_| refused())?;
    let real = std::fs::canonicalize(file).map_err(|_| refused())?;
    if !real_stories.starts_with(&real_root) || !real.starts_with(&real_stories) || !real.is_file()
    {
        return Err(refused());
    }
    Ok(OpenTarget {
        path: path_str(file),
        org,
        team,
        content_root: path_str(&root.dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_query::index::IndexRoot;
    use crate::context_query::model::Layer;
    use crate::context_repo::caller_scope::tests::Fixture;
    use crate::context_repo::caller_scope::CallerScope;
    use crate::verbs::foreman_launch::{self, Page, GUIDE_PAGE};
    use sha2::{Digest, Sha256};
    use std::path::{Path, PathBuf};

    const GUIDE_BYTES: &[u8] = b"<!doctype html><title>Guide</title>";
    const STORY: &str = "stories/e/S-1.md";

    /// The person's synced teams (`parent` is one whose files the `child` scope does not
    /// admit, as a scope that admits no other org's path would not), a second synced org, an
    /// org that is on disk but not synced, and a docs checkout holding the pinned guide.
    struct Fx {
        f: Fixture,
        docs: PathBuf,
        team: PathBuf,
        roots: Vec<IndexRoot>,
        pages: Vec<Page>,
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn pin(path: &'static str, bytes: &[u8]) -> Page {
        Page {
            path,
            sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        }
    }

    fn fx() -> Fx {
        let f = Fixture::new();
        let base = f.temp.path().canonicalize().unwrap();
        let docs = base.join("docs");
        write(&docs.join(GUIDE_PAGE), GUIDE_BYTES);
        let team = f.path("parent", "content");
        let globex = base.join("orgs/globex/ctx/web/content");
        let unsynced = base.join("orgs/unsynced/ctx/web/content");
        for content in [&team, &globex, &unsynced] {
            write(&content.join(STORY), b"---\ntype: story\n---\n");
        }
        write(&team.join("README.md"), b"readme");
        write(&base.join("elsewhere/secret.md"), b"secret");
        let extra = |dir: PathBuf, org: &str, team: &str| IndexRoot {
            dir,
            org: Some(org.into()),
            team: Some(team.into()),
            layer: Layer::Team,
        };
        let mut roots = f.roots();
        roots.push(extra(globex, "globex/ctx", "web"));
        roots.push(extra(
            docs.join("getting-started/content"),
            "codesense/docs",
            "getting-started",
        ));
        Fx {
            pages: vec![pin(GUIDE_PAGE, GUIDE_BYTES)],
            f,
            docs,
            team,
            roots,
        }
    }

    fn lossy(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn base(fx: &Fx) -> PathBuf {
        fx.f.temp.path().canonicalize().unwrap()
    }

    /// `openFile` from the page at `document`, as the bridge resolves it: is it the pinned
    /// guide, then the grant or the scoped route, under the scope of a team that does not
    /// admit the person's other teams.
    fn open(fx: &Fx, document: &Path, path: &str) -> Result<OpenTarget, String> {
        let guide = foreman_launch::is_guide_page_in(&fx.pages, &fx.docs, &lossy(document));
        super::super::resolve_open_target_granted(
            guide,
            &fx.roots,
            &lossy(document),
            path,
            None,
            &fx.f.scope,
        )
    }

    fn guide_open(fx: &Fx, path: &str) -> Result<OpenTarget, String> {
        open(fx, &fx.docs.join(GUIDE_PAGE), path)
    }

    fn story(fx: &Fx) -> String {
        lossy(&fx.team.join(STORY))
    }

    #[test]
    fn the_pinned_guide_opens_a_story_in_a_synced_team() {
        let fx = fx();
        let target = guide_open(&fx, &story(&fx)).unwrap();
        assert_eq!(target.path, story(&fx));
        assert_eq!(
            (target.org.as_str(), target.team.as_str()),
            ("acme/ctx", "parent")
        );
        assert_eq!(target.content_root, lossy(&fx.team));
        // Another synced org's team is the person's own too.
        let other = lossy(&base(&fx).join("orgs/globex/ctx/web/content").join(STORY));
        assert_eq!(guide_open(&fx, &other).unwrap().org, "globex/ctx");
    }

    #[test]
    fn any_other_docs_page_is_refused() {
        let fx = fx();
        assert!(guide_open(&fx, &story(&fx)).is_ok());
        // The guide's bytes at another place in the docs checkout.
        let elsewhere = fx.docs.join("getting-started/content/other/index.html");
        write(&elsewhere, GUIDE_BYTES);
        assert_eq!(open(&fx, &elsewhere, &story(&fx)).unwrap_err(), MISSING);
        // One more byte at the guide's own place.
        let guide = fx.docs.join(GUIDE_PAGE);
        write(&guide, &[GUIDE_BYTES, b" "].concat());
        assert_eq!(open(&fx, &guide, &story(&fx)).unwrap_err(), MISSING);
        // A page that holds another pin (the Foreman page) is not the guide.
        let mut fx = fx;
        let foreman = pin("getting-started/content/foreman/index.html", b"foreman");
        let page = fx.docs.join(foreman.path);
        write(&page, b"foreman");
        fx.pages.push(foreman);
        assert_eq!(open(&fx, &page, &story(&fx)).unwrap_err(), MISSING);
        // A page outside the docs checkout, and a frame with no document at all.
        let outside = base(&fx).join("elsewhere/page.html");
        write(&outside, GUIDE_BYTES);
        assert_eq!(open(&fx, &outside, &story(&fx)).unwrap_err(), MISSING);
        assert_eq!(open(&fx, Path::new(""), &story(&fx)).unwrap_err(), MISSING);
    }

    #[test]
    fn a_path_outside_stories_in_the_same_team_is_refused() {
        let fx = fx();
        assert!(guide_open(&fx, &story(&fx)).is_ok());
        write(&fx.team.join("storiesx/e/S-2.md"), b"x");
        write(&fx.team.join("e/stories/S-3.md"), b"x");
        write(&fx.team.join("stories/e/notes.txt"), b"x");
        for path in [
            "README.md",
            "storiesx/e/S-2.md",
            "e/stories/S-3.md",
            "stories/e/notes.txt",
            "stories",
            "stories/e",
        ] {
            let path = lossy(&fx.team.join(path));
            assert_eq!(guide_open(&fx, &path).unwrap_err(), MISSING, "{path}");
        }
        // The content root itself, and a relative path, name no story.
        assert_eq!(guide_open(&fx, &lossy(&fx.team)).unwrap_err(), MISSING);
        assert_eq!(guide_open(&fx, STORY).unwrap_err(), MISSING);
        // A story named with a team is refused: the grant takes the path alone.
        assert_eq!(
            resolve(&fx.roots, &story(&fx), Some("parent")).unwrap_err(),
            MISSING
        );
    }

    #[test]
    fn an_org_that_is_not_synced_is_refused() {
        let fx = fx();
        assert!(guide_open(&fx, &story(&fx)).is_ok());
        let unsynced = lossy(&base(&fx).join("orgs/unsynced/ctx/web/content").join(STORY));
        assert!(Path::new(&unsynced).is_file());
        assert_eq!(guide_open(&fx, &unsynced).unwrap_err(), MISSING);
        // Private space is not a team's stories either, and neither is a root with no team.
        let at = fx.roots.iter().position(|r| r.dir == fx.team).unwrap();
        let mut roots = fx.roots.clone();
        roots[at].layer = Layer::Private;
        assert_eq!(resolve(&roots, &story(&fx), None).unwrap_err(), MISSING);
        roots[at].layer = Layer::Team;
        roots[at].team = None;
        assert_eq!(resolve(&roots, &story(&fx), None).unwrap_err(), MISSING);
    }

    #[test]
    fn a_dot_dot_escape_is_refused() {
        let fx = fx();
        assert!(guide_open(&fx, &story(&fx)).is_ok());
        let out = lossy(
            &fx.team
                .join("stories/../../../../../../../elsewhere/secret.md"),
        );
        assert!(Path::new(&out).is_file(), "the escape reaches a real file");
        for path in [
            out,
            lossy(&fx.team.join("stories/e/../../README.md")),
            lossy(&fx.team.join("stories/../stories/e/S-1.md")),
        ] {
            assert_eq!(guide_open(&fx, &path).unwrap_err(), MISSING, "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_stories_folder_is_refused() {
        use std::os::unix::fs::symlink;
        let fx = fx();
        assert!(guide_open(&fx, &story(&fx)).is_ok());
        let elsewhere = base(&fx).join("elsewhere");
        // A file link, a folder link, and a link to a file in the team but outside stories/.
        symlink(elsewhere.join("secret.md"), fx.team.join("stories/leak.md")).unwrap();
        symlink(&elsewhere, fx.team.join("stories/out")).unwrap();
        symlink(fx.team.join("README.md"), fx.team.join("stories/readme.md")).unwrap();
        for path in [
            "stories/leak.md",
            "stories/out/secret.md",
            "stories/readme.md",
        ] {
            let path = lossy(&fx.team.join(path));
            assert_eq!(guide_open(&fx, &path).unwrap_err(), MISSING, "{path}");
        }
        // A stories/ folder that is itself a link out of the content root.
        let linked = base(&fx).join("orgs/acme/ctx/linked/content");
        std::fs::create_dir_all(&linked).unwrap();
        symlink(&elsewhere, linked.join("stories")).unwrap();
        let mut roots = fx.roots.clone();
        let at = roots.iter().position(|r| r.dir == fx.team).unwrap();
        roots[at].dir = linked.clone();
        let path = lossy(&linked.join("stories/secret.md"));
        assert_eq!(resolve(&roots, &path, None).unwrap_err(), MISSING);
    }

    #[test]
    fn the_grant_only_reads_an_existing_story() {
        let fx = fx();
        let before = std::fs::read(fx.team.join(STORY)).unwrap();
        assert!(guide_open(&fx, &story(&fx)).is_ok());
        // A missing story is refused and nothing is created for it, and a folder is no story.
        let missing = fx.team.join("stories/e/NEW.md");
        assert_eq!(guide_open(&fx, &lossy(&missing)).unwrap_err(), MISSING);
        assert!(!missing.exists());
        std::fs::create_dir_all(fx.team.join("stories/e/dir.md")).unwrap();
        let dir = lossy(&fx.team.join("stories/e/dir.md"));
        assert_eq!(guide_open(&fx, &dir).unwrap_err(), MISSING);
        // Opening leaves the file as it was, and the page earns no capability beyond the one
        // its pin already carried: the grant is a resolver, not a verb.
        assert_eq!(std::fs::read(fx.team.join(STORY)).unwrap(), before);
        let guide = lossy(&fx.docs.join(GUIDE_PAGE));
        assert_eq!(
            foreman_launch::grant_in(&fx.pages, &fx.docs, &guide).as_deref(),
            Some(foreman_launch::CAPABILITY)
        );
        // Refused looks like missing: the same text for a path that is not there and one that
        // is there but out of reach.
        let outside = lossy(&base(&fx).join("elsewhere/secret.md"));
        let nothing = lossy(&base(&fx).join("elsewhere/nothing.md"));
        assert_eq!(
            guide_open(&fx, &outside).unwrap_err(),
            guide_open(&fx, &nothing).unwrap_err()
        );
    }

    #[test]
    fn the_grant_does_not_rely_on_the_scope_admitting_another_orgs_path() {
        let fx = fx();
        // The page's own scope denies this story, as one that admits no other org's path
        // would: the scoped route refuses it for any page, and the grant still admits it.
        let story = story(&fx);
        assert!(!fx.f.scope.allows(Path::new(&story)));
        let docs_page = lossy(&fx.docs.join(GUIDE_PAGE));
        let scoped = super::super::resolve_open_target_granted(
            false,
            &fx.roots,
            &docs_page,
            &story,
            None,
            &fx.f.scope,
        );
        assert_eq!(scoped.unwrap_err(), MISSING);
        assert!(guide_open(&fx, &story).is_ok());
        // The grant's own check is what refuses what is out of bounds, under that same scope.
        assert!(!fx.f.scope.allows(&fx.team.join("README.md")));
        assert!(guide_open(&fx, &lossy(&fx.team.join("README.md"))).is_err());
        // And the grant widens nothing: the scope refuses the story after the open too.
        assert!(!fx.f.scope.allows(Path::new(&story)));
    }
}
