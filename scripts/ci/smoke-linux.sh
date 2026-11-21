#!/bin/bash
# SPDX-License-Identifier: MIT
# Packaging smoke for the Linux test build: install the deb and the rpm in clean containers and
# launch each installed app headless there, and launch the extracted AppImage headless. Release
# builds carry no WebDriver, so the launch checks read the process, the app window and the app's
# log.
#
# Usage:
#   smoke-linux.sh install <deb|rpm> <image> <package-dir> <out-dir>
#       Install the one .deb or .rpm under <package-dir> in <image>, a <name>:<tag> listed in
#       smoke-images.txt and run by its pinned digest. The distribution's resolver must find
#       every dependency, ldconfig must then find the AppIndicator library the tray icon loads
#       (the package depends on it), and the package's file list (kept as
#       <out-dir>/<deb|rpm>.list) must hold the app binary and its three sidecars. The package
#       must name WebKitGTK 4.1 and GTK 3 among its dependencies (depends). The session tools
#       are installed only after the install and the depends check, so neither can lean on
#       them. Then the installed app launches once in the container, as run launches the
#       AppImage (the default launch, leaving default.log and default.png in <out-dir>/launch).
#       A deb image's apt fetches from SMOKE_APT_MIRROR (apt-mirror), with retries and short
#       timeouts. When SMOKE_APT_CACHE names a directory, a deb image uses it as its apt archives
#       and keeps what it fetches there (apt-keep), so a cache of that directory saves the next
#       run the download. An rpm image runs with IPC_LOCK, which Fedora's keyring daemon needs.
#   smoke-linux.sh cache-key <image> <package-dir> <week>
#       Print key= and restore= lines for the apt archive cache of the one .deb under
#       <package-dir> in <image>: the key holds the deb's architecture, the image's pinned
#       digest, a hash of the deb's Depends and <week> (YYYY-Www), so the archives roll weekly;
#       restore= is the key's prefix up to the digest.
#   smoke-linux.sh depends <deb|rpm> <package>
#       The package's dependency field names WebKitGTK 4.1 and GTK 3 by package:
#       libwebkit2gtk-4.1-0 and libgtk-3-0 in a deb's Depends (dpkg-deb --field), webkit2gtk4.1
#       and gtk3 in an rpm's Requires (rpm -qpR). A resolver that installs the package does not
#       prove this: a dependency it pulls in for another could bring them along.
#   smoke-linux.sh apt-keep <apt.conf.d>
#       Keep the packages apt downloads: drop the Ubuntu images' docker-clean, which deletes
#       them after every install, and set APT::Keep-Downloaded-Packages.
#   smoke-linux.sh apt-mirror <mirror> <sources-file>...
#       Point every archive.ubuntu.com and security.ubuntu.com source in the files that exist at
#       <mirror>, an Ubuntu archive URL. ports.ubuntu.com, which arm64 uses, is left as it is.
#   smoke-linux.sh same-resources <listing> <listing>
#       Both file lists ship the same optional resources (resources/starship, resources/git-ai).
#   smoke-linux.sh run <package-dir> <out-dir>
#       Extract the one .AppImage under <package-dir> into <out-dir>, check that it bundles the
#       AppIndicator library (appindicator-bundled) and GTK's file print backend (print-backend),
#       and that every shared library its executables and that backend link resolves on this
#       machine, and launch it under
#       xvfb-run inside dbus-run-session with an unlocked login keyring as the Secret Service's
#       default collection: it is alive at 30 s, has drawn a window that is not one colour, logs
#       webview ready, a caps: line that agrees with the bundle (caps-agree) and secret store:
#       secret-service, and exits within 10 s of SIGTERM, having installed the bundled git-ai
#       at the pinned version (installed-git-ai), and logs terminal renderer: dom with the
#       render probe's verdict (ok, blank, no-frame or error: what WebGL drew under xvfb).
#       Release builds carry no WebDriver, so no launch opens a terminal tab: that terminals
#       show text is proven by the front end's Vitest rows. Each launch leaves <mode>.log and
#       <mode>.png in <out-dir>.
#   smoke-linux.sh variant <dmabuf|no-dbus|webgl|tray> <out-dir>
#       Launch the AppImage run extracted into <out-dir> again. dmabuf: with the user's
#       WEBKIT_DISABLE_DMABUF_RENDERER=0, which the app keeps (the WebKit web process has it, and
#       the log says nothing of it), the window check still passes. no-dbus: with no session bus
#       (outside dbus-run-session, at an address that does not exist, so none autolaunches), the
#       app stays up and logs secret store: unavailable. webgl: with
#       CODESENSE_TERMINAL_RENDERER=webgl, the app logs terminal renderer: webgl, probe skipped.
#       tray: with the tray icon setting turned on before the launch (seed-tray writes it into
#       the fresh home's app state), the app logs terminal-server-tray=on and turns the item on
#       (tray-launch). The launch first checks that ldconfig finds no AppIndicator library on
#       the runner (no-installed-appindicator), so only the AppImage's own copy can turn it on.
#   smoke-linux.sh caps-agree <listing> <log>
#       The log has one caps: line, and its starship and git-ai are on exactly when the file
#       list holds resources/starship and resources/git-ai, and its terminal-server-tray exactly
#       when the file list holds the AppIndicator library.
#   smoke-linux.sh installed-git-ai <listing> <home> <pin>
#       When the file list holds resources/git-ai, the app installed <home>/.codesense/bin/git-ai
#       and it prints the version= of <pin>; when it does not, the app installed none.
#   smoke-linux.sh check-listing <listing>
#       The /usr/bin check install runs on a file list.
#   smoke-linux.sh appindicator-bundled <listing>
#       The file list holds an AppIndicator library (libayatana-appindicator3 or
#       libappindicator3, .so or .so.1), which the tray icon loads.
#   smoke-linux.sh seed-tray <data-home>
#       Turn the tray icon setting on in the app state under <data-home> (XDG_DATA_HOME), as
#       the app saves it, before the app first starts there.
#   smoke-linux.sh tray-launch <log>
#       The log's caps: line has terminal-server-tray=on, and the app turned the item on.
#   smoke-linux.sh installed-appindicator
#       ldconfig finds an AppIndicator library, as install checks after the package installs.
#   smoke-linux.sh no-installed-appindicator
#       ldconfig finds no AppIndicator library, as the tray launch checks before it starts.
#   smoke-linux.sh print-backend <listing>
#       The extracted AppImage's file list holds GTK's file print backend
#       (gtk-3.0/<version>/printbackends/libprintbackend-file.so), which PDF export prints through.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGES="$SCRIPT_DIR/smoke-images.txt"
SELF="$SCRIPT_DIR/smoke-linux.sh"
APP_BINARY=codesense
SIDECARS=(codesense-bridge codesense-session-server codesense-emulator)
# The Ubuntu archive mirror a deb image's apt uses. GitHub's runners are on Azure, and their own
# apt uses this mirror; archive.ubuntu.com can crawl from there. Exported for the container.
export SMOKE_APT_MIRROR="${SMOKE_APT_MIRROR:-http://azure.archive.ubuntu.com/ubuntu/}"
# Resources the bundle carries only where the platform turns them on.
OPTIONAL_RESOURCES=(starship git-ai)
# The AppIndicator libraries the tray icon loads, by the names its loader tries.
APPINDICATOR='lib(ayatana-)?appindicator3\.so(\.1)?'
# The app's identifier (tauri.conf.json), which names its data directory.
APP_ID=ai.codesense
# The packages a deb and an rpm must depend on by name: WebKitGTK 4.1 and GTK 3.
DEB_DEPENDS=(libwebkit2gtk-4.1-0 libgtk-3-0)
RPM_DEPENDS=(webkit2gtk4.1 gtk3)
# The tools the launch uses inside an install container, beside what the package brings: the X
# server and what xvfb-run calls, window and screenshot tools, the session bus, its machine id
# and the keyring, pgrep, and the Mesa GL and EGL drivers WebKit renders with. An rpm image's dnf
# installs them by the files the launch runs.
DEB_SESSION_TOOLS=(xvfb xauth x11-utils xdotool dbus gnome-keyring imagemagick procps libegl1 libgl1
    libgles2 libgl1-mesa-dri)
