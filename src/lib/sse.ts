/**
 * Server-Sent Events subscription for a transcription job.
 * Routes the four event types emitted by the sidecar to typed handlers.
 */
import { sidecarUrl } from "./sidecar";
import type {
  DoneEvent,
  ErrorEvent as JobErrorEvent,
  ModelDownloadEvent,
  ProgressEvent,
  SegmentEvent,
} from "@/types/domain";

export interface JobStreamHandlers {
  onProgress?: (e: ProgressEvent) => void;
  onSegment?: (e: SegmentEvent) => void;
  onDone?: (e: DoneEvent) => void;
  onError?: (e: JobErrorEvent) => void;
  /** Distinct from onError — emitted when a job is cancelled by the user. */
  onCancelled?: (e: { message: string }) => void;
  /** Fires while huggingface_hub is downloading the model on first use. */
  onModelDownload?: (e: ModelDownloadEvent) => void;
  /** Fires when the EventSource itself errors (connection loss). */
  onConnectionError?: (err: Event) => void;
}

/**
 * Subscribe to `GET /jobs/:id/stream`. Returns a cleanup function that
 * closes the EventSource. Idempotent — calling cleanup multiple times is safe.
 */
export function subscribeToJob(
  jobId: string,
  handlers: JobStreamHandlers,
): () => void {
  const url = sidecarUrl(`/jobs/${encodeURIComponent(jobId)}/stream`);
  const source = new EventSource(url);

  const parse = <T,>(raw: MessageEvent): T | null => {
    try {
      return JSON.parse(raw.data) as T;
    } catch {
      return null;
    }
  };

  if (handlers.onProgress) {
    source.addEventListener("progress", (raw: MessageEvent) => {
      const data = parse<ProgressEvent>(raw);
      if (data) handlers.onProgress?.(data);
    });
  }
  if (handlers.onSegment) {
    source.addEventListener("segment", (raw: MessageEvent) => {
      const data = parse<SegmentEvent>(raw);
      if (data) handlers.onSegment?.(data);
    });
  }
  if (handlers.onDone) {
    source.addEventListener("done", (raw: MessageEvent) => {
      const data = parse<DoneEvent>(raw);
      if (data) handlers.onDone?.(data);
    });
  }
  if (handlers.onModelDownload) {
    source.addEventListener("model_download", (raw: MessageEvent) => {
      const data = parse<ModelDownloadEvent>(raw);
      if (data) handlers.onModelDownload?.(data);
    });
  }
  if (handlers.onCancelled) {
    source.addEventListener("cancelled", (raw: MessageEvent) => {
      const data = parse<{ message: string }>(raw);
      if (data) handlers.onCancelled?.(data);
    });
  }
  if (handlers.onError) {
    source.addEventListener("error", (raw: Event) => {
      // The default "error" stream from EventSource is just an Event.
      // Sidecar `error` server-event has data, so we can distinguish.
      if (raw instanceof MessageEvent) {
        const data = parse<JobErrorEvent>(raw);
        if (data) handlers.onError?.(data);
      }
    });
  }

  source.onerror = (err) => {
    // EventSource auto-reconnects on transport errors. We only forward.
    handlers.onConnectionError?.(err);
  };

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    source.close();
  };
}
