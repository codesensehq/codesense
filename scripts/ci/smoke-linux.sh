#!/bin/bash
# SPDX-License-Identifier: MIT
# Packaging smoke for the Linux test build: install the deb and the rpm in clean containers, and
# launch the extracted AppImage headless. Release builds carry no WebDriver, so the launch checks
# read the process, the app window and the app's log.
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
#       xvfb-run inside dbus-run-session with an unlocked login keyring as the Secret Service's
#       default collection: it is alive at 30 s, has drawn a window that is not one colour, logs
#       webview ready, a caps: line that agrees with the bundle (caps-agree) and secret store:
#       secret-service, and exits within 10 s of SIGTERM, having installed the bundled git-ai
#       at the pinned version (installed-git-ai). Each launch leaves <mode>.log and
#       <mode>.png in <out-dir>.
#   smoke-linux.sh variant <dmabuf|no-dbus> <out-dir>
#       Launch the AppImage run extracted into <out-dir> again. dmabuf: with the user's
#       WEBKIT_DISABLE_DMABUF_RENDERER=0, which the app keeps (the WebKit web process has it, and
#       the log says nothing of it), the window check still passes. no-dbus: with no session bus
#       (outside dbus-run-session, at an address that does not exist, so none autolaunches), the
#       app stays up and logs secret store: unavailable.
#   smoke-linux.sh caps-agree <listing> <log>
#       The log has one caps: line, and its starship and git-ai are on exactly when the file
#       list holds resources/starship and resources/git-ai.
#   smoke-linux.sh installed-git-ai <listing> <home> <pin>
#       When the file list holds resources/git-ai, the app installed <home>/.codesense/bin/git-ai
#       and it prints the version= of <pin>; when it does not, the app installed none.
#   smoke-linux.sh check-listing <listing>
#       The /usr/bin check install runs on a file list.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGES="$SCRIPT_DIR/smoke-images.txt"
SELF="$SCRIPT_DIR/smoke-linux.sh"
APP_BINARY=codesense
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

# The app binary and the three sidecars, and nothing else, in /usr/bin.
check_listing() {
    local bin name
    bin=$(grep -E '^/usr/bin/[^/]+$' "$1" || true)
    for name in "$APP_BINARY" "${SIDECARS[@]}"; do
        grep -qx "/usr/bin/$name" <<<"$bin" || fail "$name is not in /usr/bin of $1"
    done
    [[ $(grep -c . <<<"$bin") -eq 4 ]] ||
        fail "expected only $APP_BINARY and its three sidecars in /usr/bin of $1, found: $(tr '\n' ' ' <<<"$bin")"
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

# The app installs the bundled git-ai into its home at startup, so its own pin decides the
# version a running app gets; the caps: line alone would not show that.
installed_git_ai() {
    local listing="$1" installed="$2/.codesense/bin/git-ai" pin="$3" expected version
    if ! bundled git-ai "$listing"; then
        [[ ! -e "$installed" ]] || fail "the app installed $installed, but resources/git-ai is not bundled"
        echo "git-ai is not bundled, and the app installed none"
        return
    fi
    expected=$(sed -n 's/^version=//p' "$pin")
    [[ -n "$expected" ]] || fail "$pin has no version"
    [[ -x "$installed" ]] || fail "the app did not install git-ai at $installed"
    version=$("$installed" --version) || fail "$installed failed to run"
    version=${version%%$'\n'*}
    [[ "$version" == "$expected" ]] || fail "the installed git-ai prints $version, not the pinned $expected"
    echo "The app installed git-ai $version, as pinned in $pin"
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
    # The keyring daemon and the app share HOME and its data directory. The names are neutral, so
    # a path in the app's log never names the mode a check looks for.
    HOME=$(mktemp -d "$out/home.XXXXXX")
    XDG_RUNTIME_DIR=$(mktemp -d "$out/runtime.XXXXXX")
    export HOME XDG_RUNTIME_DIR XDG_DATA_HOME="$HOME/.local/share"
    mkdir -p "$XDG_DATA_HOME"
    case "$mode" in
        default) dbus-run-session -- bash "$SELF" desktop "$mode" "$out" ;;
        dmabuf) WEBKIT_DISABLE_DMABUF_RENDERER=0 dbus-run-session -- bash "$SELF" desktop "$mode" "$out" ;;
        no-dbus) DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent in_xvfb "$mode" "$out" ;;
        *) usage ;;
    esac
}

# Launch the app (launch <mode> <out-dir>) on a virtual X display of its own.
in_xvfb() {
    xvfb-run -a -s "-screen 0 1280x800x24" bash "$SELF" launch "$@"
}

