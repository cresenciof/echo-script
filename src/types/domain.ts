/**
 * Domain types mirroring the FastAPI sidecar's pydantic schemas.
 * Kept independent so we never import Python types accidentally.
 */

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  model: string;
  language: string | null;
  audio_path: string;
  audio_duration_s: number | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  text: string;
}

export interface JobDetail extends JobSummary {
  segments: Segment[];
}

export interface ModelEntry {
  id: string;
  label: string;
  size_mb: number;
  recommended: boolean;
  description: string;
}

export interface ModelsResponse {
  available: ModelEntry[];
  installed: string[];
}

export interface HealthResponse {
  status: "ok";
  version: string;
}

export interface TranscribeRequest {
  audio_path: string;
  model: string;
  language?: string | null;
  initial_prompt?: string | null;
}

export interface TranscribeAccepted {
  job_id: string;
}

/* SSE event payloads. */
export interface ProgressEvent {
  current_s: number;
  total_s: number;
}
/**
 * The sidecar emits each segment as the bare Segment payload — no envelope.
 * Progress is reported separately via the `progress` event.
 */
export type SegmentEvent = Segment;
export interface DoneEvent {
  text: string;
  segments: Segment[];
  duration_s: number | null;
}
export interface ErrorEvent {
  message: string;
}

/**
 * UI-side job representation.
 * Mirrors JobDetail but adds client-only fields (originating filename,
 * local audio URL for the player, progress).
 */
export interface UIJob extends JobDetail {
  /** Display-friendly filename derived from audio_path. */
  filename: string;
  /** Local `blob:` or `file://` URL the audio player can load. */
  audio_url?: string;
  /** Seconds processed so far (from SSE progress). */
  current_s: number;
  /** Total seconds (= audio_duration_s when known, else 0). */
  total_s: number;
  /** Local timestamp (ms) when we observed status=running. */
  client_started_at: number | null;
}
