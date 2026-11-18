#!/bin/bash
# SPDX-License-Identifier: MIT
# Repair a CodeSense AppImage after linuxdeploy has packed it. linuxdeploy sets an $ORIGIN rpath
# on every ELF file in the AppDir, and that patchelf rewrite breaks two of them: the static-pie
# starship crashes, and the Bun-compiled emulator, whose payload sits after its ELF image, loses
# it (on aarch64 the bundle aborts). So the image must be bundled without the emulator (see
# scripts/ci/unsigned-bundle.sh), and this script then inserts the emulator the build compiled
# and puts back the pinned starship that the deb and rpm ship, both byte for byte.
#
# An AppImage is its runtime followed by a squashfs, so the new image is the original runtime
# bytes plus a squashfs of the repaired tree, made with the original's compressor; no
# appimagetool is needed. The offset that keeps the runtime also locates the squashfs, so the
# image is read with unsquashfs at that offset rather than by running the image itself.
#
# The runtime's .digest_md5 section, which appimagetool fills when it packs the image, still
# holds the original image's digest after this rebuild. Nothing checks it: these builds are
# unsigned, and the runtime does not verify it at launch.
#
# Any build that ships an AppImage needs this step, a release one too.
#
# Usage: bash scripts/ci/repair-appimage.sh <file.AppImage>
set -euo pipefail
[[ $# -eq 1 && -f "$1" ]] || { echo "usage: $0 <file.AppImage>" >&2; exit 1; }
appimage=$(realpath "$1")
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
emulator="$PROJECT_ROOT/src-tauri/binaries/codesense-emulator-$(rustc -vV | sed -n 's/^host: //p')"
starship_src=$(bash scripts/fetch-bundled.sh --print-dest)

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/appimage.XXXXXX")
trap 'rm -rf "$work"' EXIT
offset=$(bash scripts/ci/appimage-offset.sh "$appimage")
compressor=$(unsquashfs -s -o "$offset" "$appimage" | sed -n 's/^Compression //p')
unsquashfs -q -n -d "$work/squashfs-root" -o "$offset" "$appimage"
if [[ -e "$work/squashfs-root/usr/bin/codesense-emulator" ]]; then
    echo "Error: the AppImage was bundled with the emulator" >&2
    exit 1
fi
install -m 755 "$emulator" "$work/squashfs-root/usr/bin/codesense-emulator"
starship=$(find "$work/squashfs-root" -path '*/resources/starship' -type f)
if [[ -z "$starship" || "$starship" == *$'\n'* ]]; then
    echo "Error: expected one resources/starship in $appimage, found: $starship" >&2
    exit 1
fi
install -m 755 "$starship_src" "$starship"
mksquashfs "$work/squashfs-root" "$work/fs.sqfs" -root-owned -noappend -no-progress \
    -comp "$compressor"
# A temp file, then mv: a redirect onto the original would truncate it before head reads.
head -c "$offset" "$appimage" >"$work/rebuilt.AppImage"
cat "$work/fs.sqfs" >>"$work/rebuilt.AppImage"
chmod +x "$work/rebuilt.AppImage"
mv "$work/rebuilt.AppImage" "$appimage"
