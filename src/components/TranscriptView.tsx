/**
 * Read-only segmented transcript view.
 *
 * - Each segment shows a monospace `[mm:ss]` timestamp aligned in a fixed
 *   gutter on the left and the segment text on the right.
 * - Clicking a segment seeks the audio player.
 * - The segment that contains the current playhead time is highlighted.
 * - While the job is still running, a "live caret" sits at the end of the
 *   last segment.
 * - Hover reveals a small play affordance.
 */
import { Play } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { useAudioStore } from "@/state/useAudioStore";
import { useJobsStore } from "@/state/useJobsStore";
import { cn } from "@/lib/utils";
import { formatSegmentTime } from "@/lib/timeFormat";
import type { UIJob } from "@/types/domain";

interface TranscriptViewProps {
  job: UIJob;
  /** When true the user is in editing mode (TranscriptEditor renders instead). */
  editing?: boolean;
  onEdit?: () => void;
}

export function TranscriptView({ job, editing, onEdit }: TranscriptViewProps) {
  const seekTo = useAudioStore((s) => s.seekTo);
  const play = useAudioStore((s) => s.play);
  const currentTime = useAudioStore((s) => s.currentTime);
  const setActive = useJobsStore((s) => s.setActive);

  const activeIdx = useMemo(() => {
    if (!job.segments.length) return -1;
    // Linear scan is fine for a few hundred segments. Defensive against
    // undefined entries that can sneak in if the SSE payload is malformed.
    for (let i = 0; i < job.segments.length; i++) {
      const seg = job.segments[i];
      if (!seg) continue;
      if (currentTime >= seg.start && currentTime < seg.end) return i;
    }
    return -1;
  }, [currentTime, job.segments]);

  // Scroll the active segment into view (smooth).
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-segment-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  // Ensure this job is the active one when the user interacts with it.
  useEffect(() => {
    setActive(job.id);
  }, [job.id, setActive]);

  const isLive = job.status === "running" || job.status === "queued";

  return (
    <div
      ref={containerRef}
      className="relative flex h-full flex-col overflow-y-auto px-10 pb-10 pt-6"
    >
      <div className="mx-auto w-full max-w-[760px] flex flex-col gap-1.5">
        {job.segments.length === 0 && !isLive && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No transcript yet.
          </p>
        )}

        {job.segments.length === 0 && isLive && (
          <p className="py-12 text-center font-mono text-[12px] uppercase tracking-[0.18em] text-muted-foreground/70">
            Listening<span className="live-caret" />
          </p>
        )}

        {job.segments.map((seg, idx) => {
          const isActive = idx === activeIdx;
          return (
            <button
              key={`${seg.start}-${idx}`}
              data-segment-idx={idx}
              type="button"
              onClick={() => {
                seekTo(seg.start);
                play();
              }}
              onDoubleClick={onEdit}
              aria-label={`Play segment at ${formatSegmentTime(seg.start)}`}
              className={cn(
                "group/segment segment-enter relative grid grid-cols-[68px_1fr_24px] items-baseline gap-3 rounded-md px-3 py-2 text-left transition-colors",
                isActive
                  ? "bg-accent/40"
                  : "hover:bg-accent/25",
                editing && "pointer-events-none opacity-70",
              )}
            >
              {/* Timestamp gutter */}
              <span
                className={cn(
                  "tabular self-baseline font-mono text-[11px]",
                  isActive ? "text-primary" : "text-muted-foreground/70",
                )}
              >
                [{formatSegmentTime(seg.start)}]
              </span>

              {/* Text */}
              <span
                className={cn(
                  "text-[14.5px] leading-[1.65] tracking-[-0.005em]",
                  isActive ? "text-foreground" : "text-foreground/85",
                  idx === job.segments.length - 1 && isLive && "live-caret",
                )}
              >
                {seg.text.trim()}
              </span>

              {/* Hover play */}
              <span
                aria-hidden
                className={cn(
                  "flex h-5 w-5 items-center justify-center self-center rounded-full opacity-0 transition-opacity group-hover/segment:opacity-100",
                  isActive && "opacity-100",
                )}
              >
                <Play
                  className="h-3 w-3 fill-current text-primary"
                  strokeWidth={0}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
