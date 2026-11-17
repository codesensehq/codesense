#!/bin/bash
# SPDX-License-Identifier: MIT
# Print a manifest of a macOS .app bundle, so two builds of the same source can be compared
# with diff.
#
# Usage: bash scripts/ci/bundle-manifest.sh <path to the .app> > manifest.txt
#
# One line per file, sorted by relative path: path, mode, size and sha256. Mach-O files carry
# no sha256 (their signature and build paths differ per build); every other file does.
# A symlink lists its target. Info.plist follows, converted to canonical XML.
#
# Fields expected to differ between two builds of the same source:
#   - the size of every Mach-O file, and Contents/_CodeSignature/CodeResources (it holds the
#     hashes of those files);
#   - the Info.plist keys that name the build (the build machine, SDK and Xcode build
#     numbers), which only change when the runner image does.
# Everything else (the file list, modes, sizes and hashes of resources) must match.
#
# Runs on macOS: bash 3.2 and BSD tools.
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/Contents" ]]; then
    echo "usage: $0 <path to the .app>" >&2
    exit 1
fi
APP="$1"

is_macho() {
    case "$(head -c 4 "$1" | od -An -tx1 | tr -d ' \n')" in
        feedface | feedfacf | cefaedfe | cffaedfe | cafebabe | bebafeca) return 0 ;;
        *) return 1 ;;
    esac
}

cd "$APP"
echo "# bundle manifest: path mode size sha256"
find . -mindepth 1 \( -type f -o -type l \) -print | LC_ALL=C sort | while IFS= read -r path; do
    rel="${path#./}"
    mode=$(stat -f '%Lp' "$path")
    if [[ -L "$path" ]]; then
        echo "$rel $mode link -> $(readlink "$path")"
        continue
    fi
    size=$(stat -f '%z' "$path")
    if is_macho "$path"; then
        hash=macho
    else
        hash=$(shasum -a 256 "$path" | cut -d' ' -f1)
    fi
    echo "$rel $mode $size $hash"
done
echo "# Contents/Info.plist (canonical)"
plutil -convert xml1 -o - Contents/Info.plist
