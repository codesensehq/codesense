#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Tests for prepush-fast.sh: a seeded violation of each cheap class fails its step with its cause, a
# clean branch passes with every step checking it, and the option, base, pin and signal handling
# hold. Each case runs in a temporary worktree of HEAD that shares this checkout's node_modules.
# It is a shell test, not a *.node-test.mjs, so the Node script tests never run it from inside
# prepush-fast.sh itself.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/prepush-fast-test.XXXXXX")
WT="$TMP/wt"
trap 'git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

git -C "$REPO" worktree add --quiet --detach "$WT" HEAD
ln -s "$REPO/node_modules" "$WT/node_modules"
# Identity per command: a linked worktree shares the checkout's git config.
g() { git -C "$WT" -c user.name="prepush test" -c user.email=prepush-test@example.invalid -c commit.gpgsign=false "$@"; }
# The base carries the version under test, committed or not, so it is never a touched file.
cp "$REPO/scripts/prepush-fast.sh" "$WT/scripts/prepush-fast.sh"
g add scripts/prepush-fast.sh
g diff --cached --quiet || g commit --quiet -m "the version under test"
BASE=$(git -C "$WT" rev-parse HEAD)

fail=0
reset() {
  g reset --quiet --hard "$BASE"
  g clean --quiet -fd -e node_modules
}
seed() { # seed <path> <content> [<path> <content> ...]: commit the files on top of the current HEAD
  while [ $# -gt 0 ]; do
    mkdir -p "$(dirname "$WT/$1")"
    printf '%s' "$2" >"$WT/$1"
    g add -- "$1"
    shift 2
  done
  g commit --quiet -m "seed"
}
ok() { echo "ok   $1"; }
bad() {
  echo "FAIL $1"
  [ -z "${2:-}" ] || printf '%s\n' "$2" | tail -n 40
  fail=1
}
# expect <pass|step> <name> <pattern> <prepush-fast args...>: run against the base; a pass exits 0,
# a failure exits 1 and names the step. Either way the output must match the extended regex
# <pattern>: for a failure, the step's own message about the seeded cause.
expect() {
  local want=$1 name=$2 pattern=$3 out rc=0
  shift 3
  out=$(bash "$WT/scripts/prepush-fast.sh" --base "$BASE" "$@" 2>&1) || rc=$?
  if [ "$want" = pass ]; then
    [ "$rc" = 0 ] || { bad "$name (exit $rc, want 0)" "$out"; return; }
  elif ! { [ "$rc" = 1 ] && grep -Eq "^$want +FAIL" <<<"$out" && grep -q "^--- $want failed" <<<"$out"; }; then
    bad "$name (exit $rc, want $want to fail)" "$out"
    return
  fi
  grep -Eq -- "$pattern" <<<"$out" || { bad "$name (no match for: $pattern)" "$out"; return; }
  ok "$name"
}

CHEAP=prettier,eslint,changelog,gitleaks,colours
CLEAN_TS='export const seeded = 1;
'
FRAGMENT='---
type: fixed
---

**Seeded.** A fragment for the clean case.
'

# Clean: a formatted script file and a fragment, so every step has something to check. The summary
# shows each step's last line, which proves it ran on the seeded commit rather than skipping.
reset
seed src/prepush-seed.ts "$CLEAN_TS" changes/prepush-seed.md "$FRAGMENT"
out=$(bash "$WT/scripts/prepush-fast.sh" --base "$BASE" --only "$CHEAP" 2>&1) && rc=0 || rc=$?
for check in "2 touched file\(s\)" "^prettier +pass .*Prettier code style" \
  "^eslint +pass .*1 script file\(s\) clean" "^changelog +pass .*fragment\(s\) OK" \
  "^gitleaks +pass .*no leaks found" "^colours +pass .*ratchet passed"; do
  if [ "$rc" = 0 ] && grep -Eq -- "$check" <<<"$out"; then ok "a clean branch: $check"; else
    bad "a clean branch: $check (exit $rc)" "$out"
  fi
done

reset
seed src/prepush-seed.ts 'export const seeded   =  1
'
expect prettier "unformatted file fails prettier" "\[warn\] src/prepush-seed\.ts" --only prettier

reset
seed src/prepush-seed.ts 'export function seeded() {
  debugger;
}
'
expect eslint "a lint error fails eslint" "no-debugger" --only eslint

