# Transcription Tool

A native macOS desktop app for offline audio transcription on Apple Silicon, powered by [`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper). Drop an audio file, watch it transcribe in real time, edit, and export. Nothing leaves your Mac.

Built with Tauri 2 (Rust shell), React 19 + TypeScript + Vite + Tailwind v4 (frontend), and a Python FastAPI sidecar that runs `mlx-whisper` in a worker thread and streams progress over Server-Sent Events.

---

## Features

- **Native macOS app** — Tauri shell, WKWebView, ~15 MB bundle + Python venv
- **Apple Silicon only** — uses MLX (no fallback; this is by design)
- **Live transcription progress** — segments stream in as they're decoded
- **Multiple Whisper models** — `large-v3-turbo` (default), `large-v3`, `large-v3-mlx-4bit`, `medium`, `small`
- **Export to** TXT, SRT, VTT, Markdown
- **Editable transcript** — fix recognition errors before exporting
- **In-browser audio player** — click any segment to seek
- **Dark mode by design** — single accent (amber), Geist Sans + Geist Mono typography

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Tauri shell (Rust)                                        │
│  - spawns Python sidecar on startup                        │
│  - reads `SIDECAR_READY <port>` handshake from stdout      │
│  - injects window.__SIDECAR_URL__ into the WebView         │
│  - kills the child on window close                         │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│  React + Vite (WKWebView)                                  │
│  - Zustand for jobs & audio state                          │
│  - TanStack Query for /models, /health                     │
│  - EventSource (SSE) for /jobs/{id}/stream                 │
│  - Tauri save dialog for exports                           │
└─────────────────────────┬──────────────────────────────────┘
                          │ HTTP + SSE on 127.0.0.1:<random-port>
┌─────────────────────────▼──────────────────────────────────┐
│  Python sidecar (FastAPI + uvicorn)                        │
│  - POST /transcribe   → starts worker, returns job_id      │
│  - GET  /jobs/{id}/stream  → SSE: progress|segment|done    │
│  - GET  /jobs/{id}   → final result                        │
│  - GET  /models      → catalog + installed status          │
│  - GET  /health      → readiness                           │
│  - mlx-whisper runs in a thread; stdout is parsed for      │
│    `[mm:ss.SSS --> mm:ss.SSS] text` segment lines and      │
│    fanned out to SSE subscribers                           │
└────────────────────────────────────────────────────────────┘
```

The port handshake is `SIDECAR_READY <port>\n`, printed to stdout exactly once before any other output and flushed immediately. Tauri reads this line on a dedicated thread and routes it back to the main thread via a `sync_channel(1)` with a 10-second timeout.

---

## Prerequisites

This project assumes macOS on Apple Silicon. The toolchain is:

| Tool     | Minimum | Install                                                                          |
| -------- | ------- | -------------------------------------------------------------------------------- |
| Rust     | 1.78+   | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y`       |
| Node.js  | 20+     | `nvm install 22 && nvm use 22` (or via Homebrew: `brew install node`)            |
| pnpm     | 9+      | `corepack enable && corepack prepare pnpm@latest --activate`                     |
| uv       | latest  | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                               |
| Xcode CLT| current | `xcode-select --install`                                                         |
| ffmpeg   | optional| `brew install ffmpeg` (only needed if you want audio-duration progress %)        |

After installing Rust, make sure your shell sources `$HOME/.cargo/env`. Restart your terminal or run `source "$HOME/.cargo/env"` once.

---

## Quick start

```bash
# 1. Clone (or you're already here)
cd /Users/cresenciof/Development/personal/transcription-tool

# 2. Install frontend deps
pnpm install

# 3. Install sidecar deps (creates python-sidecar/.venv)
cd python-sidecar
uv sync
cd ..

# 4. First run will download the default Whisper model (~1.6 GB)
#    to ~/.cache/huggingface/hub. Subsequent runs are instant.
source "$HOME/.cargo/env"
pnpm tauri dev
```

The first launch of `pnpm tauri dev` may take ~5 minutes (Rust compiles the entire dependency tree). Subsequent launches are seconds.

---

## Project structure

```
transcription-tool/
├── src/                          # React + TS frontend
│   ├── App.tsx                   # Routing between empty / working / result states
│   ├── components/
│   │   ├── Dropzone.tsx          # react-dropzone wrapper, accepts audio
│   │   ├── ModelPicker.tsx       # model catalog with "installed" tags
│   │   ├── JobCard.tsx           # one job: status, progress, ETA
│   │   ├── JobList.tsx           # sidebar list of recent jobs
│   │   ├── TranscriptView.tsx    # segment list with timestamps
│   │   ├── TranscriptEditor.tsx  # edit mode for segments
│   │   ├── AudioPlayer.tsx       # HTML5 audio with seek-from-segment
│   │   ├── ExportBar.tsx         # TXT / SRT / VTT / MD exports
│   │   ├── EmptyState.tsx        # first-run / no-jobs UI
│   │   ├── Header.tsx, StatusBar.tsx, WorkspaceView.tsx
│   │   └── ui/                   # shadcn primitives (button, card, …)
│   ├── hooks/                    # useModels, useTranscription, useExporter, useHealth, useKeymap
│   ├── lib/                      # api.ts (HTTP client), sse.ts (EventSource wrapper), sidecar.ts (URL resolver), timeFormat.ts
│   ├── state/                    # useJobsStore, useAudioStore (Zustand)
│   ├── styles.css                # Tailwind v4 + oklch design tokens
│   └── types/                    # domain.ts, global.d.ts
├── src-tauri/                    # Tauri Rust shell
│   ├── src/lib.rs                # Sidecar spawn, port handshake, webview injection, cleanup
│   ├── tauri.conf.json           # window config, CSP allowing http://127.0.0.1:*
│   └── Cargo.toml
├── python-sidecar/               # FastAPI + mlx-whisper
│   ├── src/whisper_sidecar/
│   │   ├── __main__.py           # CLI entrypoint, port pre-bind, SIDECAR_READY handshake
│   │   ├── app.py                # FastAPI app, CORS, routes, SSE
│   │   ├── transcriber.py        # Worker thread, stdout segment parser
│   │   ├── jobs.py               # JobRegistry with pub/sub fan-out
│   │   ├── hf_cache.py           # Scans ~/.cache/huggingface/hub for installed models
│   │   ├── audio.py              # ffprobe + fallback for duration
│   │   ├── config.py             # Model catalog
│   │   └── models.py             # Pydantic schemas
│   ├── tests/                    # 10 tests covering parser + registry
│   ├── pyproject.toml
│   └── start.sh
└── README.md (this file)
```

---

## Development workflow

### Run the whole app

```bash
source "$HOME/.cargo/env"
pnpm tauri dev
```

### Run sidecar standalone (for debugging)

```bash
cd python-sidecar
uv run python -m whisper_sidecar --port 0
# Watch stdout for: SIDECAR_READY <port>
```

Then hit it manually:

```bash
PORT=56434  # whatever it printed
curl http://127.0.0.1:$PORT/health
curl http://127.0.0.1:$PORT/models
curl -X POST http://127.0.0.1:$PORT/transcribe \
  -H 'content-type: application/json' \
  -d '{"audio_path":"/abs/path/to/audio.m4a","model":"mlx-community/whisper-large-v3-turbo","language":"es"}'
curl -N http://127.0.0.1:$PORT/jobs/<job_id>/stream
```

### Run frontend standalone (without Tauri)

```bash
pnpm dev
```

Vite serves on `http://localhost:1420`. The frontend will detect that `window.__SIDECAR_URL__` is undefined and fall back to `http://127.0.0.1:8765`. Override by running the sidecar on that port:

```bash
cd python-sidecar
PORT=8765 uv run python -m whisper_sidecar
```

### Type-check / lint

```bash
pnpm exec tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cd python-sidecar && uv run pytest -q
```

### Build for distribution (unsigned, personal use)

```bash
source "$HOME/.cargo/env"
pnpm tauri build
```

Output lands in `src-tauri/target/release/bundle/`. The `.app` is unsigned — Gatekeeper will warn on first run. Right-click → Open the first time, or run `xattr -dr com.apple.quarantine path/to/Transcription Tool.app`.

> **Bundled-mode caveat**: the Rust sidecar spawn currently resolves `python-sidecar/` relative to the development project root. For a true distributable build, the `python-sidecar/` venv needs to be shipped as a resource and the path resolved via `app.path().resource_dir()`. This is marked as `TODO(bundled-mode)` in `src-tauri/src/lib.rs`. Personal-use dev mode works without it.

---

## Models

All models are MLX-converted variants from the `mlx-community` Hugging Face org. The first time you select a model, `mlx-whisper` downloads it to `~/.cache/huggingface/hub`. Disk usage:

| Model                                       | Size    | When to use                                  |
| ------------------------------------------- | ------- | -------------------------------------------- |
| `mlx-community/whisper-large-v3-turbo`      | ~1.6 GB | Default. Best speed/quality ratio.           |
| `mlx-community/whisper-large-v3-mlx`        | ~3.1 GB | Maximum quality. Slower. More RAM.           |
| `mlx-community/whisper-large-v3-mlx-4bit`   | ~0.8 GB | Quantized. Good for low-RAM Macs (<16 GB).   |
| `mlx-community/whisper-medium-mlx`          | ~1.5 GB | Balanced.                                    |
| `mlx-community/whisper-small-mlx`           | ~0.5 GB | Fast. Use only with clean audio.             |

To pre-download a model from the terminal (skips the in-app download wait):

```bash
cd python-sidecar
uv run python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/whisper-large-v3-turbo')"
```

---

## Troubleshooting

### "Sidecar didn't print SIDECAR_READY in time"

The Tauri Rust shell waits 10 seconds for the sidecar to bind a port. If the sidecar fails to start, check the dev console (View → Developer → Open Web Inspector) and the terminal stderr. Common causes:

- `uv` not on the search paths Tauri probes. The Rust shell looks in `/Users/cresenciof/pyenv/bin/uv`, `~/.local/bin/uv`, `~/.cargo/bin/uv`, `/opt/homebrew/bin/uv`, `/usr/local/bin/uv` in that order. Symlink or install `uv` to one of those.
- `python-sidecar/.venv` missing → `cd python-sidecar && uv sync`.
- Model download in progress on first run → just wait, or pre-download (see above).

### "Repository Not Found for url: https://huggingface.co/api/models/large-v3/..."

You're passing the wrong model identifier. `mlx-whisper` does **NOT** accept short names like `large-v3` — it expects a full Hugging Face repo ID. Always use `mlx-community/whisper-...`.

### Frontend shows "Sidecar offline" indefinitely

1. Confirm the sidecar process is alive: `pgrep -f whisper_sidecar`
2. Confirm `window.__SIDECAR_URL__` was injected: open dev tools console, evaluate `window.__SIDECAR_URL__`
3. If undefined, the Tauri Rust setup hook timed out. Restart the app and watch the terminal for errors.

### `pnpm tauri dev` rebuilds Rust forever

The first compile is ~3–5 min. After that it's incremental. If you ever see a full recompile, you probably edited a `Cargo.toml`.

### My Python global venv got wrecked

If your default Python or `~/pyenv` venv was a venv (not the `pyenv` version manager), running `uv run --active ...` while that venv was activated can recreate it with the sidecar's dependencies. **Never use `--active` outside of the project directory.** The sidecar's `start.sh` and the Tauri spawn intentionally avoid `--active`.

---

## How it works under the hood

### Port handshake

Python (`python-sidecar/src/whisper_sidecar/__main__.py`) pre-binds a socket on port 0, reads the OS-assigned port, prints `SIDECAR_READY <port>\n` to stdout, flushes, then hands the bound socket to uvicorn via `server.run(sockets=[sock])`. This eliminates the race window where the line could be printed before the port is actually listening.

Rust (`src-tauri/src/lib.rs`) spawns `uv run python -m whisper_sidecar --port 0`, reads stdout on a dedicated thread, parses the line, and delivers the port back to the setup hook via `sync_channel(1)` with `recv_timeout(Duration::from_secs(10))`.

### Progress streaming

`mlx-whisper` doesn't expose progress callbacks. The sidecar's `transcriber.py` temporarily redirects `sys.stdout` for the duration of the `mlx_whisper.transcribe(..., verbose=True)` call to a custom file-like object that:

1. Parses lines matching `[mm:ss.SSS --> mm:ss.SSS] text` via regex
2. Pushes parsed segments onto a `queue.Queue`
3. Bridges to the asyncio event loop via `loop.call_soon_threadsafe(...)`
4. SSE generator drains the asyncio queue and fans events out to all subscribers

Audio duration is determined via `ffprobe` if available, otherwise via `mlx_whisper.audio.load_audio` (slower, loads the whole file). Progress percent = `current_end_timestamp / total_duration`.

### Export

The frontend builds the export string (TXT/SRT/VTT/MD) entirely in the client. The Tauri save dialog (`@tauri-apps/plugin-dialog`) returns a path; for personal-use dev mode without `@tauri-apps/plugin-fs`, the export uses a Blob download triggered by an `<a download>` tag. The browser drops it in `~/Downloads`. To write to an arbitrary user-chosen folder, add a `write_file` Tauri command and wire `plugin-fs`. See `src/components/ExportBar.tsx` for the current implementation.

---

## Known limitations

- **macOS Apple Silicon only.** MLX has no Intel or non-Apple GPU support. No fallback path is planned.
- **No queue with parallelism.** MLX is GPU-bound; running multiple jobs in parallel saturates the same hardware. The UI processes one job at a time.
- **No speaker diarization.** Requires a second model (`pyannote.audio`) and a different pipeline. Out of scope for this MVP.
- **No persistence.** Job history is in-memory in the Python sidecar; closing the app loses it.
- **No code signing.** Personal use only. To distribute to others, add Apple Developer ID signing and notarization to `tauri.conf.json`.
- **Single SSE subscriber per job assumed in most flows.** The sidecar implements multi-subscriber fan-out + replay buffer, but the frontend only subscribes from the currently-focused job card.

---

## License

Personal use. No license file. If you fork it, do whatever — just don't blame me.
