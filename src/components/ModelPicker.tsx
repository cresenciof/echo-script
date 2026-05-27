/**
 * Model picker — dropdown with the catalog from the sidecar.
 * Marks the recommended option with a small amber dot and labels each row
 * with "Installed" / "Needs download" tags inferred from /models.installed.
 */
import { Check, ChevronDown, Cpu, Download, Sparkle } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useModels } from "@/hooks/useModels";
import { cn } from "@/lib/utils";
import type { ModelEntry } from "@/types/domain";

interface ModelPickerProps {
  value: string;
  onChange: (id: string) => void;
  /** Tight header variant vs. larger inline variant on the empty state. */
  compact?: boolean;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

export function ModelPicker({ value, onChange, compact = false }: ModelPickerProps) {
  const { data, isLoading } = useModels();
  const models = data?.available ?? [];
  const installed = new Set(data?.installed ?? []);
  const current = models.find((m) => m.id === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Select transcription model"
        className={cn(
          "group inline-flex items-center gap-2 rounded-md border border-border bg-card text-card-foreground transition-colors hover:border-border-strong hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          compact ? "h-8 px-2.5 text-[12.5px]" : "h-10 px-3.5 text-sm",
        )}
      >
        <Cpu
          className={cn(
            "shrink-0 text-muted-foreground",
            compact ? "h-3.5 w-3.5" : "h-4 w-4",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "flex items-baseline gap-1.5",
            compact ? "" : "min-w-0",
          )}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
            Model
          </span>
          <span className="font-medium text-foreground">
            {isLoading ? "Loading…" : current?.label ?? "Choose"}
          </span>
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-[320px] border-border-strong bg-surface-elevated p-1.5"
      >
        <DropdownMenuLabel className="flex items-center justify-between px-2 py-1.5 text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/80">
          <span>Whisper Models</span>
          <span className="font-mono text-[10px] normal-case tracking-normal text-muted-foreground/60">
            {models.length} available
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border/60" />

        <div className="max-h-[360px] overflow-y-auto py-1">
          {models.map((m: ModelEntry) => {
            const isInstalled = installed.has(m.id);
            const isSelected = m.id === value;

            return (
              <DropdownMenuItem
                key={m.id}
                onSelect={() => onChange(m.id)}
                className={cn(
                  "group/item flex items-start gap-3 rounded-md px-2.5 py-2.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                  isSelected && "bg-accent/40",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-transparent",
                  )}
                  aria-hidden
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate font-medium text-foreground">
                      {m.label}
                      {m.recommended && (
                        <Sparkle
                          className="h-3 w-3 shrink-0 text-primary"
                          aria-label="Recommended"
                        />
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/80">
                      {formatSize(m.size_mb)}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                    {m.description}
                  </p>
                  <span
                    className={cn(
                      "mt-0.5 inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                      isInstalled
                        ? "bg-success/15 text-success"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {isInstalled ? (
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    ) : (
                      <Download className="h-2.5 w-2.5" />
                    )}
                    {isInstalled ? "Installed" : "Needs download"}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
