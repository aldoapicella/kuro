#!/bin/sh
set -eu

HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
RUNNER_ROOT=$(dirname -- "$HOOK_DIR")
exec "$RUNNER_ROOT/externals/node24/bin/node" "$HOOK_DIR/guard.mjs"
