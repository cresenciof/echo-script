/**
 * Left sidebar: a vertical list of jobs in this session, plus an "add file"
 * button at the bottom. Newest at the top.
 *
 * Two modes: expanded (default, 280px) and collapsed (56px icon rail) for
 * narrow windows. The collapsed rail keeps job switching + add-file
 * one click away without dominating the layout.
 */
import { useShallow } from "zustand/react/shallow";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";

import { useJobsStore, selectJobsInOrder } from "@/state/useJobsStore";
import { useModels } from "@/hooks/useModels";
import { cn } from "@/lib/utils";
import type { UIJob } from "@/types/domain";

import { Dropzone, type DropzonePick } from "./Dropzone";
import { JobCard } from "./JobCard";

interface JobListProps {
  onPick: (pick: DropzonePick) => void;
  disabled?: boolean;
  collapsed?: boolean;
}

export function JobList({ onPick, disabled, collapsed }: JobListProps) {
  const jobs = useJobsStore(useShallow(selectJobsInOrder));
  const activeId = useJobsStore((s) => s.activeJobId);
  const setActive = useJobsStore((s) => s.setActive);
  const { data: models } = useModels();
  const modelLabelById = new Map(
    (models?.available ?? []).map((m) => [m.id, m.label]),
  );

  if (collapsed) {
    return <CollapsedRail jobs={jobs} activeId={activeId} setActive={setActive} onPick={onPick} disabled={disabled} />;
  }

  return (
    <aside
      aria-label="Transcription jobs"
      className="flex h-full w-[280px] shrink-0 flex-col border-r border-border-strong bg-surface-sunken"
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
          Jobs
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {jobs.length}
        </span>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            active={job.id === activeId}
            modelLabel={modelLabelById.get(job.model)}
            onSelect={() => setActive(job.id)}
          />
        ))}
      </div>

      <div className="border-t border-border bg-background/40 p-3">
        <Dropzone onPick={onPick} disabled={disabled} variant="compact" />
      </div>
    </aside>
  );
}

interface CollapsedRailProps {
  jobs: UIJob[];
  activeId: string | null;
  setActive: (id: string) => void;
  onPick: (pick: DropzonePick) => void;
  disabled?: boolean;
}

function CollapsedRail({
  jobs,
  activeId,
  setActive,
  onPick,
  disabled,
}: CollapsedRailProps) {
  return (
    <aside
      aria-label="Transcription jobs (collapsed)"
      className="flex h-full w-[56px] shrink-0 flex-col items-center border-r border-border-strong bg-surface-sunken py-3"
    >
      <div className="flex-1 space-y-1.5 overflow-y-auto px-2">
        {jobs.map((job) => (
          <RailButton
            key={job.id}
            job={job}
            active={job.id === activeId}
            onSelect={() => setActive(job.id)}
          />
        ))}
      </div>
      <div className="mt-2 border-t border-border pt-3">
        <CollapsedAddButton onPick={onPick} disabled={disabled} />
      </div>
    </aside>
  );
}

function RailButton({
  job,
  active,
  onSelect,
}: {
  job: UIJob;
  active: boolean;
  onSelect: () => void;
}) {
  const initials =
    job.filename
      .replace(/\.[^.]+$/, "")
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "·";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Open ${job.filename}`}
      title={job.filename}
      className={cn(
        "group relative flex h-9 w-9 items-center justify-center rounded-md border text-[11px] font-medium transition-colors",
        active
          ? "border-primary/50 bg-primary/15 text-primary"
          : "border-transparent bg-card/40 text-muted-foreground hover:bg-card/70 hover:text-foreground",
      )}
    >
      <span className="font-mono">{initials}</span>
      <StatusGlyph status={job.status} />
    </button>
  );
}

function StatusGlyph({ status }: { status: UIJob["status"] }) {
  if (status === "running" || status === "queued") {
    return (
      <Loader2
        className="absolute -right-1 -top-1 h-3 w-3 animate-spin text-primary"
        aria-hidden
      />
    );
  }
  if (status === "done") {
    return (
      <CheckCircle2
        className="absolute -right-1 -top-1 h-3 w-3 text-success/80"
        aria-hidden
      />
    );
  }
  if (status === "error") {
    return (
      <CircleAlert
        className="absolute -right-1 -top-1 h-3 w-3 text-destructive"
        aria-hidden
      />
    );
  }
  return null;
}

function CollapsedAddButton({
  onPick,
  disabled,
}: {
  onPick: (pick: DropzonePick) => void;
  disabled?: boolean;
}) {
  // Reuse the Dropzone compact handler indirectly: render a small icon button
  // that opens the file dialog. Dropzone's native dialog is shared.
  return (
    <div className="flex justify-center">
      <Dropzone onPick={onPick} disabled={disabled} variant="rail" />
    </div>
  );
}
