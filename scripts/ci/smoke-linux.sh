#!/bin/bash
# SPDX-License-Identifier: MIT
# Packaging smoke for the Linux test build: install the deb and the rpm in clean containers, and
# launch the extracted AppImage headless. Release builds carry no WebDriver, so the launch checks
# read the process, the screen and the app's log.
#
# Usage:
#   smoke-linux.sh install <deb|rpm> <image> <package-dir> <out-dir>
#       Install the one .deb or .rpm under <package-dir> in <image>, a <name>:<tag> listed in
#       smoke-images.txt and run by its pinned digest. The distribution's resolver must find
#       every dependency, and the package's file list (kept as <out-dir>/<deb|rpm>.list) must
#       hold the app binary and its three sidecars.
#   smoke-linux.sh same-resources <listing> <listing>
#       Both file lists ship the same optional resources (resources/starship, resources/git-ai).
#   smoke-linux.sh run <package-dir> <out-dir>
#       Extract the one .AppImage under <package-dir> into <out-dir>, check that every shared
#       library its executables link resolves on this machine, and launch it under
#       xvfb-run inside dbus-run-session, trying to unlock a keyring: it is alive at 30 s, has
#       drawn a window that is not one colour, logs webview ready, a caps: line that agrees with
#       the bundle (caps-agree) and a secret store: line, and exits within 10 s of SIGTERM.
#       Which store that line names is not checked here (see SECRET_SERVICE_SKIP): the keyring
#       is set up best effort, and its diagnostics are logged. Each launch leaves <mode>.log and
#       <mode>.png in <out-dir>.
#   smoke-linux.sh variant <dmabuf|no-dbus> <out-dir>
#       Launch the AppImage run extracted into <out-dir> again. dmabuf: with the user's
#       WEBKIT_DISABLE_DMABUF_RENDERER=0, which the app keeps (the WebKit web process has it, and
#       the log says nothing of it), the screen check still passes. no-dbus: with no session bus
#       (outside dbus-run-session, at an address that does not exist, so none autolaunches), the
#       app stays up and logs secret store: unavailable.
#   smoke-linux.sh caps-agree <listing> <log>
#       The log has one caps: line, and its starship and git-ai are on exactly when the file
#       list holds resources/starship and resources/git-ai.
#   smoke-linux.sh check-listing <listing>
#       The /usr/bin check install runs on a file list.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGES="$SCRIPT_DIR/smoke-images.txt"
SELF="$SCRIPT_DIR/smoke-linux.sh"
SIDECARS=(codesense-bridge codesense-session-server codesense-emulator)
# Resources the bundle carries only where the platform turns them on.
OPTIONAL_RESOURCES=(starship git-ai)
# Why a launch inside dbus-run-session does not require secret store: secret-service.
SECRET_SERVICE_SKIP="skipped: secret store: secret-service: the Secret Service fixture under dbus-run-session is unreliable on the hosted x86_64 runner; the Rust (Linux app) job covers the Secret Service backend"

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

# Whether file list <listing> holds resources/<name>.
bundled() {
    grep -Eq "(^|/)resources/$1\$" "$2"
}

# The optional resources a file list holds, one resources/<name> a line.
resources_in() {
    local name
    for name in "${OPTIONAL_RESOURCES[@]}"; do
        if bundled "$name" "$1"; then echo "resources/$name"; fi
    done
}

same_resources() {
    local first second
    first=$(resources_in "$1" | paste -sd ' ' -)
    second=$(resources_in "$2" | paste -sd ' ' -)
    [[ "$first" == "$second" ]] || fail "$1 lists ${first:-no optional resources}, $2 lists ${second:-none}"
    echo "Both list: ${first:-no optional resources}"
}

# The log as plain text: the console log colours each line.
plain_log() {
    sed "s/$(printf '\033')\[[0-9;]*m//g" "$1"
}

