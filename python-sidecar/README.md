# whisper-sidecar

FastAPI sidecar for the Tauri transcription tool. Wraps
[`mlx-whisper`](https://github.com/ml-explore/mlx-examples) and exposes a small
HTTP + Server-Sent Events API the desktop UI can drive.

> Apple Silicon only — `mlx-whisper` requires Metal.

## Quick start

```bash
cd python-sidecar
uv sync                                          # one-time
uv run python -m whisper_sidecar --port 0        # dev
```

On startup the process prints exactly one line to **stdout**:

```
SIDECAR_READY <port>
```

The Tauri parent reads that line to learn which ephemeral port we bound. After
that, only logs go to stderr — stdout stays quiet so the handshake is
unambiguous.

You can also use `./start.sh` (honors `PORT` env var; defaults to `0`).

## HTTP API

| Method | Path                    | Purpose                                                |
|-------:|-------------------------|--------------------------------------------------------|
| GET    | `/health`               | Liveness probe + version                               |
| GET    | `/models`               | Catalog of curated models + which are installed in HF cache |
| POST   | `/transcribe`           | Kick off a transcription. Returns `{job_id}`           |
| GET    | `/jobs`                 | Last 20 jobs (in-memory)                               |
| GET    | `/jobs/{id}`            | Full job state (status, segments, text, error...)      |
| GET    | `/jobs/{id}/stream`     | SSE stream — `progress` / `segment` / `done` / `error` |
| DELETE | `/jobs/{id}`            | Cancel + remove                                        |

### SSE event reference

```
event: progress
data:  {"current_s": 12.4, "total_s": 305.2, "percent": 4.06}

event: segment
data:  {"start": 0.0, "end": 5.2, "text": "..."}

event: done
data:  {"text": "...", "segments": [...], "duration_s": 305.2, "elapsed_s": 27.3}

event: error
data:  {"message": "..."}
```

Late subscribers (connecting after the job has already produced events) receive
a full replay of everything that happened, plus the terminal `done`/`error`
event. Multiple concurrent subscribers per job are supported via fan-out.

## Tests

```bash
uv run pytest -q
```

## Layout

```
python-sidecar/
  pyproject.toml
  uv.lock
  start.sh
  src/whisper_sidecar/
    __init__.py
    __main__.py        # CLI entrypoint, port handshake
    app.py             # FastAPI routes + CORS + SSE
    audio.py           # ffprobe duration with mlx_whisper fallback
    config.py          # Settings + hardcoded model catalog
    hf_cache.py        # Scan ~/.cache/huggingface/hub
    jobs.py            # Job dataclass + JobRegistry + pub/sub
    models.py          # Pydantic request/response schemas
    transcriber.py     # mlx_whisper worker thread + stdout parser
  tests/
    test_jobs.py
    test_parse_segment.py
```
