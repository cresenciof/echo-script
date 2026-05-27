"""Detect which mlx-whisper models are already installed in the HuggingFace cache.

Cache layout (as of 2026):
    ~/.cache/huggingface/hub/
        models--{org}--{name}/
            snapshots/<commit-hash>/
                config.json
                weights.safetensors
                ...

Model id `mlx-community/whisper-large-v3-turbo` maps to directory
`models--mlx-community--whisper-large-v3-turbo`. To consider a model
"installed" we require AT LEAST one snapshot with a `config.json` file
present, so in-progress / corrupt downloads don't show up as ready.
"""

from __future__ import annotations

import os
from pathlib import Path


def hf_cache_root() -> Path:
    """Resolve the HuggingFace hub cache root respecting env overrides."""
    explicit = os.environ.get("HF_HOME")
    if explicit:
        return Path(explicit).expanduser() / "hub"
    legacy = os.environ.get("HUGGINGFACE_HUB_CACHE")
    if legacy:
        return Path(legacy).expanduser()
    return Path.home() / ".cache" / "huggingface" / "hub"


def installed_model_ids(root: Path | None = None) -> list[str]:
    """Return the list of fully-downloaded model ids found in the HF cache."""
    root = root or hf_cache_root()
    if not root.exists():
        return []

    found: list[str] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or not entry.name.startswith("models--"):
            continue
        snapshots_dir = entry / "snapshots"
        if not snapshots_dir.is_dir():
            continue
        ready = any(
            (snap / "config.json").exists() for snap in snapshots_dir.iterdir() if snap.is_dir()
        )
        if not ready:
            continue
        # `models--org--name` → `org/name`. Only the FIRST `--` separates org
        # from name; later `--` segments belong to the name (e.g. `large-v3-turbo`).
        stripped = entry.name.removeprefix("models--")
        org, _, name = stripped.partition("--")
        if not name:
            continue
        found.append(f"{org}/{name}")
    return found
