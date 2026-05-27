"""Unit tests for ModelLifecycle — idle-based model unloader."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock, patch

import pytest

from whisper_sidecar.model_lifecycle import ModelLifecycle, run_idle_unloader


def _fake_loaded_holder(loaded: bool = True):
    """Return a context manager that swaps mlx_whisper.transcribe.ModelHolder
    out for a fake whose `model` is set/unset to simulate cache state."""

    class Holder:
        model = object() if loaded else None

    fake = MagicMock()
    fake.ModelHolder = Holder
    return patch.dict("sys.modules", {"mlx_whisper": MagicMock(transcribe=fake)}), Holder


def test_starts_not_idle() -> None:
    lc = ModelLifecycle(idle_seconds=60)
    assert lc.is_idle() is False
    assert lc.is_busy() is False
    assert lc.seconds_since_last_use() is None


def test_begin_end_use_tracks_counter_and_timestamp() -> None:
    lc = ModelLifecycle(idle_seconds=60)
    lc.begin_use()
    assert lc.is_busy() is True
    assert lc.seconds_since_last_use() is not None
    lc.end_use()
    assert lc.is_busy() is False


def test_end_use_does_not_go_negative() -> None:
    lc = ModelLifecycle(idle_seconds=60)
    lc.end_use()
    lc.end_use()
    assert lc.is_busy() is False


def test_is_idle_only_when_threshold_passed() -> None:
    lc = ModelLifecycle(idle_seconds=0.05)
    lc.begin_use()
    lc.end_use()
    assert lc.is_idle() is False  # just used
    time.sleep(0.06)
    assert lc.is_idle() is True


def test_is_idle_returns_false_while_in_flight() -> None:
    lc = ModelLifecycle(idle_seconds=0.01)
    lc.begin_use()
    time.sleep(0.02)
    # Even though wall-clock idle threshold passed, in-flight blocks unload.
    assert lc.is_idle() is False
    lc.end_use()
    time.sleep(0.02)
    assert lc.is_idle() is True


def test_zero_idle_seconds_disables() -> None:
    lc = ModelLifecycle(idle_seconds=0)
    lc.begin_use()
    lc.end_use()
    time.sleep(0.01)
    assert lc.is_idle() is False


@pytest.mark.asyncio
async def test_unload_if_idle_noop_when_busy() -> None:
    lc = ModelLifecycle(idle_seconds=0.01)
    lc.begin_use()
    await asyncio.sleep(0.02)
    assert await lc.unload_if_idle() is False


@pytest.mark.asyncio
async def test_unload_if_idle_noop_when_no_model_loaded() -> None:
    lc = ModelLifecycle(idle_seconds=0.01)
    lc.begin_use()
    lc.end_use()
    await asyncio.sleep(0.02)
    # is_idle is True but model_is_loaded should be False without setup.
    # Force the introspection to say "not loaded".
    with patch.object(lc, "model_is_loaded", return_value=False):
        assert await lc.unload_if_idle() is False


@pytest.mark.asyncio
async def test_run_idle_unloader_disabled_returns_immediately() -> None:
    lc = ModelLifecycle(idle_seconds=0)
    # Should return without spinning forever.
    await asyncio.wait_for(run_idle_unloader(lc, interval_seconds=0.01), timeout=1)


@pytest.mark.asyncio
async def test_run_idle_unloader_cancellable() -> None:
    lc = ModelLifecycle(idle_seconds=60)  # never naturally idle in the test
    task = asyncio.create_task(run_idle_unloader(lc, interval_seconds=0.01))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
