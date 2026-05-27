"""Pydantic request/response schemas for the HTTP layer."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    version: str


class ModelEntry(BaseModel):
    id: str
    label: str
    size_mb: int
    recommended: bool = False
    description: str = ""


class ModelsResponse(BaseModel):
    available: list[ModelEntry]
    installed: list[str]


class TranscribeRequest(BaseModel):
    audio_path: str = Field(..., description="Absolute path to an audio file on disk.")
    model: str = Field(
        default="mlx-community/whisper-large-v3-turbo",
        description="HuggingFace repo id of an mlx-whisper compatible model.",
    )
    language: str | None = Field(
        default=None,
        description="ISO-639-1 language code, e.g. 'es' or 'en'. None = auto-detect.",
    )
    initial_prompt: str | None = Field(
        default=None,
        description="Optional seed prompt to bias the decoder.",
    )


class TranscribeAccepted(BaseModel):
    job_id: str


class Segment(BaseModel):
    start: float
    end: float
    text: str


class JobSummary(BaseModel):
    id: str
    status: Literal["queued", "running", "done", "error", "cancelled"]
    model: str
    language: str | None
    audio_path: str
    audio_duration_s: float | None
    started_at: float | None
    finished_at: float | None
    error: str | None
    text: str


class JobDetail(JobSummary):
    segments: list[Segment]


class JobsListResponse(BaseModel):
    jobs: list[JobSummary]


class ErrorEnvelope(BaseModel):
    detail: str
    extra: dict[str, Any] | None = None
