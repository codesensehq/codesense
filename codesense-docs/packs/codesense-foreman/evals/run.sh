#!/bin/sh
# SPDX-License-Identifier: MIT
# evals/run.sh <variant> [--k N] [--model M] [--driver stub:good|stub:do-nothing] [--budget USD] [--out DIR]
exec node "$(dirname "$0")/lib/runner.mjs" "$@"
