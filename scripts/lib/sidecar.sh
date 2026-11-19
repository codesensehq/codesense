# shellcheck shell=bash
# SPDX-License-Identifier: MIT
# Sidecar naming, sourced by the build scripts (build-bridge.sh,
# build-session-server.sh, build-emulator.sh): the host triple, the executable
# suffix and where each sidecar and its .sha256 land. Tauri's externalBin looks
# for src-tauri/binaries/<name>-<triple>, with .exe on Windows.
#
# bash 3.2-compatible (macOS /bin/bash) and safe to source under set -euo pipefail.

# Taken from this file, so a caller that never changes directory gets the same paths.
SIDECAR_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Print rustc's host triple; fail when rustc names none.
sidecar_host_triple() {
    local host
    host="$(rustc -vV | awk '/^host:/ {print $2}')" || host=""
    if [[ -z "$host" ]]; then
        echo "Error: Could not determine Rust target triple" >&2
        return 1
    fi
    echo "$host"
}

# Print the executable suffix for triple $1: .exe on Windows, else nothing.
sidecar_exe_suffix() {
    case "$1" in
        *-windows-*) echo ".exe" ;;
        *) echo "" ;;
    esac
}

# Print the absolute path where sidecar $1 for triple $2 lands.
sidecar_path() {
    echo "$SIDECAR_PROJECT_ROOT/src-tauri/binaries/$1-$2$(sidecar_exe_suffix "$2")"
}

# Print the .sha256 line for file $1 in `sha256sum` format: "<hex>  <basename>".
# Built from the digest alone (the file read on stdin), so neither Git Bash's
# "*name" binary marker nor an escaped path reaches the line.
sidecar_sha256_line() {
    local hex
    if command -v sha256sum >/dev/null 2>&1; then
        hex="$(sha256sum <"$1" | cut -d' ' -f1)"
    else
        hex="$(shasum -a 256 <"$1" | cut -d' ' -f1)"
    fi
    printf '%s  %s\n' "$hex" "${1##*/}"
}
