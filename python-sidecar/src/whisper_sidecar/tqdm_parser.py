"""Parser for huggingface_hub download progress lines.

`huggingface_hub` writes tqdm progress bars to stderr while pulling a model
from the Hugging Face hub. A typical line looks like:

    model.safetensors:  33%|███▎      | 532M/1.62G [00:14<00:30, 35.7MB/s]

We tolerate the file prefix being absent (some tqdm callers don't set
``desc``) and we accept human-readable sizes (``"532M"``, ``"1.62G"``) as
well as raw byte counts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Capture groups:
#   file: optional leading filename label (e.g. "model.safetensors")
#   pct:  integer percentage shown by tqdm
#   dl:   downloaded amount, human readable (e.g. "532M", "1.62G", "103k")
#   tot:  total amount, same units
#
# The bar fill (between the pipes) and the trailing rate/ETA section are
# matched loosely so we don't break when tqdm's character set changes
# between locales or terminal widths.
TQDM_RE = re.compile(
    r"^(?:(?P<file>[\w./\-]+):\s+)?"
    r"(?P<pct>\d{1,3})%\|[^|]*\|\s+"
    r"(?P<dl>[\d.]+\s*[kKmMgGtTbB]?)/(?P<tot>[\d.]+\s*[kKmMgGtTbB]?)"
)

_UNIT_MULTIPLIERS: dict[str, int] = {
    "": 1,
    "B": 1,
    "K": 1_000,
    "KB": 1_000,
    "M": 1_000_000,
    "MB": 1_000_000,
    "G": 1_000_000_000,
    "GB": 1_000_000_000,
    "T": 1_000_000_000_000,
    "TB": 1_000_000_000_000,
}


@dataclass(frozen=True)
class ModelDownloadProgress:
    """Structured tqdm progress payload emitted to SSE subscribers."""

    filename: str
    downloaded_bytes: int
    total_bytes: int
    percent: float


def parse_size(s: str) -> int:
    """Parse a tqdm size token like ``"532M"`` or ``"1.62G"`` into bytes.

    Returns 0 when the token can't be parsed — we never want a malformed
    line to crash the worker thread.
    """
    if not s:
        return 0
    token = s.strip()
    # Strip a trailing "B" so "MB" / "GB" map cleanly through the multiplier
    # table even though tqdm usually emits the short form ("M", "G").
    unit = ""
    i = len(token)
    while i > 0 and not token[i - 1].isdigit() and token[i - 1] != ".":
        i -= 1
    number_part, unit_part = token[:i], token[i:].upper().strip()
    if not number_part:
        return 0
    try:
        value = float(number_part)
    except ValueError:
        return 0
    multiplier = _UNIT_MULTIPLIERS.get(unit_part)
    if multiplier is None:
        return 0
    return int(value * multiplier)


def parse_hf_download(line: str) -> ModelDownloadProgress | None:
    """Return progress if the line is a huggingface_hub tqdm bar; else None."""
    if not line:
        return None
    m = TQDM_RE.search(line.strip())
    if not m:
        return None
    filename = (m.group("file") or "").strip()
    try:
        pct = float(m.group("pct"))
    except ValueError:
        return None
    downloaded = parse_size(m.group("dl"))
    total = parse_size(m.group("tot"))
    # tqdm sometimes emits a 0/0 bar at startup. Drop those — they look
    # broken in the UI and provide no progress signal.
    if total <= 0:
        return None
    return ModelDownloadProgress(
        filename=filename,
        downloaded_bytes=downloaded,
        total_bytes=total,
        percent=max(0.0, min(100.0, pct)),
    )
