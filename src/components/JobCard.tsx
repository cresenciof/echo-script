/**
 * One job row in the left-hand JobList. Compact, dense.
 * Shows filename, model label, status, progress (current/total + percent),
 * elapsed, and an ETA estimate based on linear extrapolation.
 */
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { estimateRemaining, formatHMS } from "@/lib/timeFormat";
import type { UIJob } from "@/types/domain";

interface JobCardProps {
  job: UIJob;
  active: boolean;
  modelLabel?: string;
  onSelect: () => void;
}

function useTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function JobCard({ job, active, modelLabel, onSelect }: JobCardProps) {
  const running = job.status === "running" || job.status === "queued";
  const now = useTick(running);
  const elapsedMs =
    job.client_started_at && running ? now - job.client_started_at : 0;

  const percent =
    job.total_s > 0
      ? Math.min(100, Math.round((job.current_s / job.total_s) * 100))
      : 0;
  const eta = estimateRemaining(elapsedMs, job.current_s, job.total_s);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      aria-label={`Open job ${job.filename}`}
      className={cn(
        "group relative flex w-full flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 text-left transition-all",
        active
          ? "border-primary/40 bg-card [box-shadow:inset_0_0_0_1px_oklch(from_var(--primary)_l_c_h/0.25)]"
          : "border-border hover:border-border-strong hover:bg-surface-elevated",
      )}
    >
      {/* Accent rail (left edge) when active. */}
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-2.5 h-[calc(100%-1.25rem)] w-[2px] rounded-r bg-primary"
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge status={job.status} />
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {job.filename}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {percent > 0 ? `${percent}%` : ""}
        </span>
      </div>

      {running && (
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 h-full w-8 -translate-x-full animate-pulse bg-primary/40 blur-sm"
            style={{
              transform: `translateX(${percent - 100}%)`,
            }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/80">
        <span className="truncate tabular">
          {modelLabel ?? job.model.split("/").pop()}
        </span>
        <span className="shrink-0 tabular">
          {running
            ? `${formatHMS(job.current_s)} / ${formatHMS(job.total_s)}`
            : job.audio_duration_s
              ? formatHMS(job.audio_duration_s)
              : ""}
        </span>
      </div>

      {running && eta !== null && (
        <span className="font-mono text-[10px] tabular text-muted-foreground/60">
          ETA {formatHMS(eta)}
        </span>
      )}

      {job.status === "error" && job.error && (
        <p className="line-clamp-2 text-[11px] leading-snug text-destructive/90">
          {job.error}
        </p>
      )}
    </button>
  );
}

function StatusBadge({ status }: { status: UIJob["status"] }) {
  switch (status) {
    case "queued":
      return (
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted"
          aria-label="Queued"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
        </span>
      );
    case "running":
      return (
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-primary"
          aria-label="Transcribing"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      );
    case "done":
      return (
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-success"
          aria-label="Done"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </span>
      );
    case "error":
    case "cancelled":
      return (
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-destructive"
          aria-label={status === "error" ? "Error" : "Cancelled"}
        >
          <CircleAlert className="h-3.5 w-3.5" />
        </span>
      );
  }
}