RPM_SESSION_TOOLS=(/usr/bin/xvfb-run /usr/bin/xauth /usr/bin/mcookie /usr/bin/getopt /usr/bin/xdotool
    /usr/bin/xwininfo /usr/bin/dbus-run-session /usr/bin/dbus-send /usr/bin/dbus-uuidgen
    /usr/bin/gnome-keyring-daemon /usr/bin/import /usr/bin/identify /usr/bin/pgrep mesa-dri-drivers
    mesa-libEGL mesa-libGL)

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

# The SHA-256 of standard input, in hex.
sha256() {
    if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
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

# Whether file list <listing> holds an AppIndicator library.
has_appindicator() {
    grep -Eq "(^|/)$APPINDICATOR\$" "$1"
}

appindicator_bundled() {
    has_appindicator "$1" || fail "$1 holds no AppIndicator library (libayatana-appindicator3.so.1 or the like)"
    echo "The bundle holds $(grep -E "(^|/)$APPINDICATOR\$" "$1" | xargs -n1 basename | sort -u | paste -sd ' ' -)"
}

# The tray icon setting, on, where the app reads its saved state at startup.
seed_tray() {
    local dir="$1/$APP_ID"
    mkdir -p "$dir"
    printf '{"viewer":{"settings":{"terminalServerMenuBar":true}}}\n' >"$dir/app-state.json"
    echo "Seeded the tray icon setting on in $dir/app-state.json"
}

tray_launch() {
    local text
    text=$(plain_log "$1")
    grep -qE '(^| )caps:( [[:alnum:]-]+=(on|off))* terminal-server-tray=on( |$)' <<<"$text" ||
        fail "the caps: line does not have terminal-server-tray=on"
    grep -qE '\[terminal_server_tray\] menu-bar item on( |$)' <<<"$text" || fail "the log does not show the tray item turned on"
    echo "The log has terminal-server-tray=on and the tray item turned on"
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
    state=$(grep -oE " terminal-server-tray=(on|off)" <<<"$line" | cut -d= -f2 || true)
    if has_appindicator "$listing"; then
        [[ "$state" == on ]] || fail "caps: terminal-server-tray=${state:-<none>}, but the AppIndicator library is bundled"
    else
        [[ "$state" == off ]] || fail "caps: terminal-server-tray=${state:-<none>}, but no AppIndicator library is bundled"
    fi
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
    local type="$1" image="$2" package_dir="$3" out="$4" ref package cache=() caps=()
    [[ "$type" == deb || "$type" == rpm ]] || usage
    ref=$(image_ref "$image")
    package=$(only_file "$package_dir" "*.$type")
    mkdir -p "$out"
    if [[ "$type" == deb && -n "${SMOKE_APT_CACHE:-}" ]]; then
        mkdir -p "$SMOKE_APT_CACHE"
        cache=(-v "$SMOKE_APT_CACHE:/var/cache/apt/archives" -e SMOKE_KEEP_ARCHIVES=1)
        echo "apt archives: $(find "$SMOKE_APT_CACHE" -name '*.deb' | wc -l) cached in $SMOKE_APT_CACHE"
    fi
    # As root, Fedora's gnome-keyring-daemon keeps IPC_LOCK to lock its memory and aborts when it
    # cannot (Docker leaves it out), so the launch's keyring would never start. Ubuntu's does not
    # ask for it, so a deb image runs without it.
    if [[ "$type" == rpm ]]; then caps=(--cap-add IPC_LOCK); fi
    echo "Installing $(basename "$package") in $ref"
    # The whole checkout, read-only: the launch reads the git-ai pin through fetch-bundled.sh.
    docker run --rm ${caps[@]+"${caps[@]}"} -e SMOKE_APT_MIRROR ${cache[@]+"${cache[@]}"} \
        -v "$(dirname "$package"):/package:ro" -v "$ROOT:/src:ro" -v "$out:/out" \
        "$ref" bash /src/scripts/ci/smoke-linux.sh in-container "$type" "/package/$(basename "$package")" "/out/$type.list"
    check_listing "$out/$type.list"
    echo "$(basename "$package") installs in $image"
}

cache_key() {
    local image="$1" week="$3" ref deb arch depends prefix
    [[ "$week" =~ ^[0-9]{4}-W[0-9]{2}$ ]] || fail "$week is not a week as YYYY-Www"
    ref=$(image_ref "$image")
    deb=$(only_file "$2" "*.deb")
    arch=$(dpkg-deb --field "$deb" Architecture)
    depends=$(dpkg-deb --field "$deb" Depends)
    [[ -n "$arch" ]] || fail "$deb has no Architecture"
    prefix="smoke-apt-$arch-${image/:/-}-$(cut -c1-16 <<<"${ref#*@sha256:}")-"
    echo "key=$prefix$(sha256 <<<"$depends" | cut -c1-16)-$week"
    echo "restore=$prefix"
}

apt_keep() {
    rm -f "$1/docker-clean"
    printf 'APT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' \
        >"$1/80smoke-keep"
}

# Ubuntu 22.04 lists its sources in sources.list, 24.04 in ubuntu.sources (deb822); one pattern
# rewrites both.
apt_mirror() {
    local mirror="$1" file text
    shift
    for file in "$@"; do
        [[ -f "$file" ]] || continue
        text=$(sed -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#${mirror%/}/#g" "$file")
        printf '%s\n' "$text" >"$file"
    done
}

# The package names <deb|rpm> <package> depends on, one a line: a deb's Depends with versions,
# architecture qualifiers and alternatives split off, an rpm's Requires without versions.
depends_of() {
    local fields names
    case "$1" in
        deb)
            fields=$(dpkg-deb --field "$2" Depends) || fail "dpkg-deb cannot read $2"
            names=$(tr ',|' '\n' <<<"$fields" | sed -E 's/\(.*\)//; s/:[[:alnum:]]+//; s/[[:space:]]//g')
            ;;
        rpm)
            fields=$(rpm -qpR "$2") || fail "rpm cannot read $2"
            names=$(awk '{print $1}' <<<"$fields")
            ;;
    esac
    grep . <<<"$names" | sort -u || true
}

package_depends() {
    local type="$1" package="$2" names name wanted
    case "$type" in
        deb) wanted=("${DEB_DEPENDS[@]}") ;;
        rpm) wanted=("${RPM_DEPENDS[@]}") ;;
        *) usage ;;
    esac
    [[ -f "$package" ]] || fail "$package is not a file"
    names=$(depends_of "$type" "$package")
    for name in "${wanted[@]}"; do
        grep -qxF "$name" <<<"$names" ||
            fail "$(basename "$package") does not depend on $name; it depends on: $(paste -sd ' ' - <<<"$names")"
    done
    echo "$(basename "$package") depends on ${wanted[*]}"
}

