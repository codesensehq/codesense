#!/bin/bash
# Throwaway: diagnose the PDF renderer test hang. Not for merge.
set -uo pipefail
export G_MESSAGES_DEBUG=all WEBKIT_DEBUG=Network,Loading,Process WEBKIT_DISABLE_DMABUF_RENDERER=1 RUST_BACKTRACE=1
echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope >/dev/null
sudo locale-gen de_DE.UTF-8 >/dev/null
OUT="${RUNNER_TEMP:-/tmp}/pdf-diag"
mkdir -p "$OUT"
NT=(cargo nextest run --profile ci --locked -p codesense --lib --retries 0 --run-ignored all --no-fail-fast)
P=commands::export_pdf::render::tests::

descendants() { local c; for c in $(pgrep -P "$1"); do echo "$c"; descendants "$c"; done; }

dump() {
    local p
    for p in "$@"; do
        echo "----- pid $p ($(cat /proc/$p/comm 2>/dev/null)): $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -c1-160)"
        echo "      wchan=$(cat /proc/$p/wchan 2>/dev/null) state=$(awk '/^State/ {print $2}' /proc/$p/status 2>/dev/null)"
        sudo timeout 60 gdb -p "$p" -batch -ex 'set pagination off' -ex 'thread apply all bt 30' 2>/dev/null |
            grep -E '^(Thread|#)' | cut -c1-200
    done
}

# watch <label> <seconds> <command...>
watch() {
    local label="$1" limit="$2" pid waited t
    shift 2
    xvfb-run -a "$@" >"$OUT/$label.log" 2>&1 &
    pid=$!
    for ((waited = 0; waited < limit; waited++)); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
        echo "=== WATCHDOG $label: still running after ${limit}s"
        for t in $(pgrep codesense_lib); do dump "$t" $(descendants "$t"); done
        pkill -KILL codesense_lib || true
        pkill -KILL -f WebKitWebProcess || true
        pkill -KILL -f WebKitNetworkProcess || true
        sleep 2
        pkill -KILL -P "$pid" || true
        kill -KILL "$pid" 2>/dev/null || true
        echo "=== $label: HUNG"
    else
        wait "$pid"
        echo "=== $label: exit $?"
    fi
    sed 's/\x1b\[[0-9;]*m//g' "$OUT/$label.log" | grep -E 'TIMEOUT|FAIL \[|Summary' | cut -c1-200
    if grep -q 'HUNG' <<<"$(tail -n 1 /dev/null)"; then :; fi
}

markers() { sed 's/\x1b\[[0-9;]*m//g' "$OUT/$1.log" | grep -aE 'diag:|START|PASS|TIMEOUT' | tail -n "${2:-40}" | cut -c1-200; }

round() {
    local tag="$1" i
    for i in 1 2 3; do watch "$tag-suite-$i" 240 "${NT[@]}" -E "test(/^${P}/)"; done
    for i in $(seq 1 10); do
        watch "$tag-drop-$i" 45 "${NT[@]}" --no-capture -E "test(=${P}dropping_an_export_destroys_its_window)"
        watch "$tag-html-$i" 45 "${NT[@]}" --no-capture -E "test(=${P}html_prints_to_a_pdf)"
    done
    for f in "$OUT/$tag"-*.log; do
        if sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -qE 'TIMEOUT|FAIL \['; then
            echo "##### markers of $(basename "$f")"; markers "$(basename "$f" .log)" 60
        fi
    done
}

echo "################ BASE"
round base
echo "################ VARIANT (stop_loading + terminate_web_process before destroy)"
PDF_DIAG_TERMINATE=1 round variant
