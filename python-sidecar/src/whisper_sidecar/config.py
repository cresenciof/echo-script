"""Static configuration and the model catalog exposed via `GET /models`."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings. CLI flags / env vars override defaults."""

    host: str = "127.0.0.1"
    port: int = 0  # 0 = pick a free port at bind time
    log_level: str = "info"
    job_history: int = 20  # how many finished jobs to retain in memory

    model_config = SettingsConfigDict(
        env_prefix="WHISPER_SIDECAR_",
        case_sensitive=False,
    )


# Hardcoded catalog the frontend uses to render a model picker.
MODELS: list[dict] = [
    {
        "id": "mlx-community/whisper-large-v3-turbo",
        "label": "Large v3 Turbo",
        "size_mb": 1620,
        "recommended": True,
        "description": "Best speed/quality balance. Recommended.",
    },
    {
        "id": "mlx-community/whisper-large-v3-mlx",
        "label": "Large v3",
        "size_mb": 3100,
        "recommended": False,
        "description": "Maximum quality, slower, more RAM.",
    },
    {
        "id": "mlx-community/whisper-large-v3-mlx-4bit",
        "label": "Large v3 (4-bit)",
        "size_mb": 800,
        "recommended": False,
        "description": "Quantized. Good for low-RAM Macs.",
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