# Runs inside the clean container: install with the distribution's resolver, list the files the
# package owns, read its dependencies, then launch the installed app.
in_container() {
    local type="$1" package="$2" listing="$3"
    case "$type" in
        deb)
            export DEBIAN_FRONTEND=noninteractive
            apt_mirror "$SMOKE_APT_MIRROR" /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources
            grep -hE '^(deb |URIs:)' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
            # A slow or dropped fetch is retried rather than waited on (apt waits 120 s by default).
            printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
                >/etc/apt/apt.conf.d/80smoke-retries
            if [[ -n "${SMOKE_KEEP_ARCHIVES:-}" ]]; then
                apt_keep /etc/apt/apt.conf.d
                mkdir -p /var/cache/apt/archives/partial
            fi
            apt-get update
            apt-get install -y --no-install-recommends "$package"
            # Versions the archive no longer has would only grow the cache.
            if [[ -n "${SMOKE_KEEP_ARCHIVES:-}" ]]; then apt-get autoclean; fi
            dpkg -L "$(dpkg-deb --field "$package" Package)" >"$listing"
            ;;
        rpm)
            dnf install -y "$package"
            rpm -ql "$(rpm -qp --queryformat '%{NAME}' "$package")" >"$listing"
            ;;
        *) usage ;;
    esac
    installed_appindicator
    package_depends "$type" "$package"
    launch_installed "$type" "$listing"
}

