/**
 * High-level transcription orchestrator.
 *
 * Given an audio path + model, starts a job on the sidecar, wires up the
 * SSE stream, and reflects every update into useJobsStore. Returns the
 * jobId once it's been issued.
 */
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { subscribeToJob } from "@/lib/sse";
import { useJobsStore } from "@/state/useJobsStore";
import type { UIJob } from "@/types/domain";

interface StartArgs {
  audioPath: string;
  /** Display-friendly filename for the job card. */
  filename: string;
  /** Local URL used by the audio player (`blob:` or `asset://`). */
  audioUrl?: string;
  model: string;
  language?: string | null;
  /** Optional slice: only transcribe `[startS, endS]` of the source file. */
  startS?: number | null;
  endS?: number | null;
}

interface StartResult {
  /** The local id we used before the sidecar assigned one. */
  localId: string;
}

export function useTranscription() {
  const subsRef = useRef<Map<string, () => void>>(new Map());

  /** Cleanup all subscriptions on unmount. */
  useEffect(() => {
    return () => {
      subsRef.current.forEach((cleanup) => cleanup());
      subsRef.current.clear();
    };
  }, []);

  const start = useCallback(async (args: StartArgs): Promise<StartResult> => {
    const localId = `local-${Math.random().toString(36).slice(2, 10)}`;
    const draft: UIJob = {
      id: localId,
      status: "queued",
      model: args.model,
      language: args.language ?? null,
      audio_path: args.audioPath,
      audio_duration_s: null,
      started_at: null,
      finished_at: null,
      error: null,
      text: "",
      segments: [],
      filename: args.filename,
      audio_url: args.audioUrl,
      current_s: 0,
      total_s: 0,
      client_started_at: Date.now(),
    };

    const store = useJobsStore.getState();
    store.addJob(draft);

    let serverJobId: string | null = null;
    try {
      const { job_id } = await api.startTranscription({
        audio_path: args.audioPath,
        model: args.model,
        language: args.language ?? null,
        start_s: args.startS ?? null,
        end_s: args.endS ?? null,
      });
      serverJobId = job_id;
      useJobsStore.getState().renameJob(localId, job_id);
      useJobsStore.getState().updateJob(job_id, { status: "running" });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Couldn't start the transcription.";
      useJobsStore.getState().updateJob(localId, {
        status: "error",
        error: message,
      });
      toast.error(message);
      return { localId };
    }

    /* Wire SSE. */
    const cleanup = subscribeToJob(serverJobId, {
      onProgress: ({ current_s, total_s }) => {
        useJobsStore.getState().updateJob(serverJobId!, {
          current_s,
          total_s,
          audio_duration_s: total_s || null,
        });
      },
      onModelDownload: (payload) => {
        useJobsStore.getState().setModelDownload(serverJobId!, payload);
      },
      onSegment: (segment) => {
        // Clear any lingering download banner before appending — defensive,
        // even though appendSegment already clears it on the first segment.
        useJobsStore.getState().setModelDownload(serverJobId!, null);
        useJobsStore.getState().appendSegment(serverJobId!, segment);
        // Use the segment's end timestamp as the progress watermark when
        // the sidecar hasn't sent a fresh `progress` event yet.
        useJobsStore.getState().updateJob(serverJobId!, {
          current_s: segment.end,
        });
      },
      onDone: ({ text, segments, duration_s }) => {
        useJobsStore.getState().updateJob(serverJobId!, {
          status: "done",
          text,
          segments,
          audio_duration_s: duration_s,
          finished_at: Date.now() / 1000,
          current_s: duration_s ?? 0,
          total_s: duration_s ?? 0,
        });
        toast.success("Transcription complete.");
        subsRef.current.get(serverJobId!)?.();
        subsRef.current.delete(serverJobId!);
      },
      onError: ({ message }) => {
        useJobsStore.getState().updateJob(serverJobId!, {
          status: "error",
          error: message,
        });
        toast.error(message || "Transcription failed.");
        subsRef.current.get(serverJobId!)?.();
        subsRef.current.delete(serverJobId!);
      },
      onCancelled: () => {
        // The user already saw "Cancelled" via the optimistic update in
        // `cancel()`. This server-confirmed event mostly ensures we close
        // the subscription if the user didn't click cancel themselves
        // (e.g. another window cancelled the same job).
        useJobsStore.getState().updateJob(serverJobId!, {
          status: "cancelled",
        });
        subsRef.current.get(serverJobId!)?.();
        subsRef.current.delete(serverJobId!);
      },
    });
    subsRef.current.set(serverJobId, cleanup);

    return { localId };
  }, []);

  const cancel = useCallback(async (jobId: string): Promise<void> => {
    // Optimistic: flip the local job to "cancelled" immediately so the UI
    // reacts instantly, then fire the API call. Drop our SSE subscription
    // so further events for this job don't reanimate it.
    useJobsStore.getState().updateJob(jobId, { status: "cancelled" });
    subsRef.current.get(jobId)?.();
    subsRef.current.delete(jobId);
    try {
      await api.cancelJob(jobId);
      toast.message("Transcription cancelled.");
    } catch (err) {
      // The server-side cancel is best-effort; if it fails we still keep
      // the optimistic UI state because there's nothing useful to surface.
      const message = err instanceof ApiError ? err.message : "Cancel failed.";
      toast.error(message);
    }
  }, []);

  return { start, cancel };
}
