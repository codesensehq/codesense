#!/bin/bash
# SPDX-License-Identifier: MIT
# Fetch the pinned third-party binaries this host's app bundle ships, through scripts/fetch-pinned.sh.
# The one place that maps a host to its pins: macOS bundles git-ai; Linux bundles git-ai and
# starship (the starship from resources/fetched/, which tauri.linux.conf.json ships as
# resources/starship). Run it before any build or compile of the app, since the build reads
# those resources.
# Usage: scripts/fetch-bundled.sh [--dry-run | --print-names | --print-pin <name> |
#                                  --print-dest <name> | --print-version <name> |
#                                  --check-version <name> <binary>]
#   --dry-run            print the URL of each binary it would fetch and exit
#   --print-names        print the name of each binary this host bundles, one per line, and exit
#   --print-pin <name>   print the pin of this host's <name> (e.g. starship), relative to the
#                        repository root, and exit; a name this host doesn't ship is refused
#   --print-dest <name>  print where this host's <name> is fetched to, likewise
#   --print-version <name>
#                        print the version= of <name>'s pin, likewise; a pin without one fails
#   --check-version <name> <binary>
#                        run `<binary> --version` and check its first line is <name>'s pinned
#                        version as <name> prints it; print `<binary>: <line>` and exit, or fail
# The print and check modes read only the repository, never the network.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
usage() {
  printf 'Usage: %s [--dry-run | --print-names | --print-pin <name> |\n' "$0" >&2
  printf '  --print-dest <name> | --print-version <name> | --check-version <name> <binary>]\n' >&2
  exit 2
}
case "$#:${1:-}" in
  0:|1:--dry-run|1:--print-names) ;;
  2:--print-pin|2:--print-dest|2:--print-version) ;;
  3:--check-version) ;;
  *) usage ;;
esac
os="$(uname -s)" arch="$(uname -m)"
# One entry per binary, on one line: name, pin and destination, each relative to the repository
# root, then the word its `--version` prints before the version, if any. The name is also the
# file the bundle ships, resources/<name>, which the AppImage repair and the bundle checks rely on.
pins=src-tauri/pins resources=src-tauri/resources
case "$os:$arch" in
  Darwin:*) bundled=("git-ai $pins/git-ai-macos-arm64.pin $resources/git-ai") ;;
  Linux:x86_64|Linux:aarch64)
    bundled=(
      "git-ai $pins/git-ai-linux-$arch.pin $resources/git-ai"
      "starship $pins/starship-linux-$arch.pin $resources/fetched/starship starship"
    )
    ;;
  *) printf 'No pinned binaries for this host: %s %s\n' "$os" "$arch" >&2; exit 1 ;;
esac
# The one parser of an entry: sets name, pin, dest and prefix from $1, or refuses an entry
# without a pin and destination or with a field too many.
read_entry() {
  local extra
  read -r name pin dest prefix extra <<<"$1"
  if [[ -z "$pin" || -z "$dest" || -n "$extra" ]]; then
    printf 'bad bundled entry: %s\n' "$1" >&2
    exit 1
  fi
}
# Every entry is parsed before any mode runs, so every mode refuses a bad table.
for entry in "${bundled[@]}"; do read_entry "$entry"; done
# Sets the fields of this host's entry for $1, or refuses a name it doesn't ship.
find_entry() {
  for entry in "${bundled[@]}"; do
    read_entry "$entry"
    [[ "$name" == "$1" ]] && return
  done
  printf 'This host does not bundle %s: %s %s\n' "$1" "$os" "$arch" >&2
  exit 1
}
# Sets version from the pin find_entry set.
pin_version() {
  version=$(sed -n 's/^version=//p' "$root/$pin")
  [[ -n "$version" ]] || { printf '%s has no version\n' "$pin" >&2; exit 1; }
}
case "${1:-}" in
  --print-names)
    for entry in "${bundled[@]}"; do
      read_entry "$entry"
      printf '%s\n' "$name"
    done
    exit 0
    ;;
  --print-pin) find_entry "$2"; printf '%s\n' "$pin"; exit 0 ;;
  --print-dest) find_entry "$2"; printf '%s\n' "$dest"; exit 0 ;;
  --print-version) find_entry "$2"; pin_version; printf '%s\n' "$version"; exit 0 ;;
  --check-version)
    find_entry "$2"
    pin_version
    expected="${prefix:+$prefix }$version"
    line=$("$3" --version) || { printf '%s failed to run (exit %s)\n' "$3" "$?" >&2; exit 1; }
    line=${line%%$'\n'*}
    if [[ "$line" != "$expected" ]]; then
      printf '%s prints %s, not %s as pinned in %s\n' "$3" "$line" "$expected" "$pin" >&2
      exit 1
    fi
    printf '%s: %s\n' "$3" "$line"
    exit 0
    ;;
esac
for entry in "${bundled[@]}"; do
  read_entry "$entry"
  bash "$(dirname "$0")/fetch-pinned.sh" "$pin" "$dest" "$@"
done
