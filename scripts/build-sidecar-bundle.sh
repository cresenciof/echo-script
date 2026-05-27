#!/usr/bin/env bash
# Build a fully-portable Python bundle for the whisper sidecar that can ship
# inside a macOS .app and run on any user's Mac without their own Python.
#
# Approach: copy a full python-build-standalone (PBS) install into the bundle
# (NOT just a venv). PBS is engineered to be relocatable end-to-end —
# interpreter, stdlib, and libpython.dylib all live under one tree with
# @executable_path / relative refs. Then install the sidecar's deps into the
# bundled Python's own site-packages.
#
# Why not `uv venv --relocatable`: that only rewrites activation scripts and
# shebangs. The venv's Python references the stdlib via an absolute path to
# uv's managed install dir (~/.local/share/uv/python/...) which does not exist
# on a user's machine — Python fails to import `encodings` and aborts.
#
# Output: python-sidecar/.venv-bundle/  (drop-in replacement; same path as before)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/python-sidecar"
BUNDLE_DIR="$SIDECAR_DIR/.venv-bundle"

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

# Strip any shell-level VIRTUAL_ENV so uv ignores the user's activated venv
# (which would otherwise hijack `uv python find`).
unset VIRTUAL_ENV
export UV_PYTHON_PREFERENCE=only-managed

# 1. Ensure a uv-managed (python-build-standalone) CPython is installed.
echo "[bundle] ensuring uv-managed cpython-3.12 is installed"
"$UV_BIN" python install 3.12

# 2. Locate the install directory. `uv python find` returns the binary; we want
#    the install root (which contains bin/, lib/, share/).
PY_BIN_PATH="$("$UV_BIN" python find 3.12)"
PBS_ROOT="$(cd "$(dirname "$PY_BIN_PATH")/.." && pwd)"
if [[ ! -f "$PBS_ROOT/lib/libpython3.12.dylib" && ! -f "$PBS_ROOT/lib/python3.12/encodings/__init__.py" ]]; then
  echo "[bundle] ERROR: $PBS_ROOT does not look like a python-build-standalone install" >&2
  ls -la "$PBS_ROOT" 2>&1 | head -10 >&2
  exit 1
fi
echo "[bundle] python-build-standalone install: $PBS_ROOT"

# 3. Wipe the previous bundle and copy the FULL PBS install in.
if [[ -d "$BUNDLE_DIR" ]]; then
  echo "[bundle] removing previous $BUNDLE_DIR"
  rm -rf "$BUNDLE_DIR"
fi
echo "[bundle] copying PBS install into $BUNDLE_DIR"
# -R recursive, -P preserve symlinks (PBS uses symlinks for python -> python3.12).
# Trailing /. copies contents into BUNDLE_DIR rather than into a subdir.
mkdir -p "$BUNDLE_DIR"
cp -RP "$PBS_ROOT/." "$BUNDLE_DIR/"

# Sanity: the bundled Python must be able to import `encodings` BEFORE we
# install any deps — that's what proved the previous setup was broken.
echo "[bundle] sanity 1/3: bundled python imports stdlib"
if ! "$BUNDLE_DIR/bin/python3.12" -c "import encodings, os, sys; print('stdlib OK from', sys.prefix)" ; then
  echo "[bundle] ERROR: bundled Python could not import its own stdlib." >&2
  exit 1
fi

# Remove uv's PEP 668 "externally managed" marker. uv tags its own Python
# installs as protected from package installation; that's the right default for
# the user's machine, but the bundle is OUR install — we want to populate
# site-packages with the sidecar's deps.
EXT_MANAGED="$BUNDLE_DIR/lib/python3.12/EXTERNALLY-MANAGED"
if [[ -f "$EXT_MANAGED" ]]; then
  echo "[bundle] removing PEP 668 marker from bundled Python"
  rm -f "$EXT_MANAGED"
fi

# 4. Install the sidecar project (+ its declared deps) into the bundled Python.
echo "[bundle] installing whisper-sidecar + deps into bundle"
"$UV_BIN" pip install \
  --python "$BUNDLE_DIR/bin/python3.12" \
  --no-cache \
  "$SIDECAR_DIR"

