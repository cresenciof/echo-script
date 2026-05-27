/**
 * The welcome surface. Centered drop zone, model summary below.
 * This is the screen the user sees when no jobs exist yet.
 */
import { Command, Keyboard } from "lucide-react";
import { Dropzone, type DropzonePick } from "./Dropzone";
import { ModelPicker } from "./ModelPicker";

interface EmptyStateProps {
  selectedModel: string;
  onSelectModel: (id: string) => void;
  onPick: (pick: DropzonePick) => void;
  engineReady: boolean;
}

export function EmptyState({
  selectedModel,
  onSelectModel,
  onPick,
  engineReady,
}: EmptyStateProps) {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      {/* Ambient backdrop — a single warm spotlight to anchor the eye. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(70% 50% at 50% 35%, oklch(from var(--primary) l c h / 0.07), transparent 70%)",
        }}
      />
      {/* Grain — almost invisible, just enough texture to fight the void. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/></svg>\")",
        }}
      />

      <div className="relative z-10 flex w-full max-w-xl flex-col gap-8 px-8 fade-in">
        <Dropzone onPick={onPick} disabled={!engineReady} />

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card/40 px-3.5 py-2.5 backdrop-blur-sm">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
              Active Model
            </span>
            <span className="text-[11px] text-muted-foreground">
              Change before dropping a file
            </span>
          </div>
          <ModelPicker value={selectedModel} onChange={onSelectModel} />
        </div>

        <div className="flex items-center justify-center gap-5 text-[11px] text-muted-foreground/80">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>
              <Command className="h-2.5 w-2.5" aria-hidden /> O
            </Kbd>
            Open file
          </span>
          <span className="h-3 w-px bg-border" aria-hidden />
          <span className="inline-flex items-center gap-1.5">
            <Kbd>
              <Keyboard className="h-2.5 w-2.5" aria-hidden /> Space
            </Kbd>
            Play / pause
          </span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 items-center gap-1 rounded border border-border bg-surface-elevated px-1.5 font-mono text-[10px] font-medium text-foreground/80 shadow-sm">
      {children}
    </kbd>
  );
}