# Launch the installed app as run launches the AppImage. The session tools are installed only
# now, so whatever they bring in could not have helped the package's own install. Its file list,
# with the AppIndicator libraries its dependencies brought in (the tray icon loads them by name),
# is what the launch's caps: line must agree with.
launch_installed() {
    local type="$1" listing="$2" out
    case "$type" in
        deb) apt-get install -y --no-install-recommends "${DEB_SESSION_TOOLS[@]}" ;;
        rpm) dnf install -y "${RPM_SESSION_TOOLS[@]}" ;;
    esac
    # A container image has no machine id, which D-Bus clients read.
    dbus-uuidgen --ensure
    out="$(dirname "$listing")/launch"
    rm -rf "$out"
    mkdir -p "$out"
    { cat "$listing"; ldconfig_appindicator; } >"$out/listing"
    SMOKE_APP="/usr/bin/$APP_BINARY" start_session default "$out"
}

# The AppIndicator libraries ldconfig finds by name, one a line.
# A missing or failing ldconfig fails, so finding none means none.
ldconfig_appindicator() {
    local cache
    cache=$(ldconfig -p) || fail "ldconfig -p failed"
    grep -E "^[[:space:]]*$APPINDICATOR " <<<"$cache" | awk '{print $1}' || true
}

# The package's dependencies brought in an AppIndicator library the loader finds by name.
installed_appindicator() {
    local found
    found=$(ldconfig_appindicator)
    [[ -n "$found" ]] || fail "ldconfig finds no AppIndicator library after the install"
    echo "ldconfig finds: $(paste -sd ' ' - <<<"$found")"
}

