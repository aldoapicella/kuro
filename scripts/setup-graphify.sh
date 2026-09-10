#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if command -v uv >/dev/null 2>&1; then
  graphify_uv="$(command -v uv)"
elif [ -x "$HOME/.local/bin/uv" ]; then
  graphify_uv="$HOME/.local/bin/uv"
else
  printf '%s\n' 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi

"$graphify_uv" tool install --python 3.12 'graphifyy[mcp,pdf,watch,svg,office]==0.9.57'
"$graphify_uv" tool update-shell
graphify_bin_dir="$("$graphify_uv" tool dir --bin)"
"$graphify_bin_dir/graphify" install --platform codex --project

printf '%s\n' 'Graphify is installed. Open a new shell if PATH changed.'
printf '%s\n' 'Build the local code graph: graphify extract . --code-only'
