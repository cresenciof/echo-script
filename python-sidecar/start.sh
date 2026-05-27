#!/usr/bin/env bash
# Launch the whisper sidecar. Honors $PORT (defaults to 0 = pick free port).
# Tauri reads `SIDECAR_READY <port>\n` from this process's stdout.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-0}"

# Prefer the project venv created by `uv sync`; fall back to `uv run`.
if [[ -x ".venv/bin/python" ]]; then
  exec ".venv/bin/python" -m whisper_sidecar --port "$PORT"
else
  exec uv run python -m whisper_sidecar --port "$PORT"
fi
