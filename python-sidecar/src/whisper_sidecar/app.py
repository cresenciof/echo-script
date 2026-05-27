"""FastAPI app, routes, and SSE wiring."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from . import __version__
from .config import MODELS, Settings
from .hf_cache import installed_model_ids
from .jobs import END_SENTINEL, Job, JobRegistry, SseEvent
from .models import (
    HealthResponse,
    JobDetail,
    JobsListResponse,
    JobSummary,
    ModelEntry,
    ModelsResponse,
    Segment,
    TranscribeAccepted,
    TranscribeRequest,
)
from .transcriber import TranscriptionWorker

logger = logging.getLogger(__name__)


def _job_to_summary(job: Job) -> JobSummary:
    return JobSummary(
        id=job.id,
        status=job.status,
        model=job.model,
        language=job.language,
        audio_path=job.audio_path,
        audio_duration_s=job.audio_duration_s,
        started_at=job.started_at,
        finished_at=job.finished_at,
        error=job.error,
        text=job.text,
        start_s=job.start_s,
        end_s=job.end_s,
    )


def _job_to_detail(job: Job) -> JobDetail:
    return JobDetail(
        **_job_to_summary(job).model_dump(),
        segments=[Segment(**s) for s in job.segments],
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    registry = JobRegistry(history=settings.job_history)

    # Install a lifecycle tuned to the Settings — replaces the default
    # singleton used by transcriber.py. Saves ~2-3 GB of RAM by dropping
    # the cached mlx_whisper model after a quiet period.
    from .model_lifecycle import ModelLifecycle, run_idle_unloader, set_default_lifecycle

    lifecycle = ModelLifecycle(idle_seconds=settings.model_idle_unload_s)
    set_default_lifecycle(lifecycle)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        loop = asyncio.get_running_loop()
        _app.state.loop = loop
        _app.state.registry = registry
        _app.state.settings = settings
        _app.state.model_lifecycle = lifecycle
        # Background unloader. Disabled at idle_seconds <= 0.
        unloader_task: asyncio.Task | None = None
        if settings.model_idle_unload_s > 0:
            unloader_task = asyncio.create_task(
                run_idle_unloader(
                    lifecycle,
                    interval_seconds=settings.model_idle_check_interval_s,
                ),
                name="model-idle-unloader",
            )
        logger.info("whisper-sidecar v%s ready", __version__)
        try:
            yield
        finally:
            # Best-effort: signal cancel to all running jobs.
            for job in registry.list_recent():
                if not job.is_finished():
                    job.cancel_flag.set()
                    job.close_subscribers()
            if unloader_task is not None:
                unloader_task.cancel()
                try:
                    await unloader_task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    app = FastAPI(
        title="Whisper Sidecar",
        version=__version__,
        lifespan=lifespan,
    )

    # Tauri uses several origins depending on platform + dev/prod.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "tauri://localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
        ],
        allow_origin_regex=r"^(tauri://|https://tauri\.localhost|http://(localhost|127\.0\.0\.1):\d+)$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(version=__version__)

    @app.get("/models", response_model=ModelsResponse)
    async def models_endpoint() -> ModelsResponse:
        installed = installed_model_ids()
        catalog_ids = {m["id"] for m in MODELS}
        # Surface ALL installed models even if not in the curated catalog —
        # the user might have pulled a custom one manually.
        installed_visible = [mid for mid in installed if mid in catalog_ids or mid.startswith("mlx-community/")]
        return ModelsResponse(
            available=[ModelEntry(**m) for m in MODELS],
            installed=installed_visible,
        )

    @app.post("/transcribe", response_model=TranscribeAccepted)
    async def transcribe(req: TranscribeRequest, request: Request) -> TranscribeAccepted:
        if not os.path.isabs(req.audio_path):
            raise HTTPException(status_code=400, detail="audio_path must be absolute")
        if not os.path.isfile(req.audio_path):
            raise HTTPException(status_code=400, detail=f"audio file not found: {req.audio_path}")

        job = registry.create(
            model=req.model,
            language=req.language,
            audio_path=req.audio_path,
            start_s=req.start_s,
            end_s=req.end_s,
        )
        job.attach_loop(request.app.state.loop)
        worker = TranscriptionWorker(registry, job, initial_prompt=req.initial_prompt)
        worker.start()
        return TranscribeAccepted(job_id=job.id)

    @app.get("/jobs", response_model=JobsListResponse)
    async def list_jobs() -> JobsListResponse:
        return JobsListResponse(jobs=[_job_to_summary(j) for j in registry.list_recent()])

    @app.get("/jobs/{job_id}", response_model=JobDetail)
    async def get_job(job_id: str) -> JobDetail:
        job = registry.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        return _job_to_detail(job)

    @app.post("/jobs/{job_id}/cancel", response_model=JobSummary)
    async def cancel_job(job_id: str) -> JobSummary:
        """Logical cancel: sets the worker's cancel_flag and marks the job
        as `cancelled`. The mlx_whisper call may still run to completion
        internally — the worker discards its result. We KEEP the job in
        the registry so the user can still see whatever segments arrived
        before the cancel.
        """
        job = registry.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        if job.is_finished():
            # Idempotent: cancelling a finished job is a no-op.
            return _job_to_summary(job)
        job.cancel_flag.set()
        # Mark status optimistically. The worker's InterruptedError handler
        # will also set this when mlx_whisper returns, but we don't want to
        # wait for that — the user clicked cancel, the UI shows cancelled
        # now.
        job.status = "cancelled"
        job.publish(SseEvent(event="cancelled", data={"message": "cancelled by user"}))
        # Don't close subscribers yet — let the worker emit its final
        # cancelled event when mlx_whisper returns so any SSE replay logic
        # stays consistent.
        return _job_to_summary(job)

    @app.delete("/jobs/{job_id}", status_code=204)
    async def delete_job(job_id: str) -> Response:
        """Destructive remove: cancels (if running) AND drops the job from
        the in-memory registry. For "cancel but keep result" use
        POST /jobs/{id}/cancel.
        """
        job = registry.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        if not job.is_finished():
            job.cancel_flag.set()
            # Don't block waiting for the thread — it polls cancel_flag.
        registry.remove(job_id)
        job.close_subscribers()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get("/jobs/{job_id}/stream")
    async def stream_job(job_id: str, request: Request) -> EventSourceResponse:
        job = registry.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")

        replay, queue = job.subscribe()

        async def event_generator() -> AsyncIterator[dict]:
            try:
                # Replay everything that already happened, in order.
                for ev in replay:
                    if ev is END_SENTINEL:
                        continue
                    yield {"event": ev.event, "data": json.dumps(ev.data)}
                # If the job finished before we subscribed, emit a synthetic
                # `done`/`error` if there wasn't one in the replay so clients
                # always see a terminal event.
                if job.is_finished() and not any(
                    e.event in ("done", "error") for e in replay
                ):
                    if job.status == "done":
                        yield {
                            "event": "done",
                            "data": json.dumps(
                                {
                                    "text": job.text,
                                    "segments": job.segments,
                                    "duration_s": job.audio_duration_s,
                                }
                            ),
                        }
                    else:
                        yield {
                            "event": "error",
                            "data": json.dumps({"message": job.error or job.status}),
                        }
                    return

                # Live tail.
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(queue.get(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    if ev is END_SENTINEL:
                        break
                    yield {"event": ev.event, "data": json.dumps(ev.data)}
                    if ev.event in ("done", "error"):
                        break
            finally:
                job.unsubscribe(queue)

        return EventSourceResponse(event_generator())

    return app
