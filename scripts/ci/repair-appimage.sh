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
# It needs python3 (scripts/ci/appimage-offset.sh), unsquashfs and mksquashfs (squashfs-tools)
# and rustc. `--check-tools` checks for them, and for file, which linuxdeploy needs to pack the
# AppImage in the first place, and exits, so a build can fail before it starts.
#
# Usage: bash scripts/ci/repair-appimage.sh <file.AppImage>
#        bash scripts/ci/repair-appimage.sh --check-tools
set -euo pipefail

# Reports every missing tool, then fails. `file` only for --check-tools: the repair itself
# does not run it.
check_tools() {
    local tool missing=() ok=true
    for tool in python3 unsquashfs mksquashfs rustc; do
        command -v "$tool" >/dev/null || missing+=("$tool")
    done
    if ((${#missing[@]})); then
        echo "Error: the AppImage repair needs tools that are not installed: ${missing[*]}" >&2
        echo "(unsquashfs and mksquashfs come with squashfs-tools)" >&2
        ok=false
    fi
    if [[ "${1:-}" == with-linuxdeploy ]] && ! command -v file >/dev/null; then
        echo "Error: linuxdeploy, which packs the AppImage, needs file, which is not installed" >&2
        ok=false
    fi
    [[ $ok == true ]] || exit 1
}

if [[ $# -eq 1 && "$1" == --check-tools ]]; then
    check_tools with-linuxdeploy
    exit 0
fi
[[ $# -eq 1 && -f "$1" ]] || { echo "usage: $0 <file.AppImage> | --check-tools" >&2; exit 1; }
check_tools
appimage=$(realpath "$1")
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
emulator="$PROJECT_ROOT/src-tauri/binaries/codesense-emulator-$(rustc -vV | sed -n 's/^host: //p')"
starship_src=$(bash scripts/fetch-bundled.sh --print-dest starship)

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
