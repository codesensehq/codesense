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
#   - Linux fetches git-ai and starship, builds the formats in `bundles` (a comma list of deb,
#     rpm and appimage; all three by default), and checks that each of them is exactly one
#     file under target/release/bundle. The AppImage is bundled apart from the others, without the
#     terminal emulator: linuxdeploy sets an rpath on every executable in the AppDir, and the
#     emulator is a Bun-compiled executable whose payload sits after the ELF image, which the
#     rewrite breaks (on aarch64 the bundle aborts). The same rewrite corrupts the static
#     git-ai and starship. scripts/ci/repair-appimage.sh then inserts the untouched emulator,
#     puts the pinned git-ai and starship back and rebuilds the image from its own runtime
#     plus a new squashfs.
# `pnpm exec tauri` runs the CLI directly: the `tauri` script in package.json is POSIX shell
# and does not run on a Windows runner.
#
# CODESENSE_BUNDLE_CHANNEL=beta|beta-staging (Linux only) builds a release channel's bundle in
# place of the test build's: the channel's configs over the unsigned one (tauri.beta.conf.json for
# the codesense:// handler, then tauri.beta-prod.conf.json or tauri.beta-staging.conf.json, which
# the caller supplies, for the channel's updater key and hosts), CODESENSE_CHANNEL set to it and
# the dashboard-publish feature, as the macOS release build has. The caller sets
# CODESENSE_DASH_HOST. The configs keep updater artifacts off and no key is involved: the
# repaired AppImage is signed later, so its signature covers the final bytes. Unset, the build
# is the test build, unchanged.
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
# The configs both tauri build and the AppImage's tauri bundle take.
config_args=(--config src-tauri/tauri.unsigned.conf.json)
build_args=()
CHANNEL="${CODESENSE_BUNDLE_CHANNEL:-}"
if [[ -n "$CHANNEL" ]]; then
    [[ "$PLATFORM" == linux ]] || { echo "Error: CODESENSE_BUNDLE_CHANNEL is for a Linux bundle" >&2; exit 1; }
    case "$CHANNEL" in
        beta) channel_conf=src-tauri/tauri.beta-prod.conf.json ;;
        beta-staging) channel_conf=src-tauri/tauri.beta-staging.conf.json ;;
        *) echo "Error: CODESENSE_BUNDLE_CHANNEL must be beta or beta-staging, not $CHANNEL" >&2; exit 1 ;;
    esac
    [[ -f "$channel_conf" ]] || { echo "Error: $channel_conf is missing; the caller supplies the channel's config" >&2; exit 1; }
    [[ -n "${CODESENSE_DASH_HOST:-}" ]] || { echo "Error: a channel bundle needs CODESENSE_DASH_HOST" >&2; exit 1; }
    config_args+=(--config src-tauri/tauri.beta.conf.json --config "$channel_conf")
    build_args+=(--features dashboard-publish)
    export CODESENSE_CHANNEL="$CHANNEL"
fi
tauri_args=("${config_args[@]}" ${build_args[@]+"${build_args[@]}"})

# Platform preparation.
case "$PLATFORM" in
    macos)
        # The bundle ships resources/git-ai, which the script verifies against its pin in
        # src-tauri/pins/.
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
        # The bundle ships resources/git-ai and resources/starship from the pinned, checksummed
        # downloads.
        bash scripts/fetch-bundled.sh
        # linuxdeploy is itself an AppImage, and a runner has no FUSE to mount one.
        export APPIMAGE_EXTRACT_AND_RUN=1
        # --verbose shows linuxdeploy's own output, which a failed AppImage otherwise hides.
        tauri_args+=(--verbose)
        # Every AppImage tool (the repair's, and linuxdeploy's `file`), checked now rather than
        # after an hour's build.
        if [[ ",$LINUX_BUNDLES," == *,appimage,* ]]; then
            bash scripts/ci/repair-appimage.sh --check-tools
        fi
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
                "${config_args[@]}" --config "$appimage_config"
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
            # Bundled without the emulator, and with the git-ai and starship linuxdeploy broke; put
            # them right.
            bash scripts/ci/repair-appimage.sh "$BUNDLE_DIR"/appimage/*.AppImage
        fi
        ;;
esac
