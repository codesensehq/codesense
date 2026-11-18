#!/bin/bash
# SPDX-License-Identifier: MIT
# Packaging smoke for the Linux test build: install the deb and the rpm in clean containers.
#
# Usage:
#   smoke-linux.sh install <deb|rpm> <image> <package-dir> <out-dir>
#       Install the one .deb or .rpm under <package-dir> in <image>, a <name>:<tag> listed in
#       smoke-images.txt and run by its pinned digest. The distribution's resolver must find
#       every dependency, and the package's file list (kept as <out-dir>/<deb|rpm>.list) must
#       hold the app binary and its three sidecars.
#   smoke-linux.sh same-resources <listing> <listing>
#       Both file lists ship the same optional resources (resources/starship, resources/git-ai).
#   smoke-linux.sh check-listing <listing>
#       The /usr/bin check install runs on a file list.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGES="$SCRIPT_DIR/smoke-images.txt"
SIDECARS=(codesense-bridge codesense-session-server codesense-emulator)
# Resources the bundle carries only where the platform turns them on.
OPTIONAL_RESOURCES=(starship git-ai)

usage() {
    sed -n 's/^#   //p' "$0" | grep "^smoke-linux.sh" | sed 's/^/usage: /' >&2
    exit 2
}

fail() {
    echo "Error: $*" >&2
    exit 1
}

# The one file under <dir> named like <glob>.
only_file() {
    local found
    found=$(find "$1" -type f -name "$2")
    [[ -n "$found" && $(wc -l <<<"$found") -eq 1 ]] || fail "expected one $2 under $1, found: ${found:-none}"
    echo "$found"
}

# The digest-pinned reference smoke-images.txt holds for <name>:<tag>.
image_ref() {
    local ref
    ref=$(awk -v prefix="$1@" 'index($0, prefix) == 1' "$IMAGES")
    [[ -n "$ref" ]] || fail "$1 is not pinned in $IMAGES"
    echo "$ref"
}

# The app binary and the three sidecars, and nothing else, in /usr/bin. The app binary's name
# comes from the product, so it is the one other file there.
check_listing() {
    local bin name
    bin=$(grep -E '^/usr/bin/[^/]+$' "$1" || true)
    for name in "${SIDECARS[@]}"; do
        grep -qx "/usr/bin/$name" <<<"$bin" || fail "$name is not in /usr/bin of $1"
    done
    [[ $(grep -c . <<<"$bin") -eq 4 ]] ||
        fail "expected the app binary and three sidecars in /usr/bin of $1, found: $(tr '\n' ' ' <<<"$bin")"
}

# The optional resources a file list holds, one resources/<name> a line.
resources_in() {
    local name
    for name in "${OPTIONAL_RESOURCES[@]}"; do
        if grep -Eq "(^|/)resources/$name\$" "$1"; then echo "resources/$name"; fi
    done
}

same_resources() {
    local first second
    first=$(resources_in "$1" | paste -sd ' ' -)
    second=$(resources_in "$2" | paste -sd ' ' -)
    [[ "$first" == "$second" ]] || fail "$1 lists ${first:-no optional resources}, $2 lists ${second:-none}"
    echo "Both list: ${first:-no optional resources}"
}

install_package() {
    local type="$1" image="$2" package_dir="$3" out="$4" ref package
    [[ "$type" == deb || "$type" == rpm ]] || usage
    ref=$(image_ref "$image")
    package=$(only_file "$package_dir" "*.$type")
    mkdir -p "$out"
    echo "Installing $(basename "$package") in $ref"
    docker run --rm \
        -v "$(dirname "$package"):/package:ro" -v "$SCRIPT_DIR:/smoke:ro" -v "$out:/out" \
        "$ref" bash /smoke/smoke-linux.sh in-container "$type" "/package/$(basename "$package")" "/out/$type.list"
    check_listing "$out/$type.list"
    echo "$(basename "$package") installs in $image"
}

# Runs inside the clean container: install with the distribution's resolver, then list the
# files the package owns.
in_container() {
    local type="$1" package="$2" listing="$3"
    case "$type" in
        deb)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update
            apt-get install -y --no-install-recommends "$package"
            dpkg -L "$(dpkg-deb --field "$package" Package)" >"$listing"
            ;;
        rpm)
            dnf install -y "$package"
            rpm -ql "$(rpm -qp --queryformat '%{NAME}' "$package")" >"$listing"
            ;;
        *) usage ;;
    esac
}

[[ $# -ge 1 ]] || usage
command="$1"
shift
case "$command" in
    install)
        [[ $# -eq 4 ]] || usage
        install_package "$@"
        ;;
    in-container)
        [[ $# -eq 3 ]] || usage
        in_container "$@"
        ;;
    same-resources)
        [[ $# -eq 2 ]] || usage
        same_resources "$@"
        ;;
    check-listing)
        [[ $# -eq 1 ]] || usage
        check_listing "$@"
        ;;
    *) usage ;;
esac
