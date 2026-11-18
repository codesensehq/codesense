#!/bin/bash
# SPDX-License-Identifier: MIT
# Build the codesense-bridge sidecar binary and copy it to the location
# Tauri expects for externalBin bundling.
#
# Usage:
#   ./scripts/build-bridge.sh           # debug build
#   ./scripts/build-bridge.sh --release # release build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=SCRIPTDIR/lib/sidecar.sh
. "$SCRIPT_DIR/lib/sidecar.sh"

# Determine build profile
PROFILE="debug"
CARGO_FLAGS=""
if [[ "${1:-}" == "--release" ]]; then
    PROFILE="release"
    CARGO_FLAGS="--release"
fi

TARGET_TRIPLE="$(sidecar_host_triple)"
# Where Tauri's externalBin looks for it: src-tauri/binaries/<name>-<triple>[.exe]
DEST="$(sidecar_path codesense-bridge "$TARGET_TRIPLE")"

# SIDECAR_DRY_RUN=1 prints the path this would write, and builds nothing.
if [[ "${SIDECAR_DRY_RUN:-}" == 1 ]]; then
    echo "$DEST"
    exit 0
fi

echo "Building codesense-bridge ($PROFILE) for $TARGET_TRIPLE..."

# Build the bridge crate
cargo build -p codesense-bridge $CARGO_FLAGS

# Ensure binaries directory exists
mkdir -p "$(dirname "$DEST")"

SOURCE="${CARGO_TARGET_DIR:-$PROJECT_ROOT/target}/$PROFILE/codesense-bridge"

if [[ ! -f "$SOURCE" ]]; then
    echo "Error: Built binary not found at $SOURCE" >&2
    exit 1
fi

cp "$SOURCE" "$DEST"
echo "Copied: $DEST"
