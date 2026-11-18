#!/bin/bash
# SPDX-License-Identifier: MIT
# Fetch the pinned third-party binaries this host's app bundle ships, through scripts/fetch-pinned.sh.
# The one place that maps a host to its pins: macOS bundles git-ai, Linux bundles starship (from
# resources/fetched/, which tauri.linux.conf.json ships as resources/starship). Run it before any
# build or compile of the app, since the build reads those resources.
# Usage: scripts/fetch-bundled.sh [--dry-run | --print-pin <name> | --print-dest <name>]
#   --dry-run            print the URL of each binary it would fetch and exit
#   --print-pin <name>   print the pin of this host's <name> (e.g. starship), relative to the
#                        repository root, and exit; a name this host doesn't ship is refused
#   --print-dest <name>  print where this host's <name> is fetched to, likewise
set -euo pipefail
usage() {
  printf 'Usage: %s [--dry-run | --print-pin <name> | --print-dest <name>]\n' "$0" >&2
  exit 2
}
case "$#:${1:-}" in
  0:|1:--dry-run) ;;
  2:--print-pin|2:--print-dest) ;;
  *) usage ;;
esac
os="$(uname -s)" arch="$(uname -m)"
# One entry per binary: name, pin and destination, each relative to the repository root.
case "$os:$arch" in
  Darwin:*) bundled=("git-ai src-tauri/git-ai.pin src-tauri/resources/git-ai") ;;
  Linux:x86_64|Linux:aarch64)
    bundled=("starship src-tauri/pins/starship-linux-$arch.pin src-tauri/resources/fetched/starship") ;;
  *) printf 'No pinned binaries for this host: %s %s\n' "$os" "$arch" >&2; exit 1 ;;
esac
case "${1:-}" in
  --print-pin|--print-dest)
    for entry in "${bundled[@]}"; do
      read -r name pin dest <<<"$entry"
      [[ "$name" == "$2" ]] || continue
      if [[ "$1" == --print-pin ]]; then printf '%s\n' "$pin"; else printf '%s\n' "$dest"; fi
      exit 0
    done
    printf 'This host does not bundle %s: %s %s\n' "$2" "$os" "$arch" >&2
    exit 1
    ;;
esac
for entry in "${bundled[@]}"; do
  read -r _ pin dest <<<"$entry"
  bash "$(dirname "$0")/fetch-pinned.sh" "$pin" "$dest" "$@"
done
