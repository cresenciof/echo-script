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
import os
import re
import shutil
import subprocess
import sys
import tempfile
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


def build_ffmpeg_slice_args(
    ffmpeg: str,
    input_path: str,
    output_path: str,
    start_s: float | None,
    end_s: float | None,
) -> list[str]:
    """Build the ffmpeg argv to extract [start_s, end_s] from ``input_path``.

    Returns an empty list when both endpoints are None — callers must skip
    invoking ffmpeg entirely in that case (preserves the legacy fast path).

    ``-ss`` is placed BEFORE ``-i`` for fast seek; for audio this is accurate.
    ``-to`` is an absolute end time relative to the original file (NOT a
    duration). The audio is downmixed to mono 16 kHz WAV — what mlx_whisper
    expects natively, so it skips its own ffmpeg re-decode step.
    """
    if start_s is None and end_s is None:
        return []
    args: list[str] = [ffmpeg, "-y"]
    if start_s is not None:
        args += ["-ss", _fmt_seconds(start_s)]
    if end_s is not None:
        args += ["-to", _fmt_seconds(end_s)]
    args += [
        "-i", input_path,
        "-vn",            # drop any video tracks (mp4 containers, album art).
        "-ac", "1",       # mono.
        "-ar", "16000",   # 16 kHz sample rate.
        "-f", "wav",      # PCM WAV container.
        output_path,
    ]
    return args


def _fmt_seconds(s: float) -> str:
    """Format seconds for ffmpeg ``-ss`` / ``-to``.

    Integers render without a trailing ``.0`` so callers' assertions stay
    readable (and ffmpeg accepts both forms).
    """
    if float(s).is_integer():
        return str(int(s))
    # Trim trailing zeros and any orphan decimal point.
    return f"{s:.6f}".rstrip("0").rstrip(".")


