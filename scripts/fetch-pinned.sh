#!/bin/bash
# SPDX-License-Identifier: MIT
# Fetch one pinned third-party binary that the app bundle ships.
# Downloads the pin's release asset over HTTPS with no login, checks its SHA-256 against the pin
# before using it, takes the pinned member out of an archive asset, and installs it at <dest>.
#
# Usage: scripts/fetch-pinned.sh <pin> <dest> [--dry-run | --from <file>]
#   --dry-run      print the URL it would fetch and exit
#   --from <file>  use a local file instead of downloading (tests); the SHA-256 check still applies
# A relative <pin> or <dest> is relative to the repository root, so it runs from any directory.
# scripts/fetch-bundled.sh picks the pins for this host; call that rather than this.
#
# A pin is key=value lines: version, asset, platform, sha256, repo and tag (v<version>), plus
# archive (tar.gz or zip) and member (the file to take from it) when the asset is an archive.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  printf 'Usage: %s <pin> <dest> [--dry-run | --from <file>]\n' "$0" >&2
  exit 2
}

(( $# >= 2 )) || usage
pin=$1 dest=$2
shift 2
dry_run=0 from=''
case "$#:${1:-}" in
  0:) ;;
  1:--dry-run) dry_run=1 ;;
  2:--from) from=$2 ;;
  *) usage ;;
esac
[[ "$pin" == /* ]] || pin="$root/$pin"
[[ "$dest" == /* ]] || dest="$root/$dest"

read_pin() {
  version='' asset='' platform='' sha256='' repo='' tag='' archive='' member=''
  while IFS='=' read -r key value; do
    case "$key" in
      ''|'#'*) continue ;;
      version|asset|platform|sha256|repo|tag|archive|member) printf -v "$key" '%s' "$value" ;;
      *) printf 'Unknown pin key in %s: %s\n' "$1" "$key" >&2; exit 1 ;;
    esac
  done < "$1"
}
# The git-ai repository is named in one place, its committed pin.
read_pin "$root/src-tauri/git-ai.pin"
git_ai_repo=$repo
read_pin "$pin"
invalid() {
  printf 'Invalid pin %s: %s\n' "$pin" "$1" >&2
  exit 1
}
[[ -n "$version" && -n "$asset" ]] || invalid 'version and asset are required'
case "$platform" in
  macos-arm64|linux-x86_64|linux-aarch64|windows-x86_64) ;;
  *) invalid "unknown platform '$platform'" ;;
esac
[[ -n "$repo" && ( "$repo" == starship/starship || "$repo" == "$git_ai_repo" ) ]] || invalid "unknown repo '$repo'"
[[ "$tag" == "v$version" ]] || invalid "tag must be v$version"
[[ "$sha256" =~ ^[0-9a-f]{64}$ ]] || invalid 'sha256 must be 64 lowercase hex digits'
[[ -z "$archive$member" || ( -n "$archive" && -n "$member" ) ]] || invalid 'archive and member go together'
case "$archive" in
  ''|tar.gz|zip) ;;
  *) invalid "unknown archive '$archive'" ;;
esac
# A plain relative path: no wildcards for unzip, nothing outside the extraction directory.
if [[ -n "$member" && ( ! "$member" =~ ^[A-Za-z0-9._/-]+$ || "$member" == /* || "/$member/" == */../* ) ]]; then
  invalid "member '$member' must be a relative path"
fi

url="https://github.com/$repo/releases/download/$tag/$asset"
if (( dry_run )); then
  printf '%s\n' "$url"
  exit 0
fi

name="${dest##*/}"
staged="${dest%/*}/.$name.tmp.$$"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch" "$staged"' EXIT
if [[ -n "$from" ]]; then
  cp "$from" "$scratch/$asset"
else
  # -q ignores ~/.curlrc, and no Authorization header is ever sent, so no credential follows the
  # CDN redirect. Transient failures are retried (scripts/lib/download-retry.sh).
  # shellcheck source-path=SCRIPTDIR source=lib/download-retry.sh
  . "$root/scripts/lib/download-retry.sh"
  status=0
  download_with_retry "$scratch/$asset" "$url" --proto '=https' --proto-redir '=https' --tlsv1.2 || status=$?
  if (( status != 0 )); then
    printf '%s download failed (curl exit %s, HTTP %s): %s\n' "$name" "$status" "${DOWNLOAD_HTTP_CODE:-none}" "$url" >&2
    exit 1
  fi
fi
# sha256sum where it exists (coreutils on Linux), else shasum, which every macOS has.
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$scratch/$asset")"
elif command -v shasum >/dev/null; then
  actual="$(shasum -a 256 "$scratch/$asset")"
else
  printf '%s: neither sha256sum nor shasum is installed, so the download cannot be checked\n' "$name" >&2
  exit 1
fi
actual="${actual%% *}"
if [[ "$actual" != "$sha256" ]]; then
  printf '%s SHA-256 mismatch: expected %s, got %s\n' "$name" "$sha256" "$actual" >&2
  exit 1
fi

source_file="$scratch/$asset"
if [[ -n "$archive" ]]; then
  mkdir "$scratch/extract"
  case "$archive" in
    tar.gz) tar -xzf "$scratch/$asset" -C "$scratch/extract" -- "$member" ;;
    zip) unzip -q "$scratch/$asset" "$member" -d "$scratch/extract" ;;
  esac
  source_file="$scratch/extract/$member"
  if [[ -L "$source_file" || ! -f "$source_file" ]]; then
    printf '%s: %s in %s is not a regular file\n' "$name" "$member" "$asset" >&2
    exit 1
  fi
fi

mkdir -p "${dest%/*}"
# Copy beside the target, then rename, so an interrupted copy never leaves a partial binary in place.
install -m 755 "$source_file" "$staged"
mv -f "$staged" "$dest"
printf 'Bundled %s %s verified at %s\n' "$name" "$version" "${dest#"$root"/}"
