# Echo Script

> The open-source alternative to MacWhisper. Free, native, offline audio & video transcription for Apple Silicon, powered by Apple's [MLX](https://github.com/ml-explore/mlx) framework.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Platform: macOS Apple Silicon](https://img.shields.io/badge/platform-macOS%20%7C%20Apple%20Silicon-blue)
![Stack: Tauri · React · MLX](https://img.shields.io/badge/stack-Tauri%20%C2%B7%20React%20%C2%B7%20MLX-purple)

<img width="1212" alt="Echo Script — main window" src="https://github.com/user-attachments/assets/464b0dfc-d982-4639-af10-1af4d0e8745d" />

## Why this exists

[`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper) is genuinely fast on Apple Silicon and 100% local, but the CLI is friction for non-engineers. [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) is polished but **$59 and closed source**. There was a gap for a free, open-source, native Mac app that runs Whisper offline with a real UI.

Echo Script is that app.

## Install

### Homebrew (recommended)

```bash
brew install --cask cresenciof/echo-script/echo-script
```

Homebrew taps `cresenciof/homebrew-echo-script`, downloads the DMG, and drops `Echo Script.app` into `/Applications`.

Because the app is not Apple-signed, macOS Gatekeeper will block the first launch. Clear the quarantine flag from the terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Echo Script.app"
```

Then open the app normally. On macOS Sequoia and later the old "right-click → Open" trick no longer works for unsigned apps — `xattr` is the reliable path.

### Direct DMG

1. Download the latest `.dmg` from [Releases](https://github.com/cresenciof/echo-script/releases).
2. Drag **Echo Script** into `/Applications`.
3. Clear quarantine the same way as above: `xattr -dr com.apple.quarantine "/Applications/Echo Script.app"`.

### First transcription

The default model (`mlx-community/whisper-large-v3-mlx-4bit`, ~0.8 GB) downloads from Hugging Face on first use into `~/.cache/huggingface/hub`. The download indicator is shown in-app. To pre-download:

```bash
pip install huggingface_hub
python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/whisper-large-v3-mlx-4bit')"
```

## Features

- **Drag-and-drop audio or video** — `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`
- **Waveform editor** — pick a region of the file to transcribe (instead of the whole thing)
- **Live segment streaming** — segments appear as they're decoded, not after
- **Cancel in-flight transcription** — no waiting through a 30-minute file you no longer need
- **Click-to-seek transcript** — click a segment, the audio jumps there
- **Export** — TXT, SRT, VTT, Markdown, and for videos: soft subtitles (track) or burned-in subtitles
- **Idle model unloading** — frees ~3 GB of unified memory when idle for 5 min
- **100% offline** — no cloud, no telemetry, no analytics
- **Multiple Whisper models** — 4-bit quantized (default), turbo, large, medium, small

<img width="1212" alt="Waveform region selector" src="https://github.com/user-attachments/assets/02c63ac4-a357-457e-be8e-5c8048e0d5d6" />

<img width="1212" alt="Workspace view with live transcript" src="https://github.com/user-attachments/assets/9b08a657-afa0-4906-b2ff-fe13357f60e0" />

<img width="1501" alt="Echo Script in use" src="https://github.com/user-attachments/assets/39cdfae8-4809-4a4b-b244-3584b3267d57" />

## How it compares

| Feature                       | **Echo Script**  | MacWhisper | Aiko       | whisper.cpp |
| ----------------------------- | ---------------- | ---------- | ---------- | ----------- |
| Price                         | **Free (MIT)**   | $59        | Free       | Free        |
| Open source                   | ✅                | ❌          | ❌          | ✅           |
| Native macOS UI               | ✅                | ✅          | ✅          | ❌ (CLI)     |
| Apple Silicon optimized       | ✅ MLX            | ✅ Core ML  | ✅ Core ML  | ✅ Metal     |
| 100% offline                  | ✅                | ✅          | ✅          | ✅           |
| Drag-and-drop video           | ✅                | ✅          | ❌          | ❌           |
| Waveform region selection     | ✅                | ✅          | ❌          | ❌           |
| Live segment streaming        | ✅                | ✅          | ❌          | partial     |
| Cancel in-flight              | ✅                | ✅          | ❌          | n/a         |
| Burned-in subtitles for video | ✅                | ✅          | ❌          | ❌           |
| Speaker diarization           | ❌                | ✅          | ❌          | ❌           |
| Translation                   | planned          | ✅          | ✅          | ✅           |
| Batch queue                   | ❌                | ✅          | ❌          | n/a         |

> Honest note: MacWhisper has years of polish and features Echo Script doesn't (yet). Echo Script targets the core "drop file → get transcript" workflow at zero cost, with the code open for inspection.

## How it works

```
┌────────────────────────────────────────────────────────────┐
│  Tauri shell (Rust)                                        │
│  • spawns Python sidecar on startup                        │
│  • reads `SIDECAR_READY <port>` handshake from stdout      │
│  • bundles ffmpeg + ffprobe (LGPL static build)            │
│  • Tauri command: compute_audio_peaks (ffmpeg → PCM)       │
│  • Tauri command: export_subtitled_video (soft / burn-in)  │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│  React + Vite (WKWebView)                                  │
│  • Zustand store for jobs & audio state                    │
│  • TanStack Query for /models, /health                     │
│  • EventSource (SSE) for /jobs/{id}/stream                 │
│  • WaveSurfer.js with externally-supplied peaks (ffmpeg)   │
└─────────────────────────┬──────────────────────────────────┘
                          │ HTTP + SSE on 127.0.0.1:<random>
┌─────────────────────────▼──────────────────────────────────┐
│  Python sidecar (FastAPI + uvicorn)                        │
│  • POST /transcribe        → returns job_id                │
│  • GET  /jobs/{id}/stream  → SSE: progress|segment|done    │
│  • POST /jobs/{id}/cancel  → non-destructive cancel        │
│  • GET  /models            → catalog + installed status    │
│  • parent-PID watchdog (kills self if Tauri dies)          │
│  • idle model unloader (frees unified memory after 5 min)  │
└────────────────────────────────────────────────────────────┘
```

The sidecar ships as a fully-relocatable Python installation (via [python-build-standalone](https://github.com/astral-sh/python-build-standalone)) so the DMG runs on any Apple Silicon Mac without Homebrew or pyenv.

### Why a sidecar (and not a Rust-native Whisper)?

`mlx-whisper` is Python and depends on Apple's MLX framework which is Python-first. Reimplementing it in Rust would mean either reinventing MLX or wrapping it via PyO3 anyway. A small FastAPI sidecar spawned by Tauri keeps the boundary clean: Rust handles the OS shell, Python handles the model.

### Port handshake

Python (`python-sidecar/src/whisper_sidecar/__main__.py`) pre-binds a socket on port 0, reads the OS-assigned port, prints `SIDECAR_READY <port>\n` to stdout, flushes, then hands the bound socket to uvicorn. This eliminates the race where the line could be printed before the port is actually listening.

Rust (`src-tauri/src/lib.rs`) spawns the sidecar, reads stdout on a dedicated thread, parses the line, and delivers the port back to the setup hook via a `sync_channel(1)` with a 10-second timeout.

### Progress streaming

`mlx-whisper` doesn't expose progress callbacks. The sidecar temporarily redirects `sys.stdout` for the duration of `mlx_whisper.transcribe(..., verbose=True)` to a custom file-like that:

1. Parses `[mm:ss.SSS --> mm:ss.SSS] text` segment lines via regex
2. Pushes parsed segments onto a `queue.Queue`
3. Bridges to the asyncio event loop via `loop.call_soon_threadsafe(...)`
4. SSE generator drains the queue and fans events out to subscribers

Hugging Face model-download progress is captured the same way from stderr — tqdm uses `\r` overwrites, so the capture stream splits on both `\n` and `\r`.

### Memory hardening

Echo Script holds up to ~3 GB of unified memory while a model is loaded. Three guards prevent that from becoming system-wide pressure:

- **Parent PID watchdog** — a daemon thread polls `os.getppid()` every 5 s. If Tauri crashes and the sidecar gets reparented to launchd, it self-`SIGTERM`s within seconds instead of lingering as a zombie.
- **Idle model unloader** — after 5 min of inactivity, an asyncio task nulls `mlx_whisper.transcribe.ModelHolder.model` and calls `mx.metal.clear_cache()`.
- **Bounded peaks decoder** — `compute_audio_peaks` reads ffmpeg PCM in 64 KB chunks with a 50 MB cap, so a 2-hour video can't OOM the renderer.

## Build from source

### Prerequisites

| Tool      | Minimum  | Install                                                                       |
| --------- | -------- | ----------------------------------------------------------------------------- |
| macOS     | 13+      | Apple Silicon only (M1/M2/M3/M4). MLX has no Intel path.                       |
| Xcode CLT | current  | `xcode-select --install`                                                       |
| Rust      | 1.78+    | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y`     |
| Node.js   | 20+      | `brew install node` (or use `nvm`/`fnm`/Volta)                                 |
| pnpm      | 10+      | `corepack enable && corepack prepare pnpm@latest --activate`                   |
| uv        | latest   | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                             |
| ffmpeg    | optional | `brew install ffmpeg` (only for dev; the DMG bundles its own static build)    |

### Quick start

```bash
git clone https://github.com/cresenciof/echo-script.git
cd echo-script
pnpm install
cd python-sidecar && uv sync && cd ..
pnpm tauri dev
```

The first `pnpm tauri dev` takes a few minutes — Rust compiles the entire dependency tree. After that, incremental rebuilds are seconds.

### Building a distributable DMG

```bash
./scripts/build-sidecar-bundle.sh   # bundles a portable Python + ffmpeg
pnpm tauri build
```

Output lives in `src-tauri/target/release/bundle/dmg/`. The `.app` is unsigned; end users hit Gatekeeper on first launch (see [Install](#install)).

### Project layout

```
echo-script/
├── src/                          # React + TS frontend
│   ├── components/               # WaveformSelector, JobList, ExportBar, etc.
│   ├── hooks/                    # useTranscription, useTauriDragDrop, useExporter
│   ├── lib/                      # api, sse, audioFormats, timeFormat
│   ├── state/                    # Zustand stores
│   └── styles.css                # Tailwind v4 + oklch design tokens
├── src-tauri/                    # Tauri Rust shell
│   ├── src/lib.rs                # sidecar spawn, peaks, subtitle export
│   ├── tauri.conf.json
│   └── Cargo.toml
├── python-sidecar/               # FastAPI + mlx-whisper
│   ├── src/whisper_sidecar/
│   ├── tests/
│   └── pyproject.toml
├── scripts/build-sidecar-bundle.sh
├── .github/workflows/            # SHA-pinned CI + release
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
└── README.md
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
| `mlx-community/whisper-large-v3-mlx-4bit`   | ~0.8 GB | **Default.** Quantized, low-RAM, good quality. |
| `mlx-community/whisper-large-v3-turbo`      | ~1.6 GB | Best speed/quality ratio in full precision.  |
| `mlx-community/whisper-large-v3-mlx`        | ~3.1 GB | Maximum quality. Slower. More RAM.           |
| `mlx-community/whisper-medium-mlx`          | ~1.5 GB | Balanced.                                    |
| `mlx-community/whisper-small-mlx`           | ~0.5 GB | Fast. Use only with clean audio.             |

Pre-download a model from the terminal (skips the in-app wait):

```bash
cd python-sidecar
uv run python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/whisper-large-v3-mlx-4bit')"
```

## Troubleshooting

### "Sidecar didn't print SIDECAR_READY in time"

Common causes:

- `uv` not on the search paths Tauri probes. The Rust shell looks in `~/.local/bin/uv`, `~/.cargo/bin/uv`, `/opt/homebrew/bin/uv`, `/usr/local/bin/uv` in that order. Symlink or install `uv` to one of those.
- `python-sidecar/.venv` missing → `cd python-sidecar && uv sync`.
- Model download in progress on first run → wait, or pre-download (see [Models](#models)).

### "Repository Not Found for url: .../large-v3/..."

You're passing a short model name. `mlx-whisper` does **NOT** accept `large-v3` — it expects a full Hugging Face repo ID. Always use `mlx-community/whisper-...`.

### Frontend shows "Sidecar offline"

1. Confirm the sidecar process is alive: `pgrep -f whisper_sidecar`
2. Confirm `window.__SIDECAR_URL__` was injected: open dev tools console, evaluate it
3. If undefined, the Tauri Rust setup hook timed out. Restart the app and watch the terminal for errors.

### `pnpm tauri dev` rebuilds Rust forever

The first compile is ~3–5 min. After that it's incremental. A full recompile usually means a `Cargo.toml` changed.

## Known limitations

- **macOS Apple Silicon only.** MLX has no Intel or non-Apple GPU support. No fallback path is planned.
- **No parallel jobs.** MLX is GPU-bound; running multiple jobs in parallel saturates the same hardware.
- **No speaker diarization.** Out of scope for the current release.
- **No persistence.** Job history is in-memory; closing the app loses it.
- **No code signing.** The `.app` is unsigned. End users hit Gatekeeper on first launch.

## Roadmap

Nothing here is promised — these are directions I'm interested in, not commitments.

- Translation mode (Whisper natively supports it, just needs a UI toggle)
- Job history persistence
- Auto-updater via Tauri updater plugin
- Apple Developer ID signing + notarization (removes Gatekeeper friction)

## Contributing

PRs are welcome, but this is a small project — please open an issue first for anything beyond a typo or obvious bug fix. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, commit style, and pre-flight checks.

## Acknowledgments

- [`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper) and Apple's [MLX](https://github.com/ml-explore/mlx) framework
- The [`mlx-community`](https://huggingface.co/mlx-community) Hugging Face org for the MLX-converted Whisper models
- [Tauri](https://tauri.app/), [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/), [Zustand](https://github.com/pmndrs/zustand), [TanStack Query](https://tanstack.com/query), [WaveSurfer.js](https://wavesurfer.xyz/)
- [FastAPI](https://fastapi.tiangolo.com/), [sse-starlette](https://github.com/sysid/sse-starlette), [uv](https://github.com/astral-sh/uv), [python-build-standalone](https://github.com/astral-sh/python-build-standalone)

## License

[MIT](./LICENSE).

## Security

If you find a vulnerability, please **do not** open a public issue. See [SECURITY.md](./SECURITY.md) for the disclosure process.
