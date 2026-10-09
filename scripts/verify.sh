#!/usr/bin/env bash
# The local gate: the same three checks CI runs (actionlint, shellcheck, node --test).
# Install both linters with your package manager (Homebrew: actionlint, shellcheck).
# CI runs actionlint via `go run` at a pinned version.
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in actionlint shellcheck node; do
  command -v "$tool" >/dev/null || { echo "verify: $tool not found on PATH" >&2; exit 1; }
done

echo "== actionlint"
actionlint .github/workflows/*.yml examples/*.yml
echo "== shellcheck"
shellcheck scripts/*.sh
echo "== node --test"
node --test test/*.test.mjs
