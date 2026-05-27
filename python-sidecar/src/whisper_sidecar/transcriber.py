"""mlx-whisper worker.

mlx_whisper is sync and offloads heavy work to MLX (GPU on Apple Silicon).
We run it on a dedicated thread and stream its progress to the SSE layer
by capturing its stdout.

`mlx_whisper.transcribe(..., verbose=True)` emits one line per decoded
segment in the exact format `[MM:SS.mmm --> MM:SS.mmm]  text content`.
A custom `io.TextIOBase` intercepts those lines, parses them, and pushes
SseEvents onto the job's pub/sub fan-out. After the call returns we emit
a final `done` event with the full result.
"""

from __future__ import annotations

import contextlib
import io
import logging
import re
import sys
import threading
import time
from typing import Any

from .audio import probe_duration_seconds
from .jobs import Job, JobRegistry, SseEvent
from .tqdm_parser import ModelDownloadProgress, parse_hf_download

logger = logging.getLogger(__name__)

SEGMENT_RE = re.compile(r"^\[(\d+):(\d+)\.(\d+)\s*-->\s*(\d+):(\d+)\.(\d+)\]\s*(.*)$")


def parse_segment_line(line: str) -> dict[str, Any] | None:
    """Convert a verbose mlx_whisper line into `{start, end, text}` seconds floats.

    Returns None if the line doesn't match the segment pattern (e.g. tqdm
    progress, blank lines).
    """
    m = SEGMENT_RE.match(line.strip())
    if not m:
        return None
    sh, sm, sms, eh, em, ems, text = m.groups()
    start = int(sh) * 60 + int(sm) + int(sms) / 1000.0
    end = int(eh) * 60 + int(em) + int(ems) / 1000.0
    return {"start": start, "end": end, "text": text.strip()}


class _SegmentCaptureStream(io.TextIOBase):
    """File-like stdout shim that intercepts mlx_whisper's per-segment lines.

    Lines are line-buffered (mlx_whisper uses `print(...)` which appends `\\n`).
    Anything we recognize as a segment is pushed to `on_segment`; everything
    else is forwarded to `mirror` so logs aren't swallowed.
    """

    def __init__(self, mirror, on_segment) -> None:
        self._buf = ""
        self._mirror = mirror
        self._on_segment = on_segment

    def writable(self) -> bool:  # pragma: no cover - trivial
        return True

    def write(self, s: str) -> int:
        if not isinstance(s, str):  # pragma: no cover - defensive
            s = str(s)
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            parsed = parse_segment_line(line)
            if parsed is not None:
                try:
                    self._on_segment(parsed)
                except Exception:  # pragma: no cover - keep stdout flowing
                    logger.exception("on_segment callback failed")
            else:
                # Echo non-segment lines so user still sees real logs.
                try:
                    self._mirror.write(line + "\n")
                    self._mirror.flush()
                except Exception:
                    pass
        return len(s)

    def flush(self) -> None:
        try:
            self._mirror.flush()
        except Exception:
            pass


class _DownloadCaptureStream(io.TextIOBase):
    """File-like stderr shim that intercepts huggingface_hub tqdm progress bars.

    Unlike mlx_whisper's stdout (which emits one line per segment terminated
    by ``\\n``), tqdm overwrites the SAME terminal line by writing ``\\r`` then
    the new bar — so we MUST split on both ``\\n`` and ``\\r`` to see updates
    in real time. Otherwise the buffer just keeps growing and we'd only ever
    see a single "100%" line at the very end.

    Non-matching fragments are forwarded to ``mirror`` so the user's normal
    stderr logs aren't swallowed.
    """

    def __init__(self, mirror, on_download) -> None:
        self._buf = ""
        self._mirror = mirror
        self._on_download = on_download

    def writable(self) -> bool:  # pragma: no cover - trivial
        return True

    def write(self, s: str) -> int:
        if not isinstance(s, str):  # pragma: no cover - defensive
            s = str(s)
        self._buf += s
        # tqdm writes "\r<bar>" repeatedly without newlines while the
        # download is in flight, and finally "\n" when done. Splitting on
        # both characters lets us react to in-flight updates AND finalize
        # the buffer when the bar completes.
        while True:
            idx_n = self._buf.find("\n")
            idx_r = self._buf.find("\r")
            candidates = [i for i in (idx_n, idx_r) if i != -1]
            if not candidates:
                break
            idx = min(candidates)
            line, self._buf = self._buf[:idx], self._buf[idx + 1 :]
            if not line:
                continue
            progress = parse_hf_download(line)
            if progress is not None:
                try:
                    self._on_download(progress)
                except Exception:  # pragma: no cover - keep stderr flowing
                    logger.exception("on_download callback failed")
            else:
                # Echo non-tqdm lines so the user still sees real stderr logs.
                try:
                    self._mirror.write(line + "\n")
                    self._mirror.flush()
                except Exception:
                    pass
        return len(s)

    def flush(self) -> None:
        try:
            self._mirror.flush()
        except Exception:
            pass


