#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Tests for prepush-fast.sh: a seeded violation of each cheap class fails its step, and a clean branch
# passes. Each case runs in a temporary worktree of HEAD that shares this checkout's node_modules.
# It is a shell test, not a *.node-test.mjs, so the Node script tests never run it from inside
# prepush-fast.sh itself.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/prepush-fast-test.XXXXXX")
WT="$TMP/wt"
trap 'git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

git -C "$REPO" worktree add --quiet --detach "$WT" HEAD
ln -s "$REPO/node_modules" "$WT/node_modules"
cp "$REPO/scripts/prepush-fast.sh" "$WT/scripts/prepush-fast.sh" # the version under test, committed or not
BASE=$(git -C "$WT" rev-parse HEAD)
# Identity per command: a linked worktree shares the checkout's git config.
g() { git -C "$WT" -c user.name="prepush test" -c user.email=prepush-test@example.invalid -c commit.gpgsign=false "$@"; }

fail=0
reset() {
  g reset --quiet --hard "$BASE"
  g clean --quiet -fd -e node_modules -e scripts/prepush-fast.sh
  cp "$REPO/scripts/prepush-fast.sh" "$WT/scripts/prepush-fast.sh"
}
seed() { # seed <path> <content> [<path> <content> ...]: commit the files on top of the base
  while [ $# -gt 0 ]; do
    mkdir -p "$(dirname "$WT/$1")"
    printf '%s' "$2" >"$WT/$1"
    g add -- "$1"
    shift 2
  done
  g commit --quiet -m "seed"
}
# expect <pass|fail> <name> <prepush-fast args...>: a failure must name the failing step
expect() {
  local want=$1 name=$2 out rc=0
  shift 2
  out=$(bash "$WT/scripts/prepush-fast.sh" --base "$BASE" "$@" 2>&1) || rc=$?
  if [ "$want" = pass ] && [ "$rc" = 0 ]; then
    echo "ok   $name"
  elif [ "$want" != pass ] && [ "$rc" = 1 ] && grep -Eq "^$want +FAIL" <<<"$out" &&
    grep -q "^--- $want failed" <<<"$out"; then
    echo "ok   $name"
  else
    echo "FAIL $name (want $want, exit $rc)"
    printf '%s\n' "$out" | tail -n 40
    fail=1
  fi
}

CHEAP=prettier,eslint,changelog,gitleaks,colours

reset
expect pass "a clean branch passes the cheap steps" --only "$CHEAP"

reset
seed src/prepush-seed.ts 'export const seeded   =  1
'
expect prettier "unformatted file fails prettier" --only prettier

reset
seed src/prepush-seed.ts 'export function seeded() {
  debugger;
}
'
expect eslint "a lint error fails eslint" --only eslint

reset
seed src/prepush-seed.ts 'export const seeded = 1;
'
expect changelog "an app change without a fragment fails changelog" --only changelog
expect pass "the no-changelog label passes it" --only changelog --no-changelog

reset
# Built at run time so no token-shaped string is ever committed.
token="ghp_$(od -An -tx1 -N18 /dev/urandom | tr -d ' \n')"
seed docs-prepush-seed.txt "token = $token
"
expect gitleaks "a secret in the pushed commits fails gitleaks" --only gitleaks

reset
seed src/prepush-seed.tsx 'export const seeded = { color: "#123456" };
'
expect colours "a new hard-coded colour fails the colour lint" --only colours

if grep -q cargo "$REPO/scripts/prepush-fast.sh"; then
  echo "FAIL prepush-fast.sh mentions cargo"
  fail=1
else
  echo "ok   prepush-fast.sh runs no Rust builds"
fi

rc=0
bash "$REPO/scripts/prepush-fast.sh" --only no-such-step >/dev/null 2>&1 || rc=$?
if [ "$rc" = 2 ]; then echo "ok   an unknown step is a usage error"; else
  echo "FAIL an unknown step exits $rc, not 2"
  fail=1
fi

exit "$fail"
