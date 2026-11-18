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
#   - Linux fetches starship, builds the formats in `bundles` (a comma list of deb, rpm and appimage; all three
#     by default), and checks that each of them is exactly one file under
#     target/release/bundle. The arm64 job leaves out appimage: linuxdeploy rewrites the
#     bundled emulator executable, which breaks it on aarch64.
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
        # linuxdeploy strips every ELF file it bundles, which breaks the static starship binary.
        export NO_STRIP=1
        # --verbose shows linuxdeploy's own output, which a failed AppImage otherwise hides.
        tauri_args+=(--verbose --bundles "$LINUX_BUNDLES")
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
        ;;
esac
