#!/bin/bash
# SPDX-License-Identifier: MIT
# Run the app's credential store tests against a real Secret Service. Start it inside a D-Bus session:
#   dbus-run-session -- bash scripts/run-secret-service-tests.sh
# GNOME Keyring is unlocked with a throwaway password, as keyring's own CI does, and a secret-tool
# round trip checks that the unlock worked, so a failed unlock fails here by name.
# Two nextest runs, each of which must match a test (nextest fails when none does): the ignored
# Secret Service tests, minus the child processes they start (those pass alone), and the store's
# Linux-only tests that are not ignored (the backend selection, the D-Bus error table). No
# retries: a flaky keyring should fail the run.
set -euo pipefail
echo "ci-keyring" | gnome-keyring-daemon --unlock > /dev/null
echo -n kept | secret-tool store --label=ci-preflight purpose ci-preflight
test "$(secret-tool lookup purpose ci-preflight)" = kept
nextest=(cargo nextest run --profile ci --locked -p codesense --lib --retries 0)
"${nextest[@]}" --run-ignored only \
  -E 'test(~credential_store::secret_service_tests::) - test(~::reader_process) - test(~::no_bus_child)'
"${nextest[@]}" -E 'test(~credential_store::tests::linux_)'
