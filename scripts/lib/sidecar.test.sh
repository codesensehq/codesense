#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Tests for scripts/lib/sidecar.sh, the sidecar naming the build scripts share.
# Runs under bash 3.2 (macOS /bin/bash) and Git Bash too. Everywhere it checks
# the helper's names, paths and .sha256 line; on Linux it also runs the three
# build scripts with SIDECAR_DRY_RUN=1 and checks the paths they print.

set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The root the helper derives the same way, so Git Bash's /d/a/... form matches.
ROOT="$(cd "$LIB_DIR/../.." && pwd)"
BINARIES="$ROOT/src-tauri/binaries"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
# Never from the repo root: the paths must not depend on the working directory.
cd "$TEST_DIR"

# bash 3.2 exits 0 when a missing file is sourced under an EXIT trap, so check first.
if [[ ! -f "$LIB_DIR/sidecar.sh" ]]; then
    echo "FAIL: $LIB_DIR/sidecar.sh not found" >&2
    exit 1
fi
# shellcheck source=SCRIPTDIR/sidecar.sh
. "$LIB_DIR/sidecar.sh"

FAILURES=0
fail() {
    echo "FAIL: $*" >&2
    FAILURES=$((FAILURES + 1))
}

expect_eq() {
    local what="$1" expected="$2" actual="$3"
    if [[ "$actual" != "$expected" ]]; then
        fail "$what: expected '$expected', got '$actual'"
    fi
}

# Goldens: triple, executable suffix.
while read -r triple suffix; do
    expect_eq "sidecar_exe_suffix $triple" "$suffix" "$(sidecar_exe_suffix "$triple")"
    for name in codesense-bridge codesense-session-server codesense-emulator; do
        expect_eq "sidecar_path $name $triple" "$BINARIES/$name-$triple$suffix" "$(sidecar_path "$name" "$triple")"
    done
done <<'EOF'
aarch64-apple-darwin
x86_64-apple-darwin
x86_64-unknown-linux-gnu
aarch64-unknown-linux-gnu
x86_64-unknown-linux-musl
aarch64-unknown-linux-musl
x86_64-pc-windows-msvc .exe
aarch64-pc-windows-msvc .exe
EOF

# The .sha256 line: "<hex>  <basename>", which sha256sum -c accepts.
mkdir -p "$TEST_DIR/sha"
SAMPLE="$TEST_DIR/sha/codesense-emulator-x86_64-pc-windows-msvc.exe"
printf 'sidecar\n' >"$SAMPLE"
LINE="$(sidecar_sha256_line "$SAMPLE")"
expect_eq "sidecar_sha256_line" \
    "51e4a9174e121b500c34897bfb469add9abf7c4731f3f2d0f3f67d9a05305350  codesense-emulator-x86_64-pc-windows-msvc.exe" \
    "$LINE"
printf '%s\n' "$LINE" >"$SAMPLE.sha256"
if command -v sha256sum >/dev/null 2>&1; then
    check=(sha256sum -c)
else
    check=(shasum -a 256 -c)
fi
if ! (cd "$TEST_DIR/sha" && "${check[@]}" "$(basename "$SAMPLE").sha256" >/dev/null); then
    fail "${check[*]} rejected '$LINE'"
fi

# The host triple comes from rustc; with no host line it fails with today's error.
rustc() { printf 'rustc 1.0.0\nhost: x86_64-pc-windows-msvc\nrelease: 1.0.0\n'; }
expect_eq "sidecar_host_triple" "x86_64-pc-windows-msvc" "$(sidecar_host_triple)"
rustc() { printf 'rustc 1.0.0\nrelease: 1.0.0\n'; }
if sidecar_host_triple >"$TEST_DIR/stdout" 2>"$TEST_DIR/stderr"; then
    fail "sidecar_host_triple succeeded with no host"
fi
expect_eq "sidecar_host_triple error" "Error: Could not determine Rust target triple" "$(cat "$TEST_DIR/stderr")"
expect_eq "sidecar_host_triple stdout" "" "$(cat "$TEST_DIR/stdout")"
unset -f rustc

