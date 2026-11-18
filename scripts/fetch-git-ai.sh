#!/bin/bash
# SPDX-License-Identifier: MIT
# Kept for the macOS jobs that call it by this name; scripts/fetch-bundled.sh does the work.
exec bash "$(dirname "$0")/fetch-bundled.sh" "$@"