# Inside dbus-run-session: unlock a login keyring for the Secret Service, then launch.
desktop() {
    local line
    # The app's store is the Secret Service's default collection: the login keyring, which a
    # throwaway password creates and unlocks (an empty one creates none here). --unlock starts
    # the daemon and prints what to export; --start would replace it and lose the login keyring.
    mkdir -p "$XDG_DATA_HOME/keyrings"
    echo login >"$XDG_DATA_HOME/keyrings/default"
    while IFS= read -r line; do
        if [[ "$line" == *=* ]]; then export "${line?}"; fi
    done < <(printf smoke | gnome-keyring-daemon --unlock --components=secrets)
    default_collection
    in_xvfb "$@"
}

# A Secret Service call on this session's bus, printing the reply.
secret_service() {
    dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets "$@" 2>&1 || true
}

# The Secret Service on this bus has a stored default collection, as the app's probe needs: the
# login keyring, never the in-memory session collection, which no desktop uses as its store. The
# owner is logged only: the bus may activate the daemon on the first call.
default_collection() {
    local login=/org/freedesktop/secrets/collection/login alias collections
    echo "Secret Service owner: $(dbus-send --session --print-reply --dest=org.freedesktop.DBus \
        /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner string:org.freedesktop.secrets 2>&1)"
    ls -la "$XDG_DATA_HOME/keyrings"
    collections=$(secret_service org.freedesktop.DBus.Properties.Get \
        string:org.freedesktop.Secret.Service string:Collections)
    echo "Secret Service collections: $collections"
    alias=$(secret_service org.freedesktop.Secret.Service.ReadAlias string:default)
    if ! grep -q "\"$login\"" <<<"$alias" && grep -q "\"$login\"" <<<"$collections"; then
        secret_service org.freedesktop.Secret.Service.SetAlias string:default "objectpath:$login"
        alias=$(secret_service org.freedesktop.Secret.Service.ReadAlias string:default)
    fi
    echo "Secret Service default alias: $alias"
    grep -q "\"$login\"" <<<"$alias" || fail "the Secret Service's default collection is not the login keyring"
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

# The X window id of the app's largest visible window, and its size as <width>x<height>.
app_window() {
    local id size area best="" best_size="" best_area=0
    for id in $(xdotool search --onlyvisible --pid "$1" 2>/dev/null); do
        size=$(xwininfo -id "$id" | awk '/Width:/ {w = $2} /Height:/ {h = $2} END {print w "x" h}')
        area=$((${size%x*} * ${size#*x}))
        if ((area > best_area)); then best=$id best_size=$size best_area=$area; fi
    done
    [[ -n "$best" ]] || {
        xwininfo -root -tree >&2
        fail "the app has no visible window"
    }
    echo "$best $best_size"
}

# The app's window is not one colour. It is shot alone: the root window around it is black, so
# a screen shot would count two colours for a blank window. The window is the webview alone (no
# window manager draws a frame here, and the app has no menu bar on Linux), so a blank page is
# one colour and fails; no threshold is needed.
window_drawn() {
    local found window size colours
    found=$(app_window "$1")
    read -r window size <<<"$found"
    import -window "$window" "$2"
    colours=$(identify -format '%k' "$2")
    echo "The app window ($size) has $colours colours"
    ((colours > 1)) || fail "the app window is one colour (see $2)"
}

# Inside xvfb-run: launch the app, check it while it runs, stop it, then check its log.
launch() {
    local mode="$1" out="$2" log="$1.log" shot="$1.png" pid waited pin store=secret-service
    if [[ "$mode" == no-dbus ]]; then store=unavailable; fi
    cd "$out"
    "$out/squashfs-root/AppRun" >"$log" 2>&1 &
    pid=$!
    # Nothing the launch started outlives it, and a failed launch shows its log.
    # shellcheck disable=SC2064 # expand now: the trap runs after these locals are gone
    trap "status=\$?; pkill -KILL -f '$out/squashfs-root/' || true; ((status == 0)) || tail -n 200 '$log' >&2" EXIT
    sleep 30
    alive "$pid" || fail "the app exited within 30 s"
    echo "The app is alive at 30 s"
    if [[ "$mode" != no-dbus ]]; then window_drawn "$pid" "$shot"; fi
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
    caps_agree listing "$mode.txt"
    pin=$(cd "$ROOT" && bash scripts/fetch-bundled.sh --print-pin git-ai)
    installed_git_ai listing "$HOME" "$ROOT/$pin"
    grep -qE "(^| )secret store: $store\$" "$mode.txt" || fail "the log has no secret store: $store"
    echo "The log has webview ready and secret store: $store"
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
    installed-git-ai)
        [[ $# -eq 3 ]] || usage
        installed_git_ai "$@"
        ;;
    check-listing)
        [[ $# -eq 1 ]] || usage
        check_listing "$@"
        ;;
    *) usage ;;
esac
