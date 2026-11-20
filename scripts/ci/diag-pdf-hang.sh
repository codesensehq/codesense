#!/bin/bash
# Throwaway: diagnose the PDF renderer test hang. Not for merge.
set -uo pipefail
export G_MESSAGES_DEBUG=all GTK_DEBUG=printing WEBKIT_DISABLE_DMABUF_RENDERER=1 RUST_BACKTRACE=1
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
        echo "----- pid $p: $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -c1-200)"
        echo "      wchan=$(cat /proc/$p/wchan 2>/dev/null) state=$(awk '/^State/ {print $2}' /proc/$p/status 2>/dev/null)"
        sudo gdb -p "$p" -batch -ex 'set pagination off' -ex 'thread apply all bt 40' 2>/dev/null |
            grep -E '^(Thread|#)' | cut -c1-220
    done
}

# watch <label> <seconds> <command...>: run under xvfb-run; past <seconds>, dump every
# test process and its children (WebKit web and network processes), then kill it all.
watch() {
    local label="$1" limit="$2" pid waited tests
    shift 2
    xvfb-run -a "$@" >"$OUT/$label.log" 2>&1 &
    pid=$!
    for ((waited = 0; waited < limit; waited++)); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
        echo "=== WATCHDOG $label: still running after ${limit}s"
        tests=$(pgrep -f 'codesense_lib-[0-9a-f]+ .*--exact' || true)
        for t in $tests; do dump "$t" $(descendants "$t"); done
        pkill -KILL -f 'codesense_lib-[0-9a-f]+' || true
        pkill -KILL -P "$pid" || true
        kill -KILL "$pid" 2>/dev/null || true
        echo "=== $label: HUNG"
    else
        wait "$pid"
        echo "=== $label: exit $?"
    fi
    grep -E 'PASS|FAIL|TIMEOUT|panicked|Summary' "$OUT/$label.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-200
    echo "--- $label: GTK printing and WebKit messages (last 60)"
    grep -aiE 'print|backend|cups|avahi|webkit|Gtk-|GLib-' "$OUT/$label.log" | grep -v 'PASS\|SLOW' | tail -n 60 | cut -c1-220
}

watch suite-serial 600 "${NT[@]}" --test-threads 1 -E "test(/^${P}/)"
for i in 1 2 3 4 5; do
    watch "html-$i" 45 "${NT[@]}" --no-capture -E "test(=${P}html_prints_to_a_pdf)"
    watch "german-$i" 45 "${NT[@]}" --no-capture -E "test(=${P}a_german_locale_still_finds_the_file_printer)"
done
