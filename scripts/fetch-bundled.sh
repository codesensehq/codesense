#!/bin/bash
# SPDX-License-Identifier: MIT
# Fetch the pinned third-party binaries this host's app bundle ships, through scripts/fetch-pinned.sh.
# The one place that maps a host to its pins: macOS bundles git-ai, Linux bundles starship (from
# resources/fetched/, which tauri.linux.conf.json ships as resources/starship). Run it before any
# build or compile of the app, since the build reads those resources.
# Usage: scripts/fetch-bundled.sh [--dry-run]   (--dry-run prints the URL it would fetch and exits)
set -euo pipefail
case "$#:${1:-}" in
  0:|1:--dry-run) ;;
  *) printf 'Usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac
os="$(uname -s)" arch="$(uname -m)"
case "$os:$arch" in
  Darwin:*) pin=src-tauri/git-ai.pin dest=src-tauri/resources/git-ai ;;
  Linux:x86_64|Linux:aarch64) pin="src-tauri/pins/starship-linux-$arch.pin" dest=src-tauri/resources/fetched/starship ;;
  *) printf 'No pinned binaries for this host: %s %s\n' "$os" "$arch" >&2; exit 1 ;;
esac
exec bash "$(dirname "$0")/fetch-pinned.sh" "$pin" "$dest" "$@"
