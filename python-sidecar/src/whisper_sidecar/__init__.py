"""Whisper Sidecar — FastAPI app that runs mlx-whisper for the Tauri frontend."""

__version__ = "0.1.0"


def main() -> None:
    """Console-script entrypoint (`whisper-sidecar`). Delegates to __main__."""
    from .__main__ import run

    run()
