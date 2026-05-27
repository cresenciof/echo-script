"""Job state + registry + SSE fan-out primitives.

Jobs live in memory only. The registry keeps at most `history` finished
jobs (FIFO). Each job owns:

* A growing list of SSE events (so a late subscriber can replay everything
  that already happened).
* A list of `asyncio.Queue`s — one per active subscriber. The worker thread
  pushes new events through `loop.call_soon_threadsafe(queue.put_nowait, ev)`.
* A `threading.Event` cancel flag the worker polls between segments.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Literal

JobStatus = Literal["queued", "running", "done", "error", "cancelled"]


@dataclass
class SseEvent:
    event: str  # "progress" | "segment" | "done" | "error"
    data: dict[str, Any]


# Sentinel pushed to subscriber queues to signal "stream is over, hang up".
END_SENTINEL: SseEvent = SseEvent(event="__end__", data={})


@dataclass
class Job:
    id: str
    model: str
    language: str | None
    audio_path: str
    audio_duration_s: float | None = None
    status: JobStatus = "queued"
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    segments: list[dict[str, Any]] = field(default_factory=list)
    text: str = ""
    # Optional inclusive slice in seconds (relative to original file). When
    # both are None the worker transcribes the entire file (legacy fast path).
    start_s: float | None = None
    end_s: float | None = None

    # Replay buffer + live subscribers. Both guarded by `_lock` for the
    # thread-vs-event-loop boundary.
    events: list[SseEvent] = field(default_factory=list)
    subscribers: list[asyncio.Queue[SseEvent]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    cancel_flag: threading.Event = field(default_factory=threading.Event, repr=False)
    loop: asyncio.AbstractEventLoop | None = field(default=None, repr=False)

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def publish(self, event: SseEvent) -> None:
        """Called from the worker thread. Fans out an event to all subscribers."""
        with self._lock:
            self.events.append(event)
            queues = list(self.subscribers)
        loop = self.loop
        if loop is None:
            return
        for q in queues:
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except RuntimeError:
                # Loop is closed (process shutting down). Drop silently.
                continue

    def is_finished(self) -> bool:
        return self.status in ("done", "error", "cancelled")

    def subscribe(self) -> tuple[list[SseEvent], asyncio.Queue[SseEvent]]:
        """Return (replay, live_queue). Caller must drain replay then wait on queue."""
        q: asyncio.Queue[SseEvent] = asyncio.Queue()
        with self._lock:
            replay = list(self.events)
            if not self.is_finished():
                self.subscribers.append(q)
            else:
                # Already finished: caller will only walk the replay buffer and
                # we drop a sentinel so any wait on the queue resolves quickly.
                q.put_nowait(END_SENTINEL)
        return replay, q

    def unsubscribe(self, q: asyncio.Queue[SseEvent]) -> None:
        with self._lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def close_subscribers(self) -> None:
        """Push the end sentinel to every subscriber. Called once on job end."""
        with self._lock:
            queues = list(self.subscribers)
        loop = self.loop
        if loop is None:
            return
        for q in queues:
            try:
                loop.call_soon_threadsafe(q.put_nowait, END_SENTINEL)
            except RuntimeError:
                continue


class JobRegistry:
    """Thin wrapper around an OrderedDict that evicts the oldest finished jobs."""

    def __init__(self, history: int = 20) -> None:
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._history = history
        self._lock = threading.Lock()

    def create(
        self,
        *,
        model: str,
        language: str | None,
        audio_path: str,
        start_s: float | None = None,
        end_s: float | None = None,
    ) -> Job:
        job = Job(
            id=str(uuid.uuid4()),
            model=model,
            language=language,
            audio_path=audio_path,
            start_s=start_s,
            end_s=end_s,
        )
        job.started_at = time.time()
        with self._lock:
            self._jobs[job.id] = job
            self._evict_locked()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def remove(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.pop(job_id, None)

    def list_recent(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def _evict_locked(self) -> None:
        """Drop the oldest *finished* jobs until we're under the history cap.

        Running/queued jobs are never evicted — protects callers from losing
        in-flight work.
        """
        if len(self._jobs) <= self._history:
            return
        for key in list(self._jobs.keys()):
            if len(self._jobs) <= self._history:
                break
            if self._jobs[key].is_finished() and key != list(self._jobs.keys())[-1]:
                del self._jobs[key]