# The runner has no AppIndicator library of its own, so a tray that turns on loaded the bundle's.
no_installed_appindicator() {
    local found
    found=$(ldconfig_appindicator)
    [[ -z "$found" ]] || fail "ldconfig already finds an AppIndicator library on this machine: $(paste -sd ' ' - <<<"$found")"
    echo "ldconfig finds no AppIndicator library on this machine"
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
    appindicator_bundled "$out/listing"
    print_backend "$out/listing"
    resolve_libs "$out/squashfs-root"
    start_session default "$out"
}

# PDF export prints through GTK's file printer, a module the AppImage's GTK loads from its own
# tree. resolve_libs then checks what the module links.
print_backend() {
    local module
    module=$(grep -E '/gtk-3\.0/[^/]+/printbackends/libprintbackend-file\.so$' "$1" || true)
    [[ -n "$module" ]] || fail "the AppImage has no GTK file print backend (libprintbackend-file.so), which PDF export prints through"
    echo "GTK's file print backend is in the AppImage: ${module##*/squashfs-root/}"
}

# The app, its WebKit helper processes and GTK's file print backend find every shared library they
# link. An AppImage leaves out what every desktop has (GL and EGL among them), so this names
# whatever the runner lacks, all at once, before a launch fails on the first. A bare ldd does not
# see the library paths the AppImage sets up, so a library the extracted tree holds counts as
# found; the launch shows whether it loads.
resolve_libs() {
    local missing
    missing=$(comm -23 \
        <(find "$1/usr/bin" "$1/usr/lib" -type f \( -path "$1/usr/bin/*" -o -name 'WebKit*Process' \
            -o -name libprintbackend-file.so \) -exec ldd {} \; 2>/dev/null | awk '/not found/ {print $1}' | sort -u) \
        <(find "$1" -name '*.so*' -printf '%f\n' | sort -u))
    [[ -z "$missing" ]] || fail "the runner lacks these libraries the AppImage expects: $(paste -sd ' ' - <<<"$missing")"
    echo "Every library the app, its WebKit processes and the print backend link resolves, or is in the AppImage"
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
        webgl) CODESENSE_TERMINAL_RENDERER=webgl dbus-run-session -- bash "$SELF" desktop "$mode" "$out" ;;
        tray)
            no_installed_appindicator
            seed_tray "$XDG_DATA_HOME"
            dbus-run-session -- bash "$SELF" desktop "$mode" "$out"
            ;;
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
    # Logged only: the daemon renames its temp files here, and one that vanishes mid-listing fails ls.
    ls -la "$XDG_DATA_HOME/keyrings" || true
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

