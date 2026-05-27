/**
 * Right-hand pane: shows the currently selected job.
 *
 * - Header strip: file name, status pill, big progress (when running).
 * - Body: TranscriptView OR TranscriptEditor.
 * - Footer: AudioPlayer + ExportBar (export only when done).
 */
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { AudioPlayer } from "./AudioPlayer";
import { ExportBar } from "./ExportBar";
import { ModelDownloadBanner } from "./ModelDownloadBanner";
import { TranscriptEditor } from "./TranscriptEditor";
import { TranscriptView } from "./TranscriptView";

import { useModels } from "@/hooks/useModels";
import { estimateRemaining, formatHMS } from "@/lib/timeFormat";
import { cn } from "@/lib/utils";
import type { UIJob } from "@/types/domain";

interface WorkspaceViewProps {
  job: UIJob;
}

export function WorkspaceView({ job }: WorkspaceViewProps) {
  const [editing, setEditing] = useState(false);
  const { data: models } = useModels();
  const modelLabel =
    models?.available.find((m) => m.id === job.model)?.label ?? job.model;

  // Reset editing whenever a different job becomes active.
  useEffect(() => {
    setEditing(false);
  }, [job.id]);

  const running = job.status === "running" || job.status === "queued";
  const percent =
    job.total_s > 0
      ? Math.min(100, Math.round((job.current_s / job.total_s) * 100))
      : 0;

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col bg-background">
      <JobHeader
        job={job}
        modelLabel={modelLabel}
        running={running}
        percent={percent}
      />

      {editing ? (
        <TranscriptEditor job={job} />
      ) : (
        <TranscriptView job={job} editing={editing} onEdit={() => setEditing(true)} />
      )}

      <AudioPlayer
        src={job.audio_url ?? null}
        fallbackDuration={job.audio_duration_s}
      />

      {job.status === "done" && (
        <ExportBar
          job={job}
          editing={editing}
          onToggleEdit={() => setEditing((e) => !e)}
        />
      )}
    </section>
  );
}

interface JobHeaderProps {
  job: UIJob;
  modelLabel: string;
  running: boolean;
  percent: number;
}

function JobHeader({ job, modelLabel, running, percent }: JobHeaderProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const elapsedMs =
    job.client_started_at && running ? now - job.client_started_at : 0;
  const eta = estimateRemaining(elapsedMs, job.current_s, job.total_s);

  // First-run UX: while huggingface_hub is downloading the model, REPLACE the
  // "Transcribing" line with a distinct "Downloading model …" banner. We only
  // trust the download phase until the very first segment arrives — once
  // transcription has started, segment timestamps are a better progress
  // signal than tqdm's download bar.
  const isDownloading =
    running &&
    !!job.modelDownload &&
    job.status === "running" &&
    job.segments.length === 0;

  return (
    <header className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface-elevated/40 px-6 pt-5 pb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
            {job.filename}
          </h1>
          <div className="flex items-center gap-3 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/80">
            <span>{modelLabel}</span>
            {job.language && (
              <>
                <span aria-hidden className="h-3 w-px bg-border" />
                <span>{job.language}</span>
              </>
            )}
            {job.audio_duration_s && (
              <>
                <span aria-hidden className="h-3 w-px bg-border" />
                <span className="tabular normal-case tracking-normal text-muted-foreground">
                  {formatHMS(job.audio_duration_s)}
                </span>
              </>
            )}
          </div>
        </div>

        <StatusPill status={job.status} />
      </div>

      {isDownloading && job.modelDownload ? (
        <ModelDownloadBanner modelLabel={modelLabel} payload={job.modelDownload} />
      ) : (
        running && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 font-mono text-[11px] tabular text-muted-foreground">
              <span className="text-foreground/90">
                Transcribing
                <span aria-hidden className="ml-1.5 inline-flex h-1 w-1 translate-y-[-1px] animate-pulse rounded-full bg-primary align-middle" />
                <span aria-hidden className="ml-1 inline-flex h-1 w-1 translate-y-[-1px] animate-pulse rounded-full bg-primary/70 align-middle [animation-delay:180ms]" />
                <span aria-hidden className="ml-1 inline-flex h-1 w-1 translate-y-[-1px] animate-pulse rounded-full bg-primary/40 align-middle [animation-delay:360ms]" />
                <span className="ml-2 normal-case tracking-normal text-foreground">
                  {formatHMS(job.current_s)} of {formatHMS(job.total_s || 0)}
                </span>
                <span className="ml-2 text-primary">· {percent}%</span>
              </span>
              <span>{eta !== null && <>ETA {formatHMS(eta)}</>}</span>
            </div>

            <div className="relative h-[3px] overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )
      )}
    </header>
  );
}


function StatusPill({ status }: { status: UIJob["status"] }) {
  const map = {
    queued: {
      label: "Queued",
      icon: Loader2,
      className: "border-border bg-card text-muted-foreground",
      iconClass: "animate-spin",
    },
    running: {
      label: "Transcribing",
      icon: Loader2,
      className: "border-primary/30 bg-primary/15 text-primary",
      iconClass: "animate-spin",
    },
    done: {
      label: "Complete",
      icon: CheckCircle2,
      // Softer than the running/error pills — finished is the resting state.
      // Lower opacity ring + no background fill so the green doesn't compete
      // with the primary amber.
      className: "border-success/20 bg-transparent text-success/80",
      iconClass: "",
    },
    error: {
      label: "Failed",
      icon: CircleAlert,
      className: "border-destructive/30 bg-destructive/15 text-destructive",
      iconClass: "",
    },
    cancelled: {
      label: "Cancelled",
      icon: CircleAlert,
      className: "border-border bg-muted text-muted-foreground",
      iconClass: "",
    },
  } as const;

  const entry = map[status];
  const Icon = entry.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em]",
        entry.className,
      )}
    >
      <Icon className={cn("h-3 w-3", entry.iconClass)} aria-hidden />
      {entry.label}
    </span>
  );
}
