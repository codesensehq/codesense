#!/bin/bash
# SPDX-License-Identifier: MIT
# Build the unsigned app bundle a test build ships, and collect the files to upload.
#
# Usage: bash scripts/ci/unsigned-bundle.sh <macos|linux> [bundles]
#
# Both platforms build the two sidecars, then run `tauri build` with
# src-tauri/tauri.unsigned.conf.json (no updater artifacts and no secrets). The platform
# branch holds what differs:
#   - macOS fetches git-ai, signs ad hoc (Apple silicon needs a signature to launch the app),
#     builds the app and dmg, and zips the app to $RUNNER_TEMP/CodeSense.app.zip. The dmg
#     stays in target/release/bundle/dmg.
#   - Linux fetches starship, builds the formats in `bundles` (a comma list of deb, rpm and
#     appimage; all three by default), and checks that each of them is exactly one file under
#     target/release/bundle. The AppImage is bundled apart from the others, without the
#     terminal emulator: linuxdeploy sets an rpath on every executable in the AppDir, and the
#     emulator is a Bun-compiled executable whose payload sits after the ELF image, which the
#     rewrite breaks (on aarch64 the bundle aborts). The same rewrite corrupts the static-pie
#     starship. The script then inserts the untouched emulator, puts the pinned starship back
#     and rebuilds the image from Tauri's own AppImage runtime plus a new squashfs.
# `pnpm exec tauri` runs the CLI directly: the `tauri` script in package.json is POSIX shell
# and does not run on a Windows runner.
set -euo pipefail

usage() {
    echo "usage: $0 <macos|linux> [bundles]" >&2
    exit 1
}

[[ $# -ge 1 && $# -le 2 ]] || usage
PLATFORM="$1"
LINUX_BUNDLES="${2:-deb,rpm,appimage}"
case "$PLATFORM" in
    macos | linux) ;;
    *) usage ;;
esac

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
OUT_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
BUNDLE_DIR="target/release/bundle"
tauri_args=(--config src-tauri/tauri.unsigned.conf.json)

# Platform preparation.
case "$PLATFORM" in
    macos)
        # The bundle ships resources/git-ai; the script verifies it against src-tauri/git-ai.pin.
        bash scripts/fetch-git-ai.sh
        # An inline config merged over the unsigned one: signingIdentity "-" signs ad hoc,
        # and no Apple identity or updater key is involved.
        tauri_args+=(--config '{"bundle":{"macOS":{"signingIdentity":"-"}}}' --bundles "app,dmg")
        # tsc in beforeBuildCommand needs more than the ~2 GB default heap Node picks on this
        # runner's 7 GB (it peaks near 2.8 GB); ubuntu-latest's larger default is why CI's
        # typecheck never hits it. A ceiling with room to grow: tsc and vite run one at a time.
        export NODE_OPTIONS=--max-old-space-size=6144
        ;;
    linux)
        # The bundle ships resources/starship from the pinned, checksummed download.
        bash scripts/fetch-bundled.sh
        # linuxdeploy is itself an AppImage, and a runner has no FUSE to mount one.
        export APPIMAGE_EXTRACT_AND_RUN=1
        # --verbose shows linuxdeploy's own output, which a failed AppImage otherwise hides.
        tauri_args+=(--verbose)
        # tauri build packs every format but the AppImage, which the collection step bundles.
        build_bundles=$(tr ',' '\n' <<<"$LINUX_BUNDLES" | grep -vx appimage | paste -sd, -) || true
        if [[ -n "$build_bundles" ]]; then
            tauri_args+=(--bundles "$build_bundles")
        else
            tauri_args+=(--no-bundle)
        fi
        ;;
esac

# Shared steps. beforeBuildCommand runs both sidecar scripts again; with their release builds
# in place cargo has nothing left to compile. The session-server script builds the terminal
# emulator worker beside it.
bash scripts/build-bridge.sh --release
bash scripts/build-session-server.sh --release
pnpm exec tauri build "${tauri_args[@]}"

# Collect what the job uploads.
case "$PLATFORM" in
    macos)
        # ditto keeps the bundle's symlinks, modes and signature, which a plain zip may not.
        ditto -c -k --keepParent "$BUNDLE_DIR/macos/CodeSense.app" "$OUT_DIR/CodeSense.app.zip"
        ;;
    linux)
        if [[ ",$LINUX_BUNDLES," == *,appimage,* ]]; then
            # The Linux externalBin list without the emulator, so linuxdeploy never sees it. The
            # merge replaces the array; the deb and rpm keep the full list.
            appimage_config=$(node -e '
                const list = require("./src-tauri/tauri.linux.conf.json").bundle.externalBin;
                const rest = list.filter((bin) => bin !== "binaries/codesense-emulator");
                if (rest.length !== list.length - 1) throw new Error("expected one emulator entry");
                console.log(JSON.stringify({ bundle: { externalBin: rest } }));
            ')
            # Packs the app tauri build compiled; nothing is compiled again.
            pnpm exec tauri bundle --verbose --bundles appimage \
                --config src-tauri/tauri.unsigned.conf.json --config "$appimage_config"
        fi
        # The job uploads each format as it is, so each must be exactly one file.
        for format in ${LINUX_BUNDLES//,/ }; do
            case "$format" in
                deb) pattern="deb/*.deb" ;;
                rpm) pattern="rpm/*.rpm" ;;
                appimage) pattern="appimage/*.AppImage" ;;
                *) usage ;;
            esac
            count=$(find "$BUNDLE_DIR/${pattern%/*}" -maxdepth 1 -name "${pattern#*/}" | wc -l)
            if [[ "$count" -ne 1 ]]; then
                echo "Error: expected one $BUNDLE_DIR/$pattern, found $count" >&2
                exit 1
            fi
        done
        if [[ ",$LINUX_BUNDLES," == *,appimage,* ]]; then
            # Insert the emulator byte for byte, and put back the pinned starship the deb and rpm
            # ship, which linuxdeploy's rpath rewrite corrupted. An AppImage is its runtime
            # followed by a squashfs, so the new image is Tauri's runtime bytes plus a squashfs of
            # the extracted tree, made with the original's compressor; no appimagetool is needed.
            # The image is read without running the runtime.
            appimage=$(realpath "$BUNDLE_DIR"/appimage/*.AppImage)
            emulator="$PROJECT_ROOT/src-tauri/binaries/codesense-emulator-$(rustc -vV | sed -n 's/^host: //p')"
            work=$(mktemp -d "$OUT_DIR/appimage.XXXXXX")
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
            install -m 755 src-tauri/resources/fetched/starship "$starship"
            mksquashfs "$work/squashfs-root" "$work/fs.sqfs" -root-owned -noappend -no-progress \
                -comp "$compressor"
            # A temp file, then mv: a redirect onto the original would truncate it before head reads.
            head -c "$offset" "$appimage" >"$work/rebuilt.AppImage"
            cat "$work/fs.sqfs" >>"$work/rebuilt.AppImage"
            chmod +x "$work/rebuilt.AppImage"
            mv "$work/rebuilt.AppImage" "$appimage"
            rm -rf "$work"
        fi
        ;;
esac
