# SPDX-License-Identifier: MIT
# shellcheck shell=sh
# The check commit-msg and pre-push share on the node path. Sourced, it only
# defines a function: install.sh copies none of it into a dispatcher.
# - stale_dispatcher <hook>: warns when the dispatcher installed for <hook>
#   predates the signed-commit check (no version marker), so a reinstall is due.
#   The hook still runs its checks.
stale_dispatcher() {
  if hooks=$(git rev-parse --path-format=absolute --git-path hooks 2>/dev/null) &&
    grep -q codesense-privacy-hook-dispatcher "$hooks/$1" 2>/dev/null &&
    ! grep -q "codesense-privacy-hook-version: 2" "$hooks/$1" 2>/dev/null; then
    echo "privacy hook: the installed dispatcher is out of date; rerun scripts/git-hooks/install.sh" >&2
  fi
}
