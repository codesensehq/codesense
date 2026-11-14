#!/bin/sh
# SPDX-License-Identifier: MIT
# evals/run.sh <variant> --driver stub:good|stub:do-nothing [--suite floor|extra] [--k N] [--model M] [--budget USD (at most 12)] [--out DIR]
exec node "$(dirname "$0")/lib/runner.mjs" "$@"