def offset_segment(seg: dict[str, Any], offset: float) -> dict[str, Any]:
    """Return a copy of ``seg`` with ``start`` and ``end`` shifted by ``offset``.

    Used to translate mlx_whisper's slice-relative timestamps (which always
    start at 0 because we hand it a freshly sliced file) back into absolute
    timestamps in the original file. Leaves the rest of the dict untouched.
    """
    shifted = dict(seg)
    shifted["start"] = float(seg["start"]) + offset
    shifted["end"] = float(seg["end"]) + offset
    return shifted


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
        # Offset applied to every segment timestamp emitted by mlx_whisper so
        # the UI always sees absolute times relative to the original file —
        # even when we hand mlx_whisper a sliced fragment that starts at 0.
        self._offset: float = job.start_s or 0.0

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name=f"transcribe-{self.job.id[:8]}", daemon=True
        )
        self._thread.start()

    # -- internal --------------------------------------------------------------

    def _emit_progress(self, current_s: float) -> None:
        # ``current_s`` is ALREADY in absolute (original-file) coordinates
        # because callers add the offset before invoking us. ``total`` is the
        # SELECTED duration so the percent reflects progress through the slice,
        # but we compare against (start + slice_duration) to keep the math
        # consistent with the absolute current_s.
        total = self.job.audio_duration_s
        percent: float | None = None
        if total and total > 0:
            elapsed = max(0.0, current_s - self._offset)
            percent = min(100.0, (elapsed / total) * 100.0)
        self.job.publish(
            SseEvent(
                event="progress",
                data={"current_s": current_s, "total_s": total, "percent": percent},
            )
        )

    def _on_segment(self, seg: dict[str, Any]) -> None:
        # mlx_whisper times segments relative to whatever file we passed it.
        # When we slice, that file starts at 0 — so add the offset before
        # surfacing the segment anywhere (job state, SSE, progress).
        seg = offset_segment(seg, self._offset)
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
        sliced_path: str | None = None
        try:
            # 1. Pre-flight: audio duration. When a slice is requested we
            #    report the SELECTED duration so the UI's audio scrubber and
            #    progress percent line up with what the user is hearing.
            if job.start_s is not None or job.end_s is not None:
                full_dur = probe_duration_seconds(job.audio_path)
                start = job.start_s or 0.0
                end = job.end_s if job.end_s is not None else (full_dur or 0.0)
                job.audio_duration_s = max(0.0, end - start)
            else:
                job.audio_duration_s = probe_duration_seconds(job.audio_path)

            # 2. If a slice was requested, materialize it into a temp WAV up
            #    front. mlx_whisper sees a fresh file that starts at 0; the
            #    offset is added back to every timestamp before it leaves
            #    this module.
            transcribe_path = job.audio_path
            if job.start_s is not None or job.end_s is not None:
                sliced_path = self._make_slice(job.audio_path, job.start_s, job.end_s)
                transcribe_path = sliced_path

            # 3. Import lazily so server startup stays fast even if MLX isn't ready.
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
            # Mark the model as in-use so the idle unloader doesn't drop it
            # mid-transcription. Always paired with `end_use` via try/finally.
            from .model_lifecycle import get_default_lifecycle

            lifecycle = get_default_lifecycle()
            lifecycle.begin_use()
            try:
                # mlx_whisper -> huggingface_hub pushes tqdm download bars to
                # stderr; mlx_whisper's verbose segment output goes to stdout.
                # We need BOTH redirected to surface the new model_download UX
                # while keeping segment streaming working.
                with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
                    if job.cancel_flag.is_set():
                        raise InterruptedError("cancelled before start")
                    result = mlx_whisper.transcribe(transcribe_path, **kwargs)
            finally:
                lifecycle.end_use()
            stdout_capture.flush()
            stderr_capture.flush()
            elapsed = time.time() - start_t

            if job.cancel_flag.is_set():
                raise InterruptedError("cancelled during run")

            # mlx_whisper's own segment list is authoritative — replace our
            # stdout-parsed shadow copy with the real one. Apply the slice
            # offset so timestamps are absolute in the original file.
            real_segments = [
                offset_segment(
                    {
                        "start": float(s["start"]),
                        "end": float(s["end"]),
                        "text": s["text"].strip(),
                    },
                    self._offset,
                )
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
            # Cancelled either before start or after mlx_whisper returns.
            # We emit a distinct `cancelled` event (not `error`) so the
            # frontend can render this as a deliberate user action rather
            # than a failure.
            job.status = "cancelled"
            job.error = str(exc) or "cancelled"
            job.finished_at = time.time()
            job.publish(SseEvent(event="cancelled", data={"message": job.error}))
        except Exception as exc:
            logger.exception("transcription failed for job %s", job.id)
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"
            job.finished_at = time.time()
            job.publish(SseEvent(event="error", data={"message": job.error}))
        finally:
            # Best-effort cleanup of the sliced temp file. We deliberately
            # avoid NamedTemporaryFile's auto-delete (delete=True) because
            # ffmpeg writes to the path while we hold the handle elsewhere;
            # explicit unlink in finally guarantees it runs on cancel too.
            if sliced_path is not None:
                try:
                    os.unlink(sliced_path)
                except OSError:
                    logger.warning("failed to unlink sliced temp file %s", sliced_path)
            job.close_subscribers()

    def _make_slice(
        self, input_path: str, start_s: float | None, end_s: float | None
    ) -> str:
        """Run ffmpeg to write a sliced WAV to a temp path. Returns the path.

        Raises ``RuntimeError`` if ffmpeg is missing or exits non-zero — the
        caller's ``except Exception`` branch will mark the job as ``error``
        and surface the stderr tail.
        """
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError(
                "ffmpeg not found on PATH; required for slicing audio "
                "(start_s / end_s)."
            )
        # delete=False so the file survives the with-block; the caller's
        # finally cleans it up. suffix=.wav so ffmpeg's `-f wav` writes a
        # valid file the OS recognizes.
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        args = build_ffmpeg_slice_args(ffmpeg, input_path, tmp.name, start_s, end_s)
        proc = subprocess.run(args, capture_output=True, text=True)
        if proc.returncode != 0:
            # Bubble the last few stderr lines so the user can diagnose
            # "file not found", "invalid duration", etc.
            tail = "\n".join(proc.stderr.strip().splitlines()[-5:])
            raise RuntimeError(f"ffmpeg slice failed (rc={proc.returncode}): {tail}")
        return tmp.name