reset
seed src/prepush-seed.ts "$CLEAN_TS"
expect changelog "an app change without a fragment fails changelog" "adds no changelog entry" --only changelog
expect pass "the no-changelog label passes it" "^changelog +pass" --only changelog --no-changelog

reset
# Built at run time so no token-shaped string is ever committed.
token="ghp_$(od -An -tx1 -N18 /dev/urandom | tr -d ' \n')"
seed docs-prepush-seed.txt "token = $token
"
expect gitleaks "a secret in the pushed commits fails gitleaks" "leaks found: 1" --only gitleaks

reset
seed src/prepush-seed.tsx 'export const seeded = { color: "#123456" };
'
expect colours "a new hard-coded colour fails the colour lint" "src/prepush-seed\.tsx: #123456" --only colours

# --base is a branch point, not a diff base: a ref ahead on another line compares from the merge base,
# so a file changed only on that line is not a touched file.
reset
seed README.md "$(cat "$WT/README.md")
side line
"
SIDE=$(git -C "$WT" rev-parse HEAD)
reset
seed src/prepush-seed.ts "$CLEAN_TS"
out=$(bash "$WT/scripts/prepush-fast.sh" --base "$SIDE" --only prettier 2>&1) || true
if grep -q "base ${BASE:0:12} (merge base with $SIDE), 1 touched file(s)" <<<"$out"; then
  ok "--base uses the merge base with HEAD"
else bad "--base uses the merge base with HEAD" "$out"; fi

# A gitleaks other than the pinned one fails the step and names the pin.
reset
seed src/prepush-seed.ts "$CLEAN_TS"
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho 0.0.1\n' >"$TMP/bin/gitleaks"
chmod +x "$TMP/bin/gitleaks"
pin=$(awk '$1 == "gitleaks" { print $2; exit }' "$REPO/release/scanners.lock")
PATH="$TMP/bin:$PATH" expect gitleaks "a gitleaks other than the pinned one fails" \
  "gitleaks 0\.0\.1 does not match ${pin//./\\.} pinned .*install-scanners\.sh <a directory on PATH> --tool gitleaks" \
  --only gitleaks
rm "$TMP/bin/gitleaks"

# TERM stops what a step started, not just its subshell: a pnpm that sleeps must be gone afterwards.
reset
printf '#!/bin/sh\necho $$ >"%s"\nexec sleep 60\n' "$TMP/pnpm.pid" >"$TMP/bin/pnpm"
chmod +x "$TMP/bin/pnpm"
PATH="$TMP/bin:$PATH" bash "$WT/scripts/prepush-fast.sh" --base "$BASE" --only gen-docs >/dev/null 2>&1 &
script=$!
for _ in $(seq 100); do [ -s "$TMP/pnpm.pid" ] && break; sleep 0.1; done
rc=0
kill -TERM "$script" 2>/dev/null || true
wait "$script" || rc=$?
sleeper=$(cat "$TMP/pnpm.pid" 2>/dev/null || echo "")
sleep 0.5
if [ -z "$sleeper" ]; then
  bad "TERM stops a step's children (the fake pnpm never started)"
elif kill -0 "$sleeper" 2>/dev/null; then
  kill "$sleeper"
  bad "TERM stops a step's children (pnpm $sleeper still running)"
elif [ "$rc" != 143 ]; then
  bad "TERM stops a step's children (exit $rc, want 143)"
else ok "TERM stops a step's children"; fi

