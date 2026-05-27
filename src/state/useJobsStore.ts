/**
 * Job store — single source of truth for every transcription the user has
 * touched in this session. Keyed by job_id (sidecar-issued for live jobs,
 * or a `local-*` id for entries that exist before /transcribe responds).
 */
import { create } from "zustand";
import type { Segment, UIJob } from "@/types/domain";

interface JobsState {
  jobs: Record<string, UIJob>;
  order: string[]; // insertion order, newest first
  activeJobId: string | null;

  addJob: (job: UIJob) => void;
  /** Replace the local id (e.g. `local-abc`) with the server-issued id. */
  renameJob: (fromId: string, toId: string) => void;
  updateJob: (id: string, patch: Partial<UIJob>) => void;
  appendSegment: (id: string, segment: Segment) => void;
  updateSegment: (id: string, idx: number, text: string) => void;
  setActive: (id: string | null) => void;
  removeJob: (id: string) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: {},
  order: [],
  activeJobId: null,

  addJob: (job) =>
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: job },
      order: [job.id, ...s.order.filter((id) => id !== job.id)],
      activeJobId: job.id,
    })),

  renameJob: (fromId, toId) =>
    set((s) => {
      if (fromId === toId || !s.jobs[fromId]) return s;
      const moved: UIJob = { ...s.jobs[fromId], id: toId };
      const { [fromId]: _removed, ...rest } = s.jobs;
      return {
        jobs: { ...rest, [toId]: moved },
        order: s.order.map((id) => (id === fromId ? toId : id)),
        activeJobId: s.activeJobId === fromId ? toId : s.activeJobId,
      };
    }),

  updateJob: (id, patch) =>
    set((s) =>
      s.jobs[id]
        ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id], ...patch } } }
        : s,
    ),

  appendSegment: (id, segment) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job) return s;
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, segments: [...job.segments, segment] },
        },
      };
    }),

  updateSegment: (id, idx, text) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job || idx < 0 || idx >= job.segments.length) return s;
      const next = job.segments.slice();
      next[idx] = { ...next[idx], text };
      const fullText = next.map((seg) => seg.text.trim()).join(" ");
      return {
        jobs: { ...s.jobs, [id]: { ...job, segments: next, text: fullText } },
      };
    }),

  setActive: (id) => set({ activeJobId: id }),

  removeJob: (id) =>
    set((s) => {
      const { [id]: _removed, ...rest } = s.jobs;
      const order = s.order.filter((x) => x !== id);
      return {
        jobs: rest,
        order,
        activeJobId: s.activeJobId === id ? (order[0] ?? null) : s.activeJobId,
      };
    }),
}));

/** Selector helpers. */
export const selectActiveJob = (s: JobsState): UIJob | null =>
  s.activeJobId ? s.jobs[s.activeJobId] ?? null : null;

export const selectJobsInOrder = (s: JobsState): UIJob[] =>
  s.order.map((id) => s.jobs[id]).filter((j): j is UIJob => Boolean(j));
