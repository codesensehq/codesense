#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# The cheap CI checks, run locally before a push: prettier and eslint on the touched files, the
# changelog fragment, gitleaks on the commits being pushed, generated-docs freshness (which includes
# the MCP reference), the colour-count lint and its sibling Node lints from `pnpm lint`, and the Node
# script tests. Each step reuses the repo's own command. No Rust builds; under two minutes warm.
#
#   scripts/prepush-fast.sh [--base <ref>] [--no-changelog] [--only <step>[,<step>...]]
#
# --base          compare against this ref (default: the merge base of HEAD and origin/main)
# --no-changelog  the pull request carries the no-changelog label
# --only          run only these steps (repeatable): prettier eslint changelog gitleaks gen-docs
#                 colours node-lints node-tests
#
# Steps run in parallel, except that the Node script tests start once the steps that read the
# working tree are done (one of those tests rewrites a generated docs file while it runs).
# Exit 0 when every step passes, 1 when one fails (its output is printed), 2 on a usage error.
set -uo pipefail

STEPS="prettier eslint changelog gitleaks gen-docs colours node-lints node-tests"
TREE_STEPS="prettier eslint gen-docs colours node-lints"

usage() {
  sed -n '8,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

base_ref="" no_changelog=0 only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || usage
      base_ref=$2
      shift 2
      ;;
    --no-changelog)
      no_changelog=1
      shift
      ;;
    --only)
      [ $# -ge 2 ] || usage
      only="$only ${2//,/ }"
      shift 2
      ;;
    -h | --help) usage ;;
    *)
      echo "prepush-fast: unknown argument $1" >&2
      usage
      ;;
  esac
done
for step in $only; do
  case " $STEPS " in
    *" $step "*) ;;
    *)
      echo "prepush-fast: unknown step $step (steps: $STEPS)" >&2
      exit 2
      ;;
  esac
done
[ -n "$only" ] || only=$STEPS
selected() { case " $only " in *" $1 "*) return 0 ;; *) return 1 ;; esac }

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 2

want=$(tr -dc '0-9' <.nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
if [ "$have" != "$want" ]; then
  echo "prepush-fast: node ${have:-missing}, but .nvmrc wants $want (run nvm use)" >&2
  exit 2
fi

if [ -n "$base_ref" ]; then
  base=$(git rev-parse --verify --quiet "$base_ref^{commit}") || {
    echo "prepush-fast: --base $base_ref is not a commit" >&2
    exit 2
  }
  base_note="--base $base_ref"
else
  base=$(git merge-base HEAD origin/main) || {
    echo "prepush-fast: no merge base with origin/main; pass --base" >&2
    exit 2
  }
  base_note="merge base with origin/main"
fi
head=$(git rev-parse HEAD)

# Touched files: the base against the working tree, so prettier and eslint check what is on disk.
FILES=()
while IFS= read -r -d '' f; do FILES+=("$f"); done < <(git diff -z --name-only --diff-filter=d "$base")
LINTABLE=()
for f in ${FILES[@]+"${FILES[@]}"}; do
  case "$f" in *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx | *.mts | *.cts) LINTABLE+=("$f") ;; esac
done

step_prettier() {
  [ ${#FILES[@]} -gt 0 ] || { echo "no touched files"; return 0; }
  pnpm exec prettier --check --ignore-unknown -- "${FILES[@]}"
}
step_eslint() {
  [ ${#LINTABLE[@]} -gt 0 ] || { echo "no touched script files"; return 0; }
  pnpm exec eslint --no-warn-ignored -- "${LINTABLE[@]}"
}
step_changelog() {
  local labels='[]'
  [ "$no_changelog" = 1 ] && labels='["no-changelog"]'
  CHANGELOG_EVENT=pull_request CHANGELOG_BASE=$base CHANGELOG_HEAD=$head CHANGELOG_AUTHOR="" \
    CHANGELOG_LABELS=$labels node scripts/changelog-lint.mjs
}
step_gitleaks() {
  command -v gitleaks >/dev/null || { echo "gitleaks is not installed"; return 1; }
  [ "$base" != "$head" ] || { echo "no commits to scan"; return 0; }
  gitleaks git --no-banner --redact -c release/public-export-gitleaks.toml \
    --log-opts="$base..$head" .
}
step_gen-docs() { pnpm -s gen:docs:check:pr; }
step_colours() { node scripts/check-hardcoded-colors.mjs; }
step_node-lints() {
  node scripts/check-terminal-arch.mjs &&
    node scripts/check-agent-cli-boundary.mjs &&
    node scripts/check-agent-cli-boundary-ts.mjs &&
    node scripts/check-context-walk.mjs
}
step_node-tests() { pnpm -s test:node-scripts; }

LOG=$(mktemp -d "${TMPDIR:-/tmp}/prepush-fast.XXXXXX")
PIDS=""
trap 'kill $PIDS 2>/dev/null; rm -rf "$LOG"' EXIT
trap 'exit 130' INT TERM

launch() {
  (
    start=$(date +%s)
    "step_$1" >"$LOG/$1.log" 2>&1
    rc=$?
    echo "$rc $(($(date +%s) - start))" >"$LOG/$1.rc"
  ) &
  PIDS="$PIDS $!"
  eval "pid_${1//-/_}=$!"
}

started=$(date +%s)
dirty=""
git diff --quiet HEAD || dirty=" (uncommitted changes: prettier and eslint read them, the push will not carry them)"
echo "prepush-fast: base ${base:0:12} ($base_note), ${#FILES[@]} touched file(s)$dirty"
for step in $STEPS; do
  [ "$step" = node-tests ] || ! selected "$step" || launch "$step"
done
if selected node-tests; then
  for step in $TREE_STEPS; do
    selected "$step" || continue
    eval "wait \$pid_${step//-/_}"
  done
  launch node-tests
fi
wait

failed=""
printf '\n%-11s %-6s %s\n' step result time
for step in $STEPS; do
  selected "$step" || continue
  read -r rc secs <"$LOG/$step.rc" || { rc=1 secs="?"; }
  result=pass
  [ "$rc" = 0 ] || { result=FAIL; failed="$failed $step"; }
  printf '%-11s %-6s %ss\n' "$step" "$result" "$secs"
done
echo "total ${#FILES[@]} file(s), $(($(date +%s) - started))s wall"
for step in $failed; do
  printf '\n--- %s failed (last 80 lines) ---\n' "$step"
  tail -n 80 "$LOG/$step.log"
done
if [ -n "$failed" ]; then
  echo "prepush-fast: failed:$failed" >&2
  exit 1
fi
echo "prepush-fast: all green"
