# Echo Script

> Native, offline audio transcription for Apple Silicon Macs. Drop a file, get a transcript. Nothing leaves your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Platform: macOS Apple Silicon](https://img.shields.io/badge/platform-macOS%20%7C%20Apple%20Silicon-blue)
<!-- Build status badge intentionally omitted until CI workflow is wired up. -->

<!-- SCREENSHOT: drop a screenshot of the app at ./docs/screenshot.png and reference it here, e.g.:
     ![Echo Script](./docs/screenshot.png)
     Suggested: a screenshot of the workspace view with a completed transcript and the audio player. -->

## What it is

A small desktop app that runs OpenAI Whisper locally on your Mac using Apple's [MLX](https://github.com/ml-explore/mlx) framework via [`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper). You drop in an audio file, it transcribes on-device, and you can edit and export the result.

It is **not** a cloud service. It is **not** cross-platform. It is **not** a replacement for a hosted transcription service if you need diarization, real-time meeting capture, or multi-user collaboration. It is for one person, on one Mac, who wants their audio to stay on that Mac.

## Features

- Native macOS app — Tauri shell, WKWebView, small footprint
- Live transcription progress — segments stream in as they're decoded
- Multiple Whisper models (large-v3-turbo by default; smaller and quantized variants available)
- Export to TXT, SRT, VTT, Markdown
- Editable transcript with click-to-seek audio player
- Dark mode by design

## Install (for users)

> Pre-built downloads are published on the [Releases](https://github.com/cresenciof/echo-script/releases) page when available. If there is no release yet, build from source (see below).

1. Download the latest `.dmg` from [Releases](https://github.com/cresenciof/echo-script/releases).
2. Open the DMG and drag **Echo Script** into `/Applications`.
3. First launch — the app is not signed with an Apple Developer ID, so macOS Gatekeeper will block it. Either:
   - **Right-click → Open**, confirm in the dialog. macOS remembers your choice.
   - Or, from the terminal:
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Echo Script.app"
     ```
4. First transcription — the default model (`mlx-community/whisper-large-v3-turbo`, ~1.6 GB) downloads from Hugging Face into `~/.cache/huggingface/hub`. The app stays responsive but the first job will wait on the download. To pre-download:
   ```bash
   pip install huggingface_hub
   python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/whisper-large-v3-turbo')"
   ```

## Build from source (for developers)

### Prerequisites

| Tool      | Minimum | Install                                                                       |
| --------- | ------- | ----------------------------------------------------------------------------- |
| macOS     | 13+     | Apple Silicon only (M1/M2/M3/M4). MLX has no Intel path.                       |
| Xcode CLT | current | `xcode-select --install`                                                       |
| Rust      | 1.78+   | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y`     |
| Node.js   | 20+     | `brew install node` (or use `nvm`/`fnm`/Volta)                                 |
| pnpm      | 9+      | `corepack enable && corepack prepare pnpm@latest --activate`                   |
| uv        | latest  | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                             |
| ffmpeg    | optional| `brew install ffmpeg` (only needed for accurate audio-duration progress %)     |

After installing Rust, run `source "$HOME/.cargo/env"` (or restart your shell) so `cargo` is on PATH.

### Quick start

```bash
git clone https://github.com/cresenciof/echo-script.git
cd echo-script
pnpm install
cd python-sidecar && uv sync && cd ..
pnpm tauri dev
```

The first `pnpm tauri dev` takes a few minutes — Rust compiles the entire dependency tree. After that, incremental rebuilds are seconds.

### Building a distributable

```bash
pnpm tauri build
```

Output is in `src-tauri/target/release/bundle/`. The `.app` is unsigned; users will need the Gatekeeper workaround documented above.

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

### Project layout

```
echo-script/
├── src/                          # React + TS frontend
│   ├── App.tsx                   # Routing between empty / working / result states
│   ├── components/               # UI: Dropzone, ModelPicker, JobCard, TranscriptView, etc.
│   ├── hooks/                    # useModels, useTranscription, useExporter, useHealth, useKeymap
│   ├── lib/                      # api.ts, sse.ts, sidecar.ts, timeFormat.ts
│   ├── state/                    # Zustand stores
│   ├── styles.css                # Tailwind v4 + oklch design tokens
│   └── types/
├── src-tauri/                    # Tauri Rust shell
│   ├── src/lib.rs                # Sidecar spawn, port handshake, webview injection
│   ├── tauri.conf.json
│   └── Cargo.toml
├── python-sidecar/               # FastAPI + mlx-whisper
│   ├── src/whisper_sidecar/
│   ├── tests/
│   ├── pyproject.toml
│   └── start.sh
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
└── README.md
```

### Running pieces in isolation

Run the sidecar standalone (for debugging):

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

Run the frontend standalone (without Tauri):

```bash
pnpm dev
```

Vite serves on `http://localhost:1420`. With `window.__SIDECAR_URL__` undefined, it falls back to `http://127.0.0.1:8765` — point the sidecar there:

```bash
cd python-sidecar
PORT=8765 uv run python -m whisper_sidecar
```

### Type-check / lint / test

```bash
pnpm exec tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cd python-sidecar && uv run pytest -q
```

## Models

All models are public, MLX-converted variants from the [`mlx-community`](https://huggingface.co/mlx-community) Hugging Face organization. The first time you select a model, `mlx-whisper` downloads it to `~/.cache/huggingface/hub`.

| Model                                       | Size    | When to use                                  |
| ------------------------------------------- | ------- | -------------------------------------------- |
| `mlx-community/whisper-large-v3-turbo`      | ~1.6 GB | Default. Best speed/quality ratio.           |
| `mlx-community/whisper-large-v3-mlx`        | ~3.1 GB | Maximum quality. Slower. More RAM.           |
| `mlx-community/whisper-large-v3-mlx-4bit`   | ~0.8 GB | Quantized. Good for low-RAM Macs (<16 GB).   |
| `mlx-community/whisper-medium-mlx`          | ~1.5 GB | Balanced.                                    |
| `mlx-community/whisper-small-mlx`           | ~0.5 GB | Fast. Use only with clean audio.             |

Pre-download a model from the terminal (skips the in-app wait):

```bash
cd python-sidecar
uv run python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/whisper-large-v3-turbo')"
```

## Troubleshooting

### "Sidecar didn't print SIDECAR_READY in time"

The Tauri Rust shell waits 10 seconds for the sidecar to bind a port. If the sidecar fails to start, check the dev console (View → Developer → Open Web Inspector) and the terminal stderr. Common causes:

- `uv` not on the search paths Tauri probes. The Rust shell looks in `~/.local/bin/uv`, `~/.cargo/bin/uv`, `/opt/homebrew/bin/uv`, `/usr/local/bin/uv` in that order. Symlink or install `uv` to one of those.
- `python-sidecar/.venv` missing → `cd python-sidecar && uv sync`.
- Model download in progress on first run → wait, or pre-download (see [Models](#models)).

### "Repository Not Found for url: https://huggingface.co/api/models/large-v3/..."

You're passing the wrong model identifier. `mlx-whisper` does **NOT** accept short names like `large-v3` — it expects a full Hugging Face repo ID. Always use `mlx-community/whisper-...`.

### Frontend shows "Sidecar offline" indefinitely

1. Confirm the sidecar process is alive: `pgrep -f whisper_sidecar`
2. Confirm `window.__SIDECAR_URL__` was injected: open dev tools console, evaluate `window.__SIDECAR_URL__`
3. If undefined, the Tauri Rust setup hook timed out. Restart the app and watch the terminal for errors.

### `pnpm tauri dev` rebuilds Rust forever

The first compile is ~3–5 min. After that it's incremental. A full recompile usually means a `Cargo.toml` changed.

## Known limitations

- **macOS Apple Silicon only.** MLX has no Intel or non-Apple GPU support. No fallback path is planned.
- **No parallel jobs.** MLX is GPU-bound; running multiple jobs in parallel saturates the same hardware. The UI processes one job at a time.
- **No speaker diarization.** Out of scope for the MVP.
- **No persistence.** Job history is in-memory in the sidecar; closing the app loses it.
- **No code signing.** The `.app` is unsigned. End users hit Gatekeeper on first launch.
- **Single SSE subscriber per job in practice.** The sidecar supports multi-subscriber fan-out + replay, but the frontend only subscribes from the focused job card.

## Contributing

PRs are welcome, but this is a small personal-first project — please open an issue first for anything beyond a typo or obvious bug fix. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, commit style, and pre-flight checks.

## Acknowledgments

This project would not exist without:

- [`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper) and Apple's [MLX](https://github.com/ml-explore/mlx) framework
- The [`mlx-community`](https://huggingface.co/mlx-community) Hugging Face org for the MLX-converted Whisper models
- [Tauri](https://tauri.app/), [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/), [Zustand](https://github.com/pmndrs/zustand), [TanStack Query](https://tanstack.com/query)
- [FastAPI](https://fastapi.tiangolo.com/), [sse-starlette](https://github.com/sysid/sse-starlette), [uv](https://github.com/astral-sh/uv)

## License

[MIT](./LICENSE).

## Security

If you find a vulnerability, please **do not** open a public issue. See [SECURITY.md](./SECURITY.md) for the disclosure process.