# 4.5 Bundle static ffmpeg + ffprobe binaries (mlx_whisper shells out to
#     them for audio decoding). evermeet.cx publishes LGPL-2.1 macOS arm64
#     static builds with no dylib deps outside the system frameworks.
FFMPEG_VERSION="${FFMPEG_VERSION:-8.1.1}"
echo "[bundle] downloading ffmpeg + ffprobe ${FFMPEG_VERSION} (evermeet.cx, static, LGPL-2.1)"
for tool in ffmpeg ffprobe; do
  url="https://evermeet.cx/ffmpeg/${tool}-${FFMPEG_VERSION}.zip"
  tmp_zip="$(mktemp -t "${tool}-XXXXXX").zip"
  if ! curl -fsSL "$url" -o "$tmp_zip"; then
    echo "[bundle] ERROR: failed to download $url" >&2
    exit 1
  fi
  unzip -q -o "$tmp_zip" -d "$BUNDLE_DIR/bin/"
  chmod +x "$BUNDLE_DIR/bin/$tool"
  rm -f "$tmp_zip"
done
echo "[bundle] verifying bundled ffmpeg runs"
"$BUNDLE_DIR/bin/ffmpeg" -version 2>&1 | head -1
"$BUNDLE_DIR/bin/ffprobe" -version 2>&1 | head -1

# 5. Cross-machine portability check: the interpreter must NOT reference
#    build-machine paths. PBS uses @executable_path / @rpath; if we see
#    /opt/homebrew/, /Users/, /usr/local/, or /Library/Frameworks/ the bundle
#    will break on a fresh Mac.
if [[ "$(uname -s)" == "Darwin" ]]; then
  PY_BIN="$BUNDLE_DIR/bin/python3.12"
  echo "[bundle] sanity 2/3: $PY_BIN dylib refs are portable"
  if otool -L "$PY_BIN" 2>/dev/null | tail -n +2 \
      | grep -E "^\s+/(opt|Users|usr/local|Library/Frameworks)/" >/dev/null; then
    echo "[bundle] ERROR: python has non-portable dylib refs:" >&2
    otool -L "$PY_BIN" | tail -n +2 | grep -E "^\s+/(opt|Users|usr/local|Library/Frameworks)/" >&2
    exit 1
  fi
fi

# 6. Functional sanity-test: copy the bundle to /tmp (simulating an
#    "installed on a different machine" path), launch the sidecar, parse the
#    SIDECAR_READY handshake. If this fails the DMG would ship broken.
TEST_DIR="$(mktemp -d -t whisper-sidecar-reloc-XXXXXX)"
trap 'rm -rf "$TEST_DIR"' EXIT
TEST_BUNDLE="$TEST_DIR/bundle"
echo "[bundle] sanity 3/3: relocated launch from $TEST_BUNDLE"
cp -RP "$BUNDLE_DIR" "$TEST_BUNDLE"

STDOUT_LOG="$TEST_DIR/stdout.log"
STDERR_LOG="$TEST_DIR/stderr.log"
(
  cd "$SIDECAR_DIR"
  "$TEST_BUNDLE/bin/python3.12" -m whisper_sidecar --port 0 \
    >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  echo $! >"$TEST_DIR/pid"
)
SIDECAR_PID="$(cat "$TEST_DIR/pid")"

READY_LINE=""
for _ in $(seq 1 150); do
  if [[ -s "$STDOUT_LOG" ]] && grep -q "^SIDECAR_READY " "$STDOUT_LOG"; then
    READY_LINE="$(grep "^SIDECAR_READY " "$STDOUT_LOG" | head -n1)"
    break
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
kill "$SIDECAR_PID" 2>/dev/null || true
wait "$SIDECAR_PID" 2>/dev/null || true

if [[ -z "$READY_LINE" ]]; then
  echo "[bundle] ERROR: relocated bundle did not emit SIDECAR_READY." >&2
  echo "--- stdout ---" >&2; cat "$STDOUT_LOG" >&2 || true
  echo "--- stderr ---" >&2; cat "$STDERR_LOG" >&2 || true
  exit 1
fi
echo "[bundle] sanity 3/3 OK: $READY_LINE"

BUNDLE_SIZE="$(du -sh "$BUNDLE_DIR" | awk '{print $1}')"
echo "[bundle] done."
echo "[bundle]   path: $BUNDLE_DIR"
echo "[bundle]   size: $BUNDLE_SIZE"
