"""Audio duration detection.

Tries `ffprobe` first (fast, no decoding). Falls back to
`mlx_whisper.audio.load_audio` which decodes the whole file via ffmpeg.
"""

from __future__ import annotations

import json
import shutil
import subprocess


def probe_duration_seconds(path: str) -> float | None:
    """Return the duration of `path` in seconds, or None if undetermined."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            out = subprocess.run(
                [
                    ffprobe,
                    "-v",
                    "quiet",
                    "-print_format",
                    "json",
                    "-show_format",
                    path,
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            data = json.loads(out.stdout)
            duration = data.get("format", {}).get("duration")
            if duration is not None:
                return float(duration)
        except (subprocess.SubprocessError, ValueError, json.JSONDecodeError):
            pass

    # Fallback: ask mlx_whisper to decode and divide by sample rate (16 kHz).
    try:
        from mlx_whisper import audio as mlx_audio  # type: ignore[import-untyped]

        samples = mlx_audio.load_audio(path)
        return float(len(samples)) / float(mlx_audio.SAMPLE_RATE)
    except Exception:
        return None
