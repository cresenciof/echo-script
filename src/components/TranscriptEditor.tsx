/**
 * Edit mode for the transcript. Each segment becomes a contentEditable line
 * with the same `[mm:ss]` gutter. Changes are pushed straight into the
 * Zustand store on blur so navigating away preserves edits.
 *
 * No remote save — the brief explicitly scopes this to in-memory.
 */
import { useEffect, useRef } from "react";

import { useJobsStore } from "@/state/useJobsStore";
import { formatSegmentTime } from "@/lib/timeFormat";
import { cn } from "@/lib/utils";
import type { UIJob } from "@/types/domain";

interface TranscriptEditorProps {
  job: UIJob;
}

export function TranscriptEditor({ job }: TranscriptEditorProps) {
  const updateSegment = useJobsStore((s) => s.updateSegment);
  const firstRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the first segment on enter.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  return (
    <div className="relative h-full overflow-y-auto px-10 pb-10 pt-6">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-1.5">
        {job.segments.map((seg, idx) => (
          <div
            key={`${seg.start}-${idx}`}
            className="grid grid-cols-[68px_1fr] items-start gap-3 rounded-md px-3 py-1.5"
          >
            <label
              htmlFor={`seg-${job.id}-${idx}`}
              className="tabular pt-2 font-mono text-[11px] text-muted-foreground/70"
            >
              [{formatSegmentTime(seg.start)}]
            </label>
            <AutoTextarea
              id={`seg-${job.id}-${idx}`}
              ref={idx === 0 ? firstRef : undefined}
              defaultValue={seg.text.trim()}
              onCommit={(text) => updateSegment(job.id, idx, text)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

interface AutoTextareaProps {
  id: string;
  defaultValue: string;
  onCommit: (text: string) => void;
  ref?: React.Ref<HTMLTextAreaElement>;
}

function AutoTextarea({ id, defaultValue, onCommit, ref }: AutoTextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const resize = () => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    resize();
  }, []);

  return (
    <textarea
      id={id}
      ref={(el) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref && typeof ref === "object")
          (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }}
      defaultValue={defaultValue}
      onInput={resize}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      rows={1}
      spellCheck
      className={cn(
        "w-full resize-none border-none bg-transparent text-[14.5px] leading-[1.65] tracking-[-0.005em] text-foreground outline-none placeholder:text-muted-foreground/40",
        "rounded-md px-2 py-1 transition-colors focus:bg-accent/30 focus:ring-1 focus:ring-primary/40",
      )}
    />
  );
}
