/**
 * Banner shown in the workspace header during a first-run model download.
 *
 * Mirrors the visual style of the regular "Transcribing" progress block
 * (mono font, thin amber progress bar) but with copy + numbers that match
 * what huggingface_hub reports via tqdm on stderr.
 */
import { formatBytes } from "@/lib/timeFormat";
import type { ModelDownloadEvent } from "@/types/domain";

interface ModelDownloadBannerProps {
  modelLabel: string;
  payload: ModelDownloadEvent;
}

export function ModelDownloadBanner({ modelLabel, payload }: ModelDownloadBannerProps) {
  // Clamp on the client too — defense in depth in case the sidecar ever
  // emits a stale `> 100` reading mid-download.
  const percent = Math.max(0, Math.min(100, Math.round(payload.percent)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 font-mono text-[11px] tabular text-muted-foreground">
        <span className="text-foreground/90">
          Downloading model
          <span aria-hidden className="ml-1.5 inline-flex h-1 w-1 translate-y-[-1px] animate-pulse rounded-full bg-primary align-middle" />
          <span aria-hidden className="ml-1 inline-flex h-1 w-1 translate-y-[-1px] animate-pulse rounded-full bg-primary/70 align-middle [animation-delay:180ms]" />
          <span aria-hidden className="ml-1 inline-flex h-1 w-1 translate-y-[-1px] animate-pulse rounded-full bg-primary/40 align-middle [animation-delay:360ms]" />
          <span className="ml-2 normal-case tracking-normal text-foreground">
            {modelLabel}
          </span>
          <span className="ml-2 normal-case tracking-normal text-muted-foreground">
            · {formatBytes(payload.downloaded_bytes)} of {formatBytes(payload.total_bytes)}
          </span>
          <span className="ml-2 text-primary">· {percent}%</span>
        </span>
        {payload.filename && (
          <span className="truncate normal-case tracking-normal text-muted-foreground/70">
            {payload.filename}
          </span>
        )}
      </div>

      <div className="relative h-[3px] overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
