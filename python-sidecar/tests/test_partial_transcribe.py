"""Unit tests for the partial-transcribe slice feature.

Covers three layers without invoking ffmpeg or mlx_whisper:
  * Request validation (pydantic boundary).
  * The ffmpeg argv builder.
  * The timestamp offset helper.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from whisper_sidecar.models import TranscribeRequest
from whisper_sidecar.transcriber import build_ffmpeg_slice_args, offset_segment


# -- Validation ---------------------------------------------------------------


def test_request_accepts_no_slice() -> None:
    req = TranscribeRequest(audio_path="/tmp/a.wav")
    assert req.start_s is None
    assert req.end_s is None


def test_request_accepts_valid_range() -> None:
    req = TranscribeRequest(audio_path="/tmp/a.wav", start_s=1.0, end_s=2.5)
    assert req.start_s == 1.0
    assert req.end_s == 2.5


def test_request_rejects_end_before_start() -> None:
    with pytest.raises(ValidationError):
        TranscribeRequest(audio_path="/tmp/a.wav", start_s=10.0, end_s=5.0)


def test_request_rejects_end_equal_start() -> None:
    # An empty slice is meaningless — reject it so the worker doesn't have to.
    with pytest.raises(ValidationError):
        TranscribeRequest(audio_path="/tmp/a.wav", start_s=5.0, end_s=5.0)


def test_request_rejects_negative_start() -> None:
    with pytest.raises(ValidationError):
        TranscribeRequest(audio_path="/tmp/a.wav", start_s=-1.0)


def test_request_accepts_only_start() -> None:
    req = TranscribeRequest(audio_path="/tmp/a.wav", start_s=10.0)
    assert req.start_s == 10.0
    assert req.end_s is None


def test_request_accepts_only_end() -> None:
    req = TranscribeRequest(audio_path="/tmp/a.wav", end_s=30.0)
    assert req.start_s is None
    assert req.end_s == 30.0


# -- ffmpeg argv builder ------------------------------------------------------


def test_argv_full_range() -> None:
    args = build_ffmpeg_slice_args("/usr/bin/ffmpeg", "/in.mp3", "/out.wav", 10.0, 20.0)
    # -ss BEFORE -i for fast seek; -to BEFORE -i too so it stays absolute.
    assert "-ss" in args
    assert args[args.index("-ss") + 1] == "10"
    assert "-to" in args
    assert args[args.index("-to") + 1] == "20"
    # Standard mlx_whisper-friendly output options must be present.
    assert "-vn" in args
    assert "-ac" in args and args[args.index("-ac") + 1] == "1"
    assert "-ar" in args and args[args.index("-ar") + 1] == "16000"
    assert "-f" in args and args[args.index("-f") + 1] == "wav"
    assert args[0] == "/usr/bin/ffmpeg"
    assert args[-1] == "/out.wav"


def test_argv_only_end() -> None:
    args = build_ffmpeg_slice_args("ffmpeg", "/in.wav", "/out.wav", None, 20.0)
    assert "-ss" not in args
    assert "-to" in args
    assert args[args.index("-to") + 1] == "20"


def test_argv_only_start() -> None:
    args = build_ffmpeg_slice_args("ffmpeg", "/in.wav", "/out.wav", 10.0, None)
    assert "-ss" in args
    assert args[args.index("-ss") + 1] == "10"
    assert "-to" not in args


def test_argv_none_returns_empty() -> None:
    # Callers MUST skip ffmpeg entirely when no slice is requested. The empty
    # return is the signal to take the fast path.
    assert build_ffmpeg_slice_args("ffmpeg", "/in.wav", "/out.wav", None, None) == []


def test_argv_fractional_seconds_keeps_precision() -> None:
    args = build_ffmpeg_slice_args("ffmpeg", "/in.wav", "/out.wav", 0.5, 1.25)
    assert args[args.index("-ss") + 1] == "0.5"
    assert args[args.index("-to") + 1] == "1.25"


# -- Timestamp offset ---------------------------------------------------------


def test_offset_segment_shifts_both_endpoints() -> None:
    out = offset_segment({"start": 0.5, "end": 2.0, "text": "hi"}, 300.0)
    assert out == {"start": 300.5, "end": 302.0, "text": "hi"}


def test_offset_segment_zero_is_identity() -> None:
    seg = {"start": 1.0, "end": 2.0, "text": "x"}
    out = offset_segment(seg, 0.0)
    assert out == seg
    # Must return a copy, not the original (caller may mutate freely).
    assert out is not seg


def test_offset_segment_preserves_extra_fields() -> None:
    # Future-proofing: mlx_whisper sometimes emits extra keys (id, tokens,
    # avg_logprob, etc.). The helper should leave them alone.
    seg = {"start": 0.0, "end": 1.0, "text": "x", "id": 7, "avg_logprob": -0.1}
    out = offset_segment(seg, 10.0)
    assert out["id"] == 7
    assert out["avg_logprob"] == -0.1
    assert out["start"] == 10.0
    assert out["end"] == 11.0
