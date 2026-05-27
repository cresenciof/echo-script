"""Verify the regex that parses mlx_whisper's verbose stdout."""

from whisper_sidecar.transcriber import parse_segment_line


def test_parses_standard_line() -> None:
    out = parse_segment_line("[00:00.000 --> 00:05.200]  Hello world")
    assert out == {"start": 0.0, "end": 5.2, "text": "Hello world"}


def test_parses_with_minutes() -> None:
    out = parse_segment_line("[01:23.456 --> 02:04.789] Algo en español")
    assert out is not None
    assert out["start"] == 60 + 23 + 0.456
    assert abs(out["end"] - (120 + 4 + 0.789)) < 1e-9
    assert out["text"] == "Algo en español"


def test_ignores_tqdm_lines() -> None:
    assert parse_segment_line("100%|##########| 4/4 [00:00<00:00, 62368.83it/s]") is None
    assert parse_segment_line("") is None
    assert parse_segment_line("Fetching 4 files: 0%|") is None


def test_ignores_partial_line() -> None:
    assert parse_segment_line("[00:00.000 --> ") is None


def test_strips_leading_space_in_text() -> None:
    out = parse_segment_line("[00:00.000 --> 00:01.000]   leading and trailing   ")
    assert out is not None
    assert out["text"] == "leading and trailing"
