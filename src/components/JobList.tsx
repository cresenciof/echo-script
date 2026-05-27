/**
 * Left sidebar: a vertical list of jobs in this session, plus an "add file"
 * button at the bottom. Newest at the top.
 */
import { useShallow } from "zustand/react/shallow";

import { useJobsStore, selectJobsInOrder } from "@/state/useJobsStore";
import { useModels } from "@/hooks/useModels";

import { Dropzone, type DropzonePick } from "./Dropzone";
import { JobCard } from "./JobCard";

interface JobListProps {
  onPick: (pick: DropzonePick) => void;
  disabled?: boolean;
}

export function JobList({ onPick, disabled }: JobListProps) {
  const jobs = useJobsStore(useShallow(selectJobsInOrder));
  const activeId = useJobsStore((s) => s.activeJobId);
  const setActive = useJobsStore((s) => s.setActive);
  const { data: models } = useModels();
  const modelLabelById = new Map(
    (models?.available ?? []).map((m) => [m.id, m.label]),
  );

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
