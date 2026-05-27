"""Job registry + pub/sub fan-out tests (no mlx_whisper involved)."""

from __future__ import annotations

import asyncio

import pytest

from whisper_sidecar.jobs import END_SENTINEL, JobRegistry, SseEvent


def _new_job(reg: JobRegistry):
    return reg.create(model="m", language="es", audio_path="/tmp/x.wav")


def test_registry_create_and_get() -> None:
    reg = JobRegistry()
    job = _new_job(reg)
    assert reg.get(job.id) is job
    assert job.status == "queued"


def test_registry_remove() -> None:
    reg = JobRegistry()
    job = _new_job(reg)
    assert reg.remove(job.id) is job
    assert reg.get(job.id) is None


def test_registry_history_evicts_finished_only() -> None:
    reg = JobRegistry(history=2)
    a = _new_job(reg)
    a.status = "done"
    b = _new_job(reg)
    b.status = "done"
    c = _new_job(reg)  # would evict the oldest done job
    ids = [j.id for j in reg.list_recent()]
    assert a.id not in ids  # evicted
    assert b.id in ids
    assert c.id in ids


@pytest.mark.asyncio
async def test_subscribe_replays_and_then_streams() -> None:
    reg = JobRegistry()
    job = _new_job(reg)
    job.attach_loop(asyncio.get_running_loop())

    # Pre-existing events on the job.
    job.events.append(SseEvent(event="progress", data={"percent": 10}))

    replay, q = job.subscribe()
    assert len(replay) == 1
    assert replay[0].event == "progress"

    # New event published from "another thread" → fans out to subscriber.
    job.publish(SseEvent(event="segment", data={"start": 0, "end": 1, "text": "hi"}))

    ev = await asyncio.wait_for(q.get(), timeout=1.0)
    assert ev.event == "segment"


@pytest.mark.asyncio
async def test_finished_job_gets_end_sentinel_immediately() -> None:
    reg = JobRegistry()
    job = _new_job(reg)
    job.attach_loop(asyncio.get_running_loop())
    job.status = "done"
    job.text = "done"

    replay, q = job.subscribe()
    # End sentinel should be queued right away for finished jobs.
    ev = await asyncio.wait_for(q.get(), timeout=1.0)
    assert ev is END_SENTINEL
    assert replay == []
