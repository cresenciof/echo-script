"""Idle-based unloader for the cached mlx_whisper model.

`mlx_whisper.transcribe(...)` lazily loads the Whisper model into
`mlx_whisper.transcribe.ModelHolder.model` and never frees it. On Apple
Silicon's unified memory that's 1-3 GB sitting around long after the
user's last transcription. This module tracks idleness and lets a
background asyncio task release the model + clear the MLX metal cache.

Trade-off: the next transcribe after an unload pays ~2-5 s of cold start
to reload from `~/.cache/huggingface/hub`. Configurable via
`Settings.model_idle_unload_s` (0 disables).
"""

from __future__ import annotations

import asyncio
import gc
import logging
import time
from typing import Optional

log = logging.getLogger(__name__)


class ModelLifecycle:
    """Tracks when the cached mlx_whisper model was last touched and
    unloads it after `idle_seconds` of inactivity, provided no
    transcription is currently in flight.

    Thread- and asyncio-safe: `begin_use` / `end_use` are called from
    the worker thread; `unload_if_idle` runs on the asyncio loop. The
    in-flight counter and last-used timestamp are simple int/float
    primitives whose atomicity is sufficient for CPython.
    """

    def __init__(self, idle_seconds: float = 300.0) -> None:
        self.idle_seconds = idle_seconds
        self._last_used: Optional[float] = None
        self._in_flight: int = 0
        self._lock = asyncio.Lock()

    # ---- usage tracking (called from worker thread) ----

    def begin_use(self) -> None:
        self._in_flight += 1
        self._last_used = time.monotonic()

    def end_use(self) -> None:
        self._in_flight = max(0, self._in_flight - 1)
        self._last_used = time.monotonic()

    # ---- introspection ----

    def is_busy(self) -> bool:
        return self._in_flight > 0

    def seconds_since_last_use(self) -> Optional[float]:
        if self._last_used is None:
            return None
        return time.monotonic() - self._last_used

    def is_idle(self) -> bool:
        if self.idle_seconds <= 0:
            return False
        if self._last_used is None:
            return False
        if self.is_busy():
            return False
        return self.seconds_since_last_use() >= self.idle_seconds  # type: ignore[operator]

    def model_is_loaded(self) -> bool:
        try:
            from mlx_whisper import transcribe as _t  # type: ignore[import-untyped]

            holder = getattr(_t, "ModelHolder", None)
            return holder is not None and getattr(holder, "model", None) is not None
        except Exception:
            return False

    # ---- unload ----

    async def unload_if_idle(self) -> bool:
        """If conditions are met, drop the cached model and clear the
        MLX cache. Returns True iff it actually unloaded."""
        if not self.is_idle() or not self.model_is_loaded():
            return False
        async with self._lock:
            # Re-check after acquiring the lock.
            if not self.is_idle() or not self.model_is_loaded():
                return False
            return self._unload()

    def _unload(self) -> bool:
        try:
            from mlx_whisper import transcribe as _t  # type: ignore[import-untyped]

            holder = getattr(_t, "ModelHolder", None)
            if holder is None:
                return False
            holder.model = None  # type: ignore[attr-defined]
        except Exception:
            log.exception("failed to clear mlx_whisper ModelHolder.model")
            return False

        # Clear the MLX metal allocator's cached buffers so the RAM
        # actually goes back to the OS, not just to MLX's pool.
        try:
            import mlx.core as mx  # type: ignore[import-untyped]

            metal = getattr(mx, "metal", None)
            if metal is not None and hasattr(metal, "clear_cache"):
                metal.clear_cache()
        except Exception:
            # MLX metal API has shifted in the past; failing here isn't
            # critical — the Python-side ref is already gone.
            log.debug("mlx.metal.clear_cache unavailable", exc_info=True)

        gc.collect()
        self._last_used = None
        log.info(
            "model unloaded after %.0fs idle (in_flight=%d)",
            self.idle_seconds,
            self._in_flight,
        )
        return True


async def run_idle_unloader(
    lifecycle: ModelLifecycle,
    interval_seconds: float = 30.0,
) -> None:
    """Long-running task: periodically asks the lifecycle to unload
    when idle. Cancellation-safe: `asyncio.sleep` is the only blocking
    point, and `unload_if_idle` swallows its own errors."""
    if lifecycle.idle_seconds <= 0:
        log.info("idle unloader disabled (model_idle_unload_s=0)")
        return

    log.info(
        "idle unloader armed: interval=%.0fs threshold=%.0fs",
        interval_seconds,
        lifecycle.idle_seconds,
    )
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await lifecycle.unload_if_idle()
        except asyncio.CancelledError:
            log.info("idle unloader stopped")
            raise
        except Exception:
            log.exception("idle unloader tick failed; continuing")


# Module-level singleton — created lazily so tests can inject their own.
_default: Optional[ModelLifecycle] = None


def get_default_lifecycle() -> ModelLifecycle:
    global _default
    if _default is None:
        _default = ModelLifecycle()
    return _default


def set_default_lifecycle(lifecycle: ModelLifecycle) -> None:
    """Used by app startup to override the singleton with one built from
    Settings, and by tests to inject mocks."""
    global _default
    _default = lifecycle
