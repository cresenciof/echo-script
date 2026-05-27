/**
 * App header. Hosts the title (with a small mark) on the left and the
 * ModelPicker on the right. The whole bar is `data-tauri-drag-region`
 * so the user can drag the window from anywhere in the chrome — buttons
 * opt out via `data-no-drag` or being interactive elements.
 *
 * macOS traffic lights overlay this area (titleBarStyle: "Overlay"), so
 * we leave ~80px of left padding for them.
 */
import { PanelLeftClose, PanelLeftOpen, Waves } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/utils";

interface HeaderProps {
  selectedModel: string;
  onSelectModel: (id: string) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function Header({
  selectedModel,
  onSelectModel,
  sidebarCollapsed,
  onToggleSidebar,
}: HeaderProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-[52px] shrink-0 items-center justify-between border-b border-border bg-background/80 pl-[88px] pr-4 backdrop-blur-xl"
    >
      <div className="flex items-center gap-2.5" data-no-drag>
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
            aria-pressed={sidebarCollapsed}
            className={cn(
              "mr-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-accent/40 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            )}
          </button>
        )}
        <div
          className="relative flex h-6 w-6 items-center justify-center rounded-md bg-primary/20 ring-1 ring-primary/50"
          style={{
            // Subtle ambient glow so the wave mark catches the eye like the
            // primary play button at the bottom of the workspace.
            boxShadow:
              "0 0 14px 0 oklch(from var(--primary) l c h / 0.32)",
          }}
        >
          <Waves
            className="h-3.5 w-3.5 text-primary"
            strokeWidth={2.4}
            aria-hidden
          />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight text-foreground">
            Echo Script
          </span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
            v0.1
          </span>
        </div>
      </div>

      <div data-no-drag>
        <ModelPicker value={selectedModel} onChange={onSelectModel} compact />
      </div>
    </header>
  );
}
