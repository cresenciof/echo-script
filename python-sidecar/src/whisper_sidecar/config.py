"""Static configuration and the model catalog exposed via `GET /models`."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings. CLI flags / env vars override defaults."""

    host: str = "127.0.0.1"
    port: int = 0  # 0 = pick a free port at bind time
    log_level: str = "info"
    job_history: int = 20  # how many finished jobs to retain in memory
    # Free the loaded Whisper model after this many seconds without a
    # transcribe call. Set to 0 to disable. The next transcription pays
    # ~2-5s of cold-start latency to reload from the HF cache.
    model_idle_unload_s: float = 300.0
    # How often the background unloader checks for idleness.
    model_idle_check_interval_s: float = 30.0

    model_config = SettingsConfigDict(
        env_prefix="WHISPER_SIDECAR_",
        case_sensitive=False,
    )


# Hardcoded catalog the frontend uses to render a model picker.
MODELS: list[dict] = [
    {
        "id": "mlx-community/whisper-large-v3-mlx-4bit",
        "label": "Large v3 (4-bit)",
        "size_mb": 800,
        "recommended": True,
        "description": "Recommended. ~95% the quality of v3 Turbo with ~1 GB RAM instead of ~3 GB.",
    },
    {
        "id": "mlx-community/whisper-large-v3-turbo",
        "label": "Large v3 Turbo",
        "size_mb": 1620,
        "recommended": False,
        "description": "Higher quality on noisy / accented audio. ~3 GB RAM.",
    },
    {
        "id": "mlx-community/whisper-large-v3-mlx",
        "label": "Large v3",
        "size_mb": 3100,
        "recommended": False,
        "description": "Maximum quality, slower, ~4+ GB RAM.",
    },
    {
        "id": "mlx-community/whisper-medium-mlx",
        "label": "Medium",
        "size_mb": 1500,
        "recommended": False,
        "description": "Balanced.",
    },
    {
        "id": "mlx-community/whisper-small-mlx",
        "label": "Small",
        "size_mb": 480,
        "recommended": False,
        "description": "Fast, audio must be clean.",
    },
]
