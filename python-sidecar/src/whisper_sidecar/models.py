"""Pydantic request/response schemas for the HTTP layer."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


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
    start_s: float | None = Field(
        default=None,
        description=(
            "Inclusive range in seconds. None means start at 0 / end at end of file. "
            "Both None means transcribe the entire file (default)."
        ),
    )
    end_s: float | None = Field(
        default=None,
        description=(
            "Inclusive range in seconds. None means start at 0 / end at end of file. "
            "Both None means transcribe the entire file (default)."
        ),
    )

    @model_validator(mode="after")
    def _validate_range(self) -> "TranscribeRequest":
        # Enforce semantics for the optional slice. We do NOT default the
        # missing endpoint here — the worker resolves "None means end of file"
        # against the actual ffprobed duration. We only reject obviously
        # incoherent inputs at the API boundary.
        if self.start_s is not None and self.start_s < 0:
            raise ValueError("start_s must be >= 0")
        if self.end_s is not None and self.end_s < 0:
            raise ValueError("end_s must be >= 0")
        if (
            self.start_s is not None
            and self.end_s is not None
            and self.end_s <= self.start_s
        ):
            raise ValueError("end_s must be greater than start_s")
        return self


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
    start_s: float | None = None
    end_s: float | None = None


class JobDetail(JobSummary):
    segments: list[Segment]


class JobsListResponse(BaseModel):
    jobs: list[JobSummary]


class ErrorEnvelope(BaseModel):
    detail: str
    extra: dict[str, Any] | None = None
