#!/bin/bash
# SPDX-License-Identifier: MIT
# Lets cargo reuse a cached target/ for exactly the files unchanged since the cached build.
# rust.yml's macOS build restores target/ from the nightly's cache.
#
# Cargo rebuilds a workspace crate when one of its files (or a directory a build script watches)
# is newer than its last build. A checkout dates every file now, so a restored target/ alone
# saves nothing. The nightly records the commit it built in target/, with the untracked files its
# build read. A later run gives every file the cached build saw one fixed old date, and dates now
# what `git diff` lists between that commit and HEAD, whatever the commits' own dates. A cached
# build whose commit this checkout doesn't have is removed, so that build is cold.
#
# Usage, from the repository root:
#   build-cache-dates.sh record    after the nightly's build, before target/ is saved
#   build-cache-dates.sh restore   after target/ is restored, before any cargo command
#   build-cache-dates.sh pin       after the steps that write untracked build inputs (git-ai,
#                                  the sidecars, the docs data), before the build

set -euo pipefail
export LC_ALL=C

state=target/ci-cache
# touch -t's [[CC]YY]MMDDhhmm: older than any build.
old=200001010000

# Every directory one old date, then now on each changed path and the directory holding it: cargo
# takes a watched directory's newest date from everything under it, directories included.
date_tree() {
    local path
    find . \( -path ./.git -o -path ./target -o -name node_modules \) -prune -o -type d -print0 |
        xargs -0 -r touch -h -t "$old"
    while IFS= read -r -d '' path; do
        if [[ -e "$path" || -L "$path" ]]; then touch -h "$path"; fi
        # A deleted path's directory, or the nearest one left.
        path=$(dirname "$path")
        while [[ ! -d "$path" ]]; do path=$(dirname "$path"); done
        touch -h "$path"
    done < <(git diff --name-only --no-renames -z "$(cat "$state/source-sha")" HEAD)
}

record() {
    rm -rf "$state"
    mkdir -p "$state"
    # The untracked files the build read: git-ai, the sidecars, the docs data and archives.
    git ls-files -z --others --ignored --exclude-standard -- src-tauri codesense-docs >"$state/inputs.list"
    tar --null -T "$state/inputs.list" -cf "$state/inputs.tar"
    xargs -0 -r shasum -a 256 <"$state/inputs.list" >"$state/inputs.sha256"
    # Last, so a record cut short names no commit and the next run builds cold.
    git rev-parse HEAD >"$state/source-sha"
}

restore() {
    local cached log
    cached=$(cat "$state/source-sha" 2>/dev/null || true)
    if [[ -z "$cached" || ! -f "$state/inputs.tar" || ! -f "$state/inputs.sha256" ]] ||
        ! git cat-file -e "$cached^{commit}" 2>/dev/null; then
        echo "The cached build names no commit in this checkout, or lacks its inputs, so it is removed: a cold build."
        rm -rf target
        return
    fi
    echo "The cached build is of $cached; what changed since then is dated now."
    # Its untracked inputs, with their dates. A file tracked since gets the checkout's content back
    # (git compares names as it stores them, which a list of tar's names may not match).
    tar -xf "$state/inputs.tar"
    git checkout -q -- .
    git ls-files -z | xargs -0 -r touch -h -t "$old"
    # session-server's build script reruns when HEAD moves (it watches the reflog), so its build
    # stamp in these test builds names the cached build's commit.
    log=$(git rev-parse --git-path logs/HEAD)
    if [[ -e "$log" ]]; then touch -t "$old" "$log"; fi
    date_tree
}

pin() {
    if [[ ! -f "$state/source-sha" ]]; then return; fi
    # Each untracked input whose content is what the cached build read goes back to the old date,
    # however the steps since rewrote it.
    { shasum -a 256 -c "$state/inputs.sha256" 2>/dev/null || true; } |
        sed -n 's/: OK$//p' | tr '\n' '\0' | xargs -0 -r touch -h -t "$old"
    date_tree
}

case "${1:-}" in
    record | restore | pin) "$1" ;;
    *)
        echo "usage: $0 record|restore|pin" >&2
        exit 1
        ;;
esac