# A capability the bundle can only have with its binary is on exactly when the binary is there,
# so the check holds whichever of them a build turns on.
caps_agree() {
    local listing="$1" line count name state
    line=$(plain_log "$2" | grep -E '(^| )caps:( [[:alnum:]-]+=(on|off))+ *$' || true)
    count=$(grep -c . <<<"$line" || true)
    [[ "$count" -eq 1 ]] || fail "expected one caps: line, found $count"
    for name in "${OPTIONAL_RESOURCES[@]}"; do
        state=$(grep -oE " $name=(on|off)" <<<"$line" | cut -d= -f2 || true)
        if bundled "$name" "$listing"; then
            [[ "$state" == on ]] || fail "caps: $name=${state:-<none>}, but resources/$name is bundled"
        else
            [[ "$state" == off ]] || fail "caps: $name=${state:-<none>}, but resources/$name is not bundled"
        fi
    done
    echo "The caps: line agrees with the bundle: ${line#*caps:}"
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

# Whether <pid> is running: a child that has exited stays a zombie until it is reaped.
alive() {
    [[ -e "/proc/$1" ]] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status"
}

run_appimage() {
    local appimage out="$2"
    appimage=$(realpath "$(only_file "$1" "*.AppImage")")
    rm -rf "$out"
    mkdir -p "$out"
    out=$(realpath "$out")
    chmod +x "$appimage"
    # The runners have no FUSE to mount the image, so the smoke runs the extracted tree.
    (cd "$out" && "$appimage" --appimage-extract >/dev/null)
    find "$out/squashfs-root" >"$out/listing"
    resolve_libs "$out/squashfs-root"
    start_session default "$out"
}

# The app and its WebKit helper processes find every shared library they link. An AppImage leaves
# out what every desktop has (GL and EGL among them), so this names whatever the runner lacks,
# all at once, before a launch fails on the first. A bare ldd does not see the library paths the
# AppImage sets up, so a library the extracted tree holds counts as found; the launch shows
# whether it loads.
resolve_libs() {
    local missing
    missing=$(comm -23 \
        <(find "$1/usr/bin" "$1/usr/lib" -type f \( -path "$1/usr/bin/*" -o -name 'WebKit*Process' \) \
            -exec ldd {} \; 2>/dev/null | awk '/not found/ {print $1}' | sort -u) \
        <(find "$1" -name '*.so*' -printf '%f\n' | sort -u))
    [[ -z "$missing" ]] || fail "the runner lacks these libraries the AppImage expects: $(paste -sd ' ' - <<<"$missing")"
    echo "Every library the app and its WebKit processes link resolves, or is in the AppImage"
}

# A fresh home and runtime directory for each launch, then the session its mode needs.
start_session() {
    local mode="$1" out="$2"
    # The keyring daemon and the app share HOME and its data directory.
    export HOME="$out/$mode-home" XDG_RUNTIME_DIR="$out/$mode-runtime" XDG_DATA_HOME="$out/$mode-home/.local/share"
    mkdir -p "$XDG_DATA_HOME"
    mkdir -m 700 "$XDG_RUNTIME_DIR"
    case "$mode" in
        default) dbus-run-session -- bash "$SELF" desktop "$mode" "$out" ;;
        dmabuf) WEBKIT_DISABLE_DMABUF_RENDERER=0 dbus-run-session -- bash "$SELF" desktop "$mode" "$out" ;;
        no-dbus)
            DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
                xvfb-run -a -s "-screen 0 1280x800x24" bash "$SELF" launch "$mode" "$out"
            ;;
        *) usage ;;
    esac
}

# Inside dbus-run-session: an empty password unlocks the login keyring (creating it), which
# then serves the Secret Service on the session bus.
desktop() {
    local line
    # Best effort: a throwaway password creates and unlocks the login keyring, the Secret
    # Service's default collection, and --unlock prints what to export. Nothing here fails the
    # run; the log shows what the Secret Service ended up with.
    mkdir -p "$XDG_DATA_HOME/keyrings"
    echo login >"$XDG_DATA_HOME/keyrings/default"
    while IFS= read -r line; do
        if [[ "$line" == *=* ]]; then export "${line?}"; fi
    done < <(printf smoke | gnome-keyring-daemon --unlock --components=secrets || true)
    secret_service_diagnostics
    xvfb-run -a -s "-screen 0 1280x800x24" bash "$SELF" launch "$@"
}

# What owns the Secret Service on this bus, the keyrings on disk, its collections and its default.
secret_service_diagnostics() {
    local bus=(dbus-send --session --print-reply)
    local secrets=("${bus[@]}" --dest=org.freedesktop.secrets /org/freedesktop/secrets)
    echo "Secret Service owner: $("${bus[@]}" --dest=org.freedesktop.DBus /org/freedesktop/DBus \
        org.freedesktop.DBus.GetNameOwner string:org.freedesktop.secrets 2>&1)"
    ls -la "$XDG_DATA_HOME/keyrings" || true
    echo "Secret Service collections: $("${secrets[@]}" org.freedesktop.DBus.Properties.Get \
        string:org.freedesktop.Secret.Service string:Collections 2>&1)"
    echo "Secret Service default alias: $("${secrets[@]}" org.freedesktop.Secret.Service.ReadAlias \
        string:default 2>&1)"
}