# The callers' dry runs. Linux only: building sidecars for Windows comes later,
# and the macOS run is here to prove bash 3.2.
case "$(uname -s)" in
    Linux) ;;
    *)
        if [[ $FAILURES -gt 0 ]]; then
            exit 1
        fi
        echo "sidecar naming: ok (callers skipped on $(uname -s))"
        exit 0
        ;;
esac

HOST="x86_64-unknown-linux-gnu"
STUBS="$TEST_DIR/bin"
mkdir -p "$STUBS"
cat >"$STUBS/rustc" <<EOF
#!/usr/bin/env bash
printf 'rustc 1.0.0\nhost: $HOST\n'
EOF
# A dry run must stop before anything builds or downloads.
for tool in cargo docker curl unzip; do
    cat >"$STUBS/$tool" <<EOF
#!/usr/bin/env bash
echo "$tool \$*" >>"$TEST_DIR/called"
exit 1
EOF
done
chmod +x "$STUBS"/*

snapshot() {
    if [[ -d "$BINARIES" ]]; then
        (cd "$BINARIES" && find . -exec ls -ld {} + | sort)
    fi
}

# Runs a build script in dry-run mode and compares what it prints.
dry_run() {
    local expected="$1" script="$2"
    shift 2
    local before actual
    before="$(snapshot)"
    if ! actual="$(SIDECAR_DRY_RUN=1 PATH="$STUBS:$PATH" bash "$ROOT/scripts/$script" "$@" 2>"$TEST_DIR/stderr")"; then
        fail "$script $*: exited non-zero: $(cat "$TEST_DIR/stderr")"
    fi
    expect_eq "$script $* (dry run)" "$expected" "$actual"
    expect_eq "$script $* (binaries untouched)" "$before" "$(snapshot)"
    if [[ -e "$TEST_DIR/called" ]]; then
        fail "$script $*: ran $(cat "$TEST_DIR/called")"
        rm -f "$TEST_DIR/called"
    fi
}

# Each target's sidecar and .sha256, then the bridge copy and its .sha256.
session_server_lines() {
    local triple
    for triple in "$@"; do
        printf '%s\n' \
            "$BINARIES/codesense-session-server-$triple" \
            "$BINARIES/codesense-session-server-$triple.sha256" \
            "$BINARIES/codesense-bridge-$triple" \
            "$BINARIES/codesense-bridge-$triple.sha256"
    done
}

emulator_lines() {
    local triple
    for triple in "$@"; do
        printf '%s\n' "$BINARIES/codesense-emulator-$triple" "$BINARIES/codesense-emulator-$triple.sha256"
    done
}

MUSL="x86_64-unknown-linux-musl"
ARM_MUSL="aarch64-unknown-linux-musl"

dry_run "$BINARIES/codesense-bridge-$HOST" build-bridge.sh
dry_run "$BINARIES/codesense-bridge-$HOST" build-bridge.sh --release
dry_run "$(session_server_lines "$HOST")" build-session-server.sh
dry_run "$(session_server_lines "$HOST" "$MUSL" "$ARM_MUSL")" \
    build-session-server.sh --release --target "$HOST" --target "$MUSL" --target "$ARM_MUSL"
dry_run "$(emulator_lines "$HOST")" build-emulator.sh
dry_run "$(emulator_lines "$MUSL" "$ARM_MUSL" aarch64-apple-darwin)" \
    build-emulator.sh --release --target "$MUSL" --target "$ARM_MUSL" --target aarch64-apple-darwin

# The emulator's dry run comes after its runtime check: a triple with no Bun
# runtime still fails, and prints no path.
UNSUPPORTED="riscv64gc-unknown-linux-gnu"
if actual="$(SIDECAR_DRY_RUN=1 PATH="$STUBS:$PATH" bash "$ROOT/scripts/build-emulator.sh" --target "$UNSUPPORTED" 2>"$TEST_DIR/stderr")"; then
    fail "build-emulator.sh --target $UNSUPPORTED (dry run): exited 0"
fi
expect_eq "build-emulator.sh --target $UNSUPPORTED (dry run stdout)" "" "$actual"
expect_eq "build-emulator.sh --target $UNSUPPORTED (dry run stderr)" \
    "Error: no emulator runtime for $UNSUPPORTED" "$(cat "$TEST_DIR/stderr")"

if [[ $FAILURES -gt 0 ]]; then
    exit 1
fi
echo "sidecar naming: ok"
