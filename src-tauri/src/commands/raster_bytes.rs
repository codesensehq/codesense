// SPDX-License-Identifier: MIT
//! Raster image bytes for a rendered diff's Before | After sides off Files (the source
//! diff, the open-diff tab and Unsaved team edits): PNG, JPEG, GIF and WebP only. An SVG
//! can carry script, so it renders from its text in the sandboxed side frame instead and
//! is never read here. Every read is read-only, capped at the media cap, and refuses a
//! path that is not a raster image or that resolves outside its root.

use base64::Engine as _;
use serde::Serialize;
use std::io::Read as _;
use std::path::Path;

/// The most bytes one side carries: the inbox media cap. A larger side carries none.
pub(crate) const MAX_RASTER_BYTES: usize = crate::media::MAX_BYTES;

const RASTER_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Whether `path` names a raster image these reads serve (by extension, any case).
pub(crate) fn is_raster(path: &str) -> bool {
    let ext: Option<&str> = Path::new(path).extension().and_then(|ext| ext.to_str());
    ext.is_some_and(|ext| {
        RASTER_EXTENSIONS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(ext))
    })
}

/// Refuses a path these reads don't serve, so none of them is a general file reader.
pub(crate) fn require_raster(path: &str) -> Result<(), String> {
    if is_raster(path) {
        Ok(())
    } else {
        Err(format!("not a raster image: {path}"))
    }
}

/// Whether `bytes` begin as a PNG, JPEG, GIF or WebP file does, whatever the path says: a
/// side read from another machine is drawn only when its bytes are a raster image.
pub(crate) fn sniff_raster(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()))
}

/// One present side: its bytes, or past [`MAX_RASTER_BYTES`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Capped {
    Bytes(Vec<u8>),
    TooLarge,
}

pub(crate) fn capped(bytes: Vec<u8>) -> Capped {
    if bytes.len() > MAX_RASTER_BYTES {
        Capped::TooLarge
    } else {
        Capped::Bytes(bytes)
    }
}

/// A raster file's two sides, base64. `None` is an absent side (an added file has no
/// before, a deleted one no after) or one past the cap (`tooLarge`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSides {
    pub before: Option<String>,
    pub after: Option<String>,
    /// A present side was past the cap and carries no bytes: the diff stays Source only.
    pub too_large: bool,
}

/// One raster file read for a team edit: `None` with `tooLarge` past the cap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub base64: Option<String>,
    pub too_large: bool,
}

fn encode(side: Option<&Capped>) -> Option<String> {
    match side {
        Some(Capped::Bytes(bytes)) => Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        _ => None,
    }
}

pub(crate) fn image_sides(before: Option<Capped>, after: Option<Capped>) -> ImageSides {
    let too_large =
        matches!(before, Some(Capped::TooLarge)) || matches!(after, Some(Capped::TooLarge));
    ImageSides {
        before: encode(before.as_ref()),
        after: encode(after.as_ref()),
        too_large,
    }
}

pub(crate) fn image_file(side: Capped) -> ImageFile {
    ImageFile {
        base64: encode(Some(&side)),
        too_large: matches!(side, Capped::TooLarge),
    }
}

/// The bytes of `path`, a regular file that resolves inside `root`: `Ok(None)` when it is
/// absent. A symlink at the leaf, a directory, or a path that resolves outside `root`
/// (through a linked directory) is refused. Reads at most one byte past the cap.
pub(crate) fn read_file_within(root: &Path, path: &Path) -> Result<Option<Capped>, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if std::io::Error::kind(&e) == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", std::path::Path::display(path))),
    };
    if !meta.is_file() {
        return Err(format!(
            "not a regular file: {}",
            std::path::Path::display(path)
        ));
    }
    let real_root = root
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", std::path::Path::display(root)))?;
    let real = path
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", std::path::Path::display(path)))?;
    if !real.starts_with(&real_root) {
        return Err(format!(
            "path leaves its root: {}",
            std::path::Path::display(path)
        ));
    }
    let file = std::fs::File::open(&real)
        .map_err(|e| format!("read {}: {e}", std::path::Path::display(path)))?;
    let mut bytes: Vec<u8> = vec![];
    file.take(MAX_RASTER_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {}: {e}", std::path::Path::display(path)))?;
    Ok(Some(capped(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_png_jpeg_gif_and_webp_are_raster() {
        for path in ["a.png", "b/c.JPG", "d.jpeg", "e.gif", "f.WebP"] {
            assert!(is_raster(path), "{path}");
        }
        for path in ["a.svg", "b.html", "c.md", "png", "d.png.txt", "", "e.bmp"] {
            assert!(!is_raster(path), "{path}");
            assert!(require_raster(path).is_err(), "{path}");
        }
    }

    #[test]
    fn only_bytes_that_begin_as_png_jpeg_gif_or_webp_sniff_as_raster() {
        for bytes in [
            b"\x89PNG\r\n\x1a\nrest".as_slice(),
            &[0xff, 0xd8, 0xff, 0xe0, 0, 0x10],
            b"GIF89a....",
            b"GIF87a....",
            b"RIFF\x10\0\0\0WEBPVP8 ",
        ] {
            assert!(sniff_raster(bytes), "{bytes:?}");
        }
        for bytes in [
            b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>".as_slice(),
            b"<html>",
            b"\x89PNG",
            b"RIFF\x10\0\0\0WAVEfmt ",
            b"",
            b"plain text",
        ] {
            assert!(!sniff_raster(bytes), "{bytes:?}");
        }
    }

    #[test]
    fn a_side_past_the_cap_carries_no_bytes() {
        let sides = image_sides(
            Some(capped(vec![1, 2, 3])),
            Some(capped(vec![0; MAX_RASTER_BYTES + 1])),
        );
        assert_eq!(sides.before.as_deref(), Some("AQID"));
        assert_eq!(sides.after, None);
        assert!(sides.too_large);
        let at_cap = image_sides(None, Some(capped(vec![0; MAX_RASTER_BYTES])));
        assert!(at_cap.after.is_some());
        assert!(!at_cap.too_large);
        assert_eq!(at_cap.before, None);
    }

    #[test]
    fn reads_a_file_inside_its_root_and_reports_an_absent_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.png"), [137, 80, 78, 71]).unwrap();
        assert_eq!(
            read_file_within(dir.path(), &dir.path().join("a.png")).unwrap(),
            Some(Capped::Bytes(vec![137, 80, 78, 71]))
        );
        assert_eq!(
            read_file_within(dir.path(), &dir.path().join("gone.png")).unwrap(),
            None
        );
    }

    #[test]
    fn stops_reading_one_byte_past_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.png");
        std::fs::write(&big, vec![7u8; MAX_RASTER_BYTES + 10]).unwrap();
        assert_eq!(
            read_file_within(dir.path(), &big).unwrap(),
            Some(Capped::TooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_a_directory_and_a_path_through_a_linked_directory() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.png"), b"secret").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::os::unix::fs::symlink(outside.path().join("secret.png"), root.join("leaf.png"))
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        std::fs::create_dir(root.join("dir.png")).unwrap();
        assert!(read_file_within(root, &root.join("leaf.png")).is_err());
        assert!(read_file_within(root, &root.join("dir.png")).is_err());
        let through = read_file_within(root, &root.join("linked/secret.png")).unwrap_err();
        assert!(through.contains("leaves its root"), "{through}");
    }
}