# Under a terminal: the steps run in their own process groups, so one that reads stdin from the terminal would be
# stopped (SIGTTIN) and the run would hang. The fake pnpm reads stdin, then sleeps when asked. Each run is in a pty
# (script), with a guard that kills it after a timeout.
cat >"$TMP/bin/pnpm" <<EOF
#!/bin/sh
echo \$\$ >"$TMP/pnpm.pid"
read -r _ || true
[ -z "\${FAKE_PNPM_SLEEP:-}" ] || exec sleep "\$FAKE_PNPM_SLEEP"
EOF
chmod +x "$TMP/bin/pnpm"
# in_pty <prepush-fast args...>: start it in a pty in the background; sets PTY (the script process). The script's own
# PID is written to $TMP/pty.pid (exec keeps it). Job control is on for the launch: without it a background job
# starts with INT ignored, and a script cannot trap a signal ignored on entry.
in_pty() {
  local cmd
  rm -f "$TMP/pty.pid" "$TMP/pnpm.pid"
  # shellcheck disable=SC2016 # $$, $0 and $@ belong to the inner bash
  cmd=$(printf '%q ' env PATH="$TMP/bin:$PATH" bash -c 'echo $$ >"$0"; exec bash "$@"' "$TMP/pty.pid" \
    "$WT/scripts/prepush-fast.sh" --base "$BASE" "$@")
  set -m
  if script --version 2>/dev/null | grep -q util-linux; then
    script -qec "$cmd" /dev/null </dev/null >"$TMP/pty.out" 2>&1 &
  else
    script -q /dev/null bash -c "$cmd" </dev/null >"$TMP/pty.out" 2>&1 &
  fi
  PTY=$!
  set +m
}
# finish <seconds>: wait for the pty run; sets PTY_RC, or "timeout" after killing what is left.
finish() {
  for _ in $(seq $(($1 * 10))); do kill -0 "$PTY" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$PTY" 2>/dev/null; then
    PTY_RC=timeout
    for f in pty.pid pnpm.pid; do [ ! -s "$TMP/$f" ] || kill -KILL "$(cat "$TMP/$f")" 2>/dev/null || true; done
    kill -KILL "$PTY" 2>/dev/null || true
    wait "$PTY" 2>/dev/null || true
  else
    PTY_RC=0
    wait "$PTY" || PTY_RC=$?
  fi
}
in_pty --only gen-docs
finish 20
if [ "$PTY_RC" = 0 ]; then ok "under a terminal, a step that reads stdin does not hang"; else
  bad "under a terminal, a step that reads stdin does not hang (exit $PTY_RC)" "$(cat "$TMP/pty.out")"
fi

# INT under a terminal: exit 130, and what the step started is gone.
export FAKE_PNPM_SLEEP=60
in_pty --only gen-docs
for _ in $(seq 100); do [ -s "$TMP/pnpm.pid" ] && [ -s "$TMP/pty.pid" ] && break; sleep 0.1; done
sleeper=$(cat "$TMP/pnpm.pid" 2>/dev/null || echo "")
[ ! -s "$TMP/pty.pid" ] || kill -INT "$(cat "$TMP/pty.pid")" 2>/dev/null || true
finish 20
unset FAKE_PNPM_SLEEP
sleep 0.5
if [ -z "$sleeper" ]; then
  bad "INT stops a step's children (the fake pnpm never started)" "$(cat "$TMP/pty.out")"
elif kill -0 "$sleeper" 2>/dev/null; then
  kill -KILL "$sleeper"
  bad "INT stops a step's children (pnpm $sleeper still running, exit $PTY_RC)"
elif [ "$PTY_RC" != 130 ]; then
  bad "INT stops a step's children (exit $PTY_RC, want 130)" "$(cat "$TMP/pty.out")"
else ok "INT stops a step's children"; fi

if grep -q cargo "$REPO/scripts/prepush-fast.sh"; then
  bad "prepush-fast.sh mentions cargo"
else
  ok "prepush-fast.sh runs no Rust builds"
fi

# usage <name> <want exit> <want stream: out|err> <args...>
usage() {
  local name=$1 want=$2 stream=$3 out err rc=0
  shift 3
  out=$(bash "$REPO/scripts/prepush-fast.sh" "$@" 2>"$TMP/err") || rc=$?
  err=$(cat "$TMP/err")
  [ "$stream" = out ] || out=$err
  if [ "$rc" = "$want" ] && grep -q "^usage: " <<<"$out"; then ok "$name"; else
    bad "$name (exit $rc, want $want with usage on std$stream)" "$out"
  fi
}
usage "--help prints usage and exits 0" 0 out --help
usage "--only with no step is a usage error" 2 err --only ""
usage "--only with only commas is a usage error" 2 err --only ,
rc=0
bash "$REPO/scripts/prepush-fast.sh" --only no-such-step >/dev/null 2>&1 || rc=$?
if [ "$rc" = 2 ]; then ok "an unknown step is a usage error"; else
  bad "an unknown step exits $rc, not 2"
fi

exit "$fail"
