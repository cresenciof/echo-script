/**
 * Bottom-of-window status line. Three slots:
 * left:   sidecar connection state + version
 * center: active model label
 * right:  job counts (running / done)
 */
import { CircleAlert, CircleDot, Cpu, Loader2 } from "lucide-react";

import { useHealth } from "@/hooks/useHealth";
import { useModels } from "@/hooks/useModels";
import { useJobsStore } from "@/state/useJobsStore";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  selectedModel: string;
}

export function StatusBar({ selectedModel }: StatusBarProps) {
  const { data: health, isError, isLoading } = useHealth();
  const { data: models } = useModels();
  const modelLabel =
    models?.available.find((m) => m.id === selectedModel)?.label ?? "—";

  const running = useJobsStore((s) =>
    Object.values(s.jobs).filter((j) => j.status === "running").length,
  );
  const done = useJobsStore((s) =>
    Object.values(s.jobs).filter((j) => j.status === "done").length,
  );

  const connectionState: "online" | "starting" | "offline" = health
    ? "online"
    : isError
      ? "offline"
      : "starting";

  return (
    <footer
      className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-surface-sunken px-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground/80"
      role="contentinfo"
      aria-label="Status bar"
    >
      <div className="flex items-center gap-2">
        <ConnectionDot state={connectionState} loading={isLoading} />
        <span>
          {connectionState === "online"
            ? `Engine ${health?.version ?? "·"}`
            : connectionState === "starting"
              ? "Starting engine"
              : "Engine offline"}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <Cpu className="h-3 w-3 text-muted-foreground/70" aria-hidden />
        <span className="truncate normal-case tracking-normal text-muted-foreground">
          {modelLabel}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              running > 0 ? "bg-primary" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          {running} running
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              done > 0 ? "bg-success" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          {done} done
        </span>
      </div>
    </footer>
  );
}

interface ConnectionDotProps {
  state: "online" | "starting" | "offline";
  loading: boolean;
}

function ConnectionDot({ state, loading }: ConnectionDotProps) {
  if (state === "starting" || loading) {
    return (
      <Loader2 className="h-3 w-3 animate-spin text-warning" aria-hidden />
    );
  }
  if (state === "offline") {
    return <CircleAlert className="h-3 w-3 text-destructive" aria-hidden />;
  }
  return (
    <span className="text-success">
      <CircleDot className="pulse-dot h-3 w-3" aria-hidden />
    </span>
  );
}