class TranscriptionWorker:
    """Owns the worker thread for a single job."""

    # Minimum interval between successive `model_download` SSE events for the
    # SAME file. tqdm can emit dozens of updates per second; emitting all of
    # them would flood the frontend without giving the user any extra signal.
    _DOWNLOAD_EMIT_INTERVAL_S = 0.25  # ~4 events/second

    def __init__(self, registry: JobRegistry, job: Job, initial_prompt: str | None) -> None:
        self.registry = registry
        self.job = job
        self.initial_prompt = initial_prompt
        self._thread: threading.Thread | None = None
        self._last_download_emit_at: float = 0.0
        self._last_download_filename: str = ""

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name=f"transcribe-{self.job.id[:8]}", daemon=True
        )
        self._thread.start()

    # -- internal --------------------------------------------------------------

    def _emit_progress(self, current_s: float) -> None:
        total = self.job.audio_duration_s
        percent: float | None = None
        if total and total > 0:
            percent = min(100.0, (current_s / total) * 100.0)
        self.job.publish(
            SseEvent(
                event="progress",
                data={"current_s": current_s, "total_s": total, "percent": percent},
            )
        )

    def _on_segment(self, seg: dict[str, Any]) -> None:
        # Stash on the job for later GET /jobs/{id} polling.
        self.job.segments.append(seg)
        self.job.publish(SseEvent(event="segment", data=seg))
        self._emit_progress(seg["end"])

    def _on_download(self, progress: ModelDownloadProgress) -> None:
        # Throttle to ~4 events/sec per file. Always let the very first event
        # and 100% events through so the UI shows the banner immediately and
        # we never strand it at 99%.
        now = time.time()
        is_new_file = progress.filename != self._last_download_filename
        is_complete = progress.percent >= 100.0
        elapsed = now - self._last_download_emit_at
        if (
            not is_new_file
            and not is_complete
            and elapsed < self._DOWNLOAD_EMIT_INTERVAL_S
        ):
            return
        self._last_download_emit_at = now
        self._last_download_filename = progress.filename
        self.job.publish(
            SseEvent(
                event="model_download",
                data={
                    "kind": "model_download",
                    "filename": progress.filename,
                    "downloaded_bytes": progress.downloaded_bytes,
                    "total_bytes": progress.total_bytes,
                    "percent": progress.percent,
                },
            )
        )

    def _run(self) -> None:
        job = self.job
        job.status = "running"
        try:
            # 1. Pre-flight: audio duration for accurate progress %.
            job.audio_duration_s = probe_duration_seconds(job.audio_path)

            # 2. Import lazily so server startup stays fast even if MLX isn't ready.
            import mlx_whisper  # type: ignore[import-untyped]

            kwargs: dict[str, Any] = {
                "path_or_hf_repo": job.model,
                "verbose": True,
            }
            if job.language:
                kwargs["language"] = job.language
            if self.initial_prompt:
                kwargs["initial_prompt"] = self.initial_prompt

            stdout_capture = _SegmentCaptureStream(sys.__stdout__, self._on_segment)
            stderr_capture = _DownloadCaptureStream(sys.__stderr__, self._on_download)
            start_t = time.time()
            # mlx_whisper -> huggingface_hub pushes tqdm download bars to
            # stderr; mlx_whisper's verbose segment output goes to stdout.
            # We need BOTH redirected to surface the new model_download UX
            # while keeping segment streaming working.
            with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
                if job.cancel_flag.is_set():
                    raise InterruptedError("cancelled before start")
                result = mlx_whisper.transcribe(job.audio_path, **kwargs)
            stdout_capture.flush()
            stderr_capture.flush()
            elapsed = time.time() - start_t

            if job.cancel_flag.is_set():
                raise InterruptedError("cancelled during run")

            # mlx_whisper's own segment list is authoritative — replace our
            # stdout-parsed shadow copy with the real one.
            real_segments = [
                {"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
                for s in result.get("segments", [])
            ]
            job.segments = real_segments
            job.text = (result.get("text") or "").strip()
            job.status = "done"
            job.finished_at = time.time()
            job.publish(
                SseEvent(
                    event="done",
                    data={
                        "text": job.text,
                        "segments": real_segments,
                        "duration_s": job.audio_duration_s,
                        "elapsed_s": elapsed,
                    },
                )
            )
        except InterruptedError as exc:
            job.status = "cancelled"
            job.error = str(exc) or "cancelled"
            job.finished_at = time.time()
            job.publish(SseEvent(event="error", data={"message": job.error}))
        except Exception as exc:
            logger.exception("transcription failed for job %s", job.id)
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"
            job.finished_at = time.time()
            job.publish(SseEvent(event="error", data={"message": job.error}))
        finally:
            job.close_subscribers()