# Every process started under <pid>, at any depth.
descendants() {
    local child
    for child in $(pgrep -P "$1"); do
        echo "$child"
        descendants "$child"
    done
}

# The app keeps the user's WEBKIT_DISABLE_DMABUF_RENDERER=0: its own environment and its WebKit
# web processes' still have it.
kept_dmabuf() {
    local app="$1" web=() child
    for child in $(descendants "$app"); do
        # comm holds the first 15 bytes of the name.
        if [[ $(cat "/proc/$child/comm" 2>/dev/null) == WebKitWebProces* ]]; then web+=("$child"); fi
    done
    ((${#web[@]})) || fail "the app started no WebKitWebProcess"
    for child in "$app" "${web[@]}"; do
        grep -qxz WEBKIT_DISABLE_DMABUF_RENDERER=0 "/proc/$child/environ" ||
            fail "process $child ($(cat "/proc/$child/comm")) lost WEBKIT_DISABLE_DMABUF_RENDERER=0"
    done
    echo "The app and ${#web[@]} WebKit web process(es) keep WEBKIT_DISABLE_DMABUF_RENDERER=0"
}

# Inside xvfb-run: launch the app, check it while it runs, stop it, then check its log.
launch() {
    local mode="$1" out="$2" log="$1.log" shot="$1.png" pid waited
    cd "$out"
    "$out/squashfs-root/AppRun" >"$log" 2>&1 &
    pid=$!
    # Nothing the launch started outlives it, and a failed launch shows its log.
    # shellcheck disable=SC2064 # expand now: the trap runs after these locals are gone
    trap "status=\$?; pkill -KILL -f '$out/squashfs-root/' || true; ((status == 0)) || tail -n 200 '$log' >&2" EXIT
    sleep 30
    alive "$pid" || fail "the app exited within 30 s"
    echo "The app is alive at 30 s"
    if [[ "$mode" != no-dbus ]]; then
        import -window root "$shot"
        [[ $(identify -format '%k' "$shot") -gt 1 ]] || fail "the screen is one colour (see $shot)"
        echo "The screen is not one colour"
    fi
    if [[ "$mode" == dmabuf ]]; then kept_dmabuf "$pid"; fi
    kill -TERM "$pid"
    for ((waited = 0; waited < 10; waited++)); do
        alive "$pid" || break
        sleep 1
    done
    if alive "$pid"; then fail "the app is still running 10 s after SIGTERM"; fi
    wait "$pid" || true
    echo "The app exited within 10 s of SIGTERM"
    plain_log "$log" >"$mode.txt"
    grep -q "webview ready" "$mode.txt" || fail "the log has no webview ready"
    caps_agree listing "$log"
    grep -qE "(^| )secret store: " "$mode.txt" || fail "the log has no secret store: line"
    if [[ "$mode" == no-dbus ]]; then
        grep -qE "(^| )secret store: unavailable\$" "$mode.txt" || fail "the log has no secret store: unavailable"
        echo "The log has webview ready and secret store: unavailable"
    else
        echo "The log has webview ready and a secret store: line"
        echo "$SECRET_SERVICE_SKIP"
    fi
    if [[ "$mode" == dmabuf ]] && grep -qi dmabuf "$mode.txt"; then
        fail "the log mentions DMABUF; the app should keep the user's value without a word"
    fi
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
    run)
        [[ $# -eq 2 ]] || usage
        run_appimage "$@"
        ;;
    variant)
        [[ $# -eq 2 && "$1" =~ ^(dmabuf|no-dbus)$ ]] || usage
        [[ -d "$2/squashfs-root" ]] || fail "$2 has no extracted AppImage; smoke-linux.sh run extracts it"
        start_session "$1" "$(realpath "$2")"
        ;;
    desktop | launch)
        [[ $# -eq 2 ]] || usage
        "$command" "$@"
        ;;
    caps-agree)
        [[ $# -eq 2 ]] || usage
        caps_agree "$@"
        ;;
    check-listing)
        [[ $# -eq 1 ]] || usage
        check_listing "$@"
        ;;
    *) usage ;;
esac
