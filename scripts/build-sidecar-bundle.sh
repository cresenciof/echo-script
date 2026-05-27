#!/usr/bin/env bash
# Build a relocatable Python venv for the whisper sidecar that can be shipped
# inside the Tauri .app bundle.
#
# Output: python-sidecar/.venv-bundle/  (separate from dev .venv)
#
# This script is invoked by Tauri's beforeBuildCommand so the bundle is always
# fresh when `pnpm tauri build` runs. It can also be run standalone.
set -euo pipefail

# Resolve repo root regardless of cwd so this works as a hook or manually.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/python-sidecar"
BUNDLE_DIR="$SIDECAR_DIR/.venv-bundle"

# Prefer the canonical install location but fall back to $PATH for CI/dev.
UV_BIN="${UV_BIN:-$HOME/.local/bin/uv}"
if [[ ! -x "$UV_BIN" ]]; then
  if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
  else
    echo "[bundle] ERROR: uv binary not found. Install from https://docs.astral.sh/uv/" >&2
    exit 1
  fi
fi

echo "[bundle] using uv: $UV_BIN ($($UV_BIN --version))"
echo "[bundle] sidecar dir: $SIDECAR_DIR"
echo "[bundle] bundle dir:  $BUNDLE_DIR"

if [[ ! -f "$SIDECAR_DIR/pyproject.toml" ]]; then
  echo "[bundle] ERROR: $SIDECAR_DIR/pyproject.toml missing — wrong repo?" >&2
  exit 1
fi

# Clean previous bundle so we never carry stale wheels between builds.
if [[ -d "$BUNDLE_DIR" ]]; then
  echo "[bundle] removing previous $BUNDLE_DIR"
  rm -rf "$BUNDLE_DIR"
fi

# Build the relocatable venv. --relocatable rewrites the activation scripts and
# shebangs so the venv works after being moved (essential for shipping inside
# Contents/Resources of an .app bundle that the user can install anywhere).
echo "[bundle] creating relocatable venv"
"$UV_BIN" venv --relocatable --python ">=3.12" "$BUNDLE_DIR"

# Install runtime deps into the relocatable venv. We deliberately install the
# project NON-editable so the venv carries an installed copy of whisper_sidecar
# rather than referencing the source tree via an absolute path (which would
# defeat relocation).
echo "[bundle] installing dependencies into $BUNDLE_DIR"
"$UV_BIN" pip install \
  --python "$BUNDLE_DIR/bin/python" \
  --project "$SIDECAR_DIR" \
  "$SIDECAR_DIR"

# Sanity-check: pyvenv.cfg must not contain an absolute path to the build
# machine, otherwise --relocatable failed silently.
if grep -qE "^home = " "$BUNDLE_DIR/pyvenv.cfg" && ! grep -q "relocatable" "$BUNDLE_DIR/pyvenv.cfg"; then
  echo "[bundle] WARNING: pyvenv.cfg appears non-relocatable. Contents:" >&2
  cat "$BUNDLE_DIR/pyvenv.cfg" >&2
fi

# Functional sanity-test: relocate the venv to /tmp, start it, parse the
# SIDECAR_READY handshake, then kill it. If this fails the DMG would ship a
# broken sidecar.
TEST_DIR="$(mktemp -d -t whisper-sidecar-reloc-XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT
TEST_VENV="$TEST_DIR/venv"
echo "[bundle] sanity-test: copying venv to $TEST_VENV"
cp -R "$BUNDLE_DIR" "$TEST_VENV"

# Run the sidecar from the relocated venv, in the source dir so the module is
# importable. Capture stdout to a file so we can grep for SIDECAR_READY.
STDOUT_LOG="$TEST_DIR/stdout.log"
STDERR_LOG="$TEST_DIR/stderr.log"
echo "[bundle] sanity-test: launching sidecar from relocated venv"
(
  cd "$SIDECAR_DIR"
  "$TEST_VENV/bin/python" -m whisper_sidecar --port 0 \
    >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  echo $! >"$TEST_DIR/pid"
)
SIDECAR_PID="$(cat "$TEST_DIR/pid")"

# Poll for up to 15s for the handshake line.
READY_LINE=""
for _ in $(seq 1 150); do
  if [[ -s "$STDOUT_LOG" ]] && grep -q "^SIDECAR_READY " "$STDOUT_LOG"; then
    READY_LINE="$(grep "^SIDECAR_READY " "$STDOUT_LOG" | head -n1)"
    break
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

kill "$SIDECAR_PID" 2>/dev/null || true
wait "$SIDECAR_PID" 2>/dev/null || true

if [[ -z "$READY_LINE" ]]; then
  echo "[bundle] ERROR: relocated venv did not emit SIDECAR_READY. Logs:" >&2
  echo "--- stdout ---" >&2
  cat "$STDOUT_LOG" >&2 || true
  echo "--- stderr ---" >&2
  cat "$STDERR_LOG" >&2 || true
  exit 1
fi
echo "[bundle] sanity-test OK: $READY_LINE"

# Report final size and path.
BUNDLE_SIZE="$(du -sh "$BUNDLE_DIR" | awk '{print $1}')"
echo "[bundle] done."
echo "[bundle]   path: $BUNDLE_DIR"
echo "[bundle]   size: $BUNDLE_SIZE"
