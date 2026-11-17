#!/bin/bash
# SPDX-License-Identifier: MIT
# Build the unsigned app bundle a test build ships, and collect the files to upload.
#
# Usage: bash scripts/ci/unsigned-bundle.sh <macos|linux>
#
# Both platforms build the two sidecars, then run `tauri build` with
# src-tauri/tauri.unsigned.conf.json (no updater artifacts and no secrets). The platform
# branch holds what differs:
#   - macOS fetches git-ai, signs ad hoc (Apple silicon needs a signature to launch the app),
#     builds the app and dmg, and zips the app to $RUNNER_TEMP/CodeSense.app.zip. The dmg
#     stays in target/release/bundle/dmg.
#   - Linux builds the deb, rpm and AppImage, and checks that each of them is exactly one
#     file under target/release/bundle.
# `pnpm exec tauri` runs the CLI directly: the `tauri` script in package.json is POSIX shell
# and does not run on a Windows runner.
set -euo pipefail

usage() {
    echo "usage: $0 <macos|linux>" >&2
    exit 1
}

[[ $# -eq 1 ]] || usage
PLATFORM="$1"
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
        # linuxdeploy is itself an AppImage, and a runner has no FUSE to mount one.
        export APPIMAGE_EXTRACT_AND_RUN=1
        # linuxdeploy's bundled strip cannot read the newer relocation sections that the
        # Ubuntu 24.04 libraries carry, and the bundle fails; skip stripping the bundled files.
        export NO_STRIP=true
        # --verbose shows linuxdeploy's own output, which a failed AppImage otherwise hides.
        tauri_args+=(--verbose --bundles "deb,rpm,appimage")
        ;;
esac

# Shared steps. beforeBuildCommand runs both sidecar scripts again; with their release builds
# in place cargo has nothing left to compile. The session-server script builds the terminal
# emulator worker beside it.
bash scripts/build-bridge.sh --release
bash scripts/build-session-server.sh --release
if [[ "$PLATFORM" == linux ]]; then
    triple=$(rustc -vV | sed -n 's/^host: //p')
    emu="src-tauri/binaries/codesense-emulator-$triple"
    echo "::group::diag"
    file "$emu" || true
    ldd "$emu" || true
    echo "ldd exit: $?"
    readelf -lW "$emu" | head -40 || true
    sudo apt-get install -y --no-install-recommends patchelf || true
    cp "$emu" "$RUNNER_TEMP/emu-patched"
    patchelf --set-rpath '$ORIGIN/../lib' "$RUNNER_TEMP/emu-patched" || true
    ls -l "$emu" "$RUNNER_TEMP/emu-patched"
    file "$RUNNER_TEMP/emu-patched" || true
    ldd "$RUNNER_TEMP/emu-patched" || true
    echo "ldd patched exit: $?"
    "$RUNNER_TEMP/emu-patched" --version || true
    echo "::endgroup::"
    exit 1
fi
pnpm exec tauri build "${tauri_args[@]}"

# Collect what the job uploads.
case "$PLATFORM" in
    macos)
        # ditto keeps the bundle's symlinks, modes and signature, which a plain zip may not.
        ditto -c -k --keepParent "$BUNDLE_DIR/macos/CodeSense.app" "$OUT_DIR/CodeSense.app.zip"
        ;;
    linux)
        # The job uploads each format as it is, so each must be exactly one file.
        for pattern in deb/*.deb rpm/*.rpm appimage/*.AppImage; do
            count=$(find "$BUNDLE_DIR/${pattern%/*}" -maxdepth 1 -name "${pattern#*/}" | wc -l)
            if [[ "$count" -ne 1 ]]; then
                echo "Error: expected one $BUNDLE_DIR/$pattern, found $count" >&2
                exit 1
            fi
        done
        ;;
esac
