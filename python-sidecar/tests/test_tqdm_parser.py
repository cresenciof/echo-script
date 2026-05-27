"""Unit tests for the huggingface_hub tqdm progress parser."""

from whisper_sidecar.tqdm_parser import parse_hf_download, parse_size


def test_parse_size_human_readable() -> None:
    assert parse_size("532M") == 532_000_000
    assert parse_size("1.62G") == 1_620_000_000
    assert parse_size("103k") == 103_000
    assert parse_size("250B") == 250
    assert parse_size("1024") == 1024  # raw bytes — no unit suffix


def test_parse_size_invalid() -> None:
    assert parse_size("") == 0
    assert parse_size("abc") == 0
    assert parse_size("1.2X") == 0


def test_parse_hf_download_typical_line() -> None:
    line = "model.safetensors:  33%|███▎      | 532M/1.62G [00:14<00:30, 35.7MB/s]"
    out = parse_hf_download(line)
    assert out is not None
    assert out.filename == "model.safetensors"
    assert out.downloaded_bytes == 532_000_000
    assert out.total_bytes == 1_620_000_000
    assert out.percent == 33.0


def test_parse_hf_download_ascii_bar() -> None:
    # Older tqdm or non-UTF terminals fall back to ASCII fill characters.
    line = "tokenizer.json:  50%|#####     | 1.00M/2.00M [00:01<00:01, 1.0MB/s]"
    out = parse_hf_download(line)
    assert out is not None
    assert out.filename == "tokenizer.json"
    assert out.downloaded_bytes == 1_000_000
    assert out.total_bytes == 2_000_000
    assert out.percent == 50.0


def test_parse_hf_download_no_filename_prefix() -> None:
    # Some tqdm callers don't pass `desc`; the bar then has no label.
    line = "  75%|███████▌  | 1.5G/2.0G [00:30<00:10, 50.0MB/s]"
    out = parse_hf_download(line)
    assert out is not None
    assert out.filename == ""
    assert out.downloaded_bytes == 1_500_000_000
    assert out.total_bytes == 2_000_000_000
    assert out.percent == 75.0


def test_parse_hf_download_complete() -> None:
    line = "model.safetensors: 100%|██████████| 1.62G/1.62G [00:45<00:00, 36.0MB/s]"
    out = parse_hf_download(line)
    assert out is not None
    assert out.percent == 100.0
    assert out.downloaded_bytes == 1_620_000_000


def test_parse_hf_download_zero_total_dropped() -> None:
    # tqdm sometimes prints a 0/0 bar before the download actually starts.
    assert parse_hf_download("model.safetensors:   0%|          | 0/0 [00:00<?]") is None


def test_parse_hf_download_ignores_other_lines() -> None:
    assert parse_hf_download("") is None
    assert parse_hf_download("Fetching 4 files: 0%|") is None
    assert parse_hf_download("[00:00.000 --> 00:05.200]  Hello world") is None
    assert parse_hf_download("Some random log line") is None


def test_parse_hf_download_clamps_percent() -> None:
    # Defensive: percent capped at [0, 100] even if tqdm reports something odd.
    line = "x.bin: 105%|##########| 1G/1G [00:01<00:00, 1GB/s]"
    out = parse_hf_download(line)
    assert out is not None
    assert out.percent == 100.0