# Inside xvfb-run: launch the app, check it while it runs, stop it, then check its log. The app is
# the extracted AppImage under <out-dir>, or SMOKE_APP, an installed app's binary; <out-dir>
# holds the file list (listing) its caps: line must agree with.
launch() {
    local mode="$1" out="$2" log="$1.log" shot="$1.png" pid waited pin store=secret-service app tree
    if [[ "$mode" == no-dbus ]]; then store=unavailable; fi
    # What the trap kills (a pattern): the AppImage's tree, or the installed binary, its sidecars
    # beside it and the system WebKit's helper processes.
    app="${SMOKE_APP:-$out/squashfs-root/AppRun}"
    tree="$out/squashfs-root/"
    if [[ -n "${SMOKE_APP:-}" ]]; then tree="$SMOKE_APP|/webkit2gtk-4\\.1/"; fi
    cd "$out"
    "$app" >"$log" 2>&1 &
    pid=$!
    # Nothing the launch started outlives it, and a failed launch shows its log.
    # shellcheck disable=SC2064 # expand now: the trap runs after these locals are gone
    trap "status=\$?; pkill -KILL -f '$tree' || true; ((status == 0)) || tail -n 200 '$log' >&2" EXIT
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
    terminal_renderer "$mode" "$mode.txt"
    if [[ "$mode" == tray ]]; then tray_launch "$mode.txt"; fi
}

# The front end logged its terminal renderer once: DOM on Linux after the render probe (whose
# verdict is printed), or WebGL with the probe skipped when the webgl variant forces it.
terminal_renderer() {
    local mode="$1" text="$2" lines want
    lines=$(grep -oE "terminal renderer: .*" "$text" || true)
    [[ -n "$lines" ]] || fail "the log has no terminal renderer line"
    [[ $(wc -l <<<"$lines") -eq 1 ]] || fail "the log has more than one terminal renderer line: $lines"
    if [[ "$mode" == webgl ]]; then
        want="^terminal renderer: webgl \(probe: skipped\), CODESENSE_TERMINAL_RENDERER=webgl\$"
    else
        want="^terminal renderer: dom \(probe: (ok|blank|no-frame|error)\)\$"
    fi
    grep -qE "$want" <<<"$lines" || fail "unexpected terminal renderer line: $lines"
    echo "The log has $lines"
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
    apt-mirror)
        [[ $# -ge 2 ]] || usage
        apt_mirror "$@"
        ;;
    cache-key)
        [[ $# -eq 3 ]] || usage
        cache_key "$@"
        ;;
    apt-keep)
        [[ $# -eq 1 ]] || usage
        apt_keep "$@"
        ;;
    depends)
        [[ $# -eq 2 ]] || usage
        package_depends "$@"
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
        [[ $# -eq 2 && "$1" =~ ^(dmabuf|no-dbus|webgl|tray)$ ]] || usage
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
    appindicator-bundled)
        [[ $# -eq 1 ]] || usage
        appindicator_bundled "$@"
        ;;
    seed-tray)
        [[ $# -eq 1 ]] || usage
        seed_tray "$@"
        ;;
    tray-launch)
        [[ $# -eq 1 ]] || usage
        tray_launch "$@"
        ;;
    installed-appindicator)
        [[ $# -eq 0 ]] || usage
        installed_appindicator
        ;;
    no-installed-appindicator)
        [[ $# -eq 0 ]] || usage
        no_installed_appindicator
        ;;
    print-backend)
        [[ $# -eq 1 ]] || usage
        print_backend "$@"
        ;;
    *) usage ;;
esac
