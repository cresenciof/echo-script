/**
 * App shell — three-pane desktop layout.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Header (traffic-light safe; drag region)    │
 *   ├──────────────┬──────────────────────────────┤
 *   │              │                              │
 *   │  JobList     │      WorkspaceView           │
 *   │              │      (transcript + audio)    │
 *   │              │                              │
 *   ├──────────────┴──────────────────────────────┤
 *   │ StatusBar                                   │
 *   └─────────────────────────────────────────────┘
 *
 * The Header is hidden in the empty state to let the welcome screen breathe.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import type { DropzonePick } from "./components/Dropzone";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { JobList } from "./components/JobList";
import { StatusBar } from "./components/StatusBar";
import { WaveformSelector } from "./components/WaveformSelector";
import { WorkspaceView } from "./components/WorkspaceView";

interface PendingPick {
  path: string;
  filename: string;
  audioUrl: string;
}

import { useShallow } from "zustand/react/shallow";

import { isAcceptedMediaFile } from "./lib/audioFormats";
import { useAudioStore } from "./state/useAudioStore";
import { useHealth } from "./hooks/useHealth";
import { useKeymap } from "./hooks/useKeymap";
import { useModels } from "./hooks/useModels";
import { useTauriDragDrop } from "./hooks/useTauriDragDrop";
import { useTranscription } from "./hooks/useTranscription";
import {
  selectActiveJob,
  selectJobsInOrder,
  useJobsStore,
} from "./state/useJobsStore";

const DEFAULT_MODEL = "mlx-community/whisper-large-v3-mlx-4bit";

function App() {
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  // Sidebar starts collapsed on narrow windows. After mount the user toggles
  // it manually; we don't react to resize on the fly to avoid surprising them.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 1024;
  });
  // When the user picks a file, we don't transcribe immediately — we stash
  // the pick here and render the WaveformSelector so the user can trim the
  // range. Confirming the selector calls `start()` with optional start_s/end_s.
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const { start } = useTranscription();
  const { data: health } = useHealth();
  const { data: models } = useModels();
  const engineReady = Boolean(health);

  const jobs = useJobsStore(useShallow(selectJobsInOrder));
  const activeJob = useJobsStore(selectActiveJob);
  const audioSetSource = useAudioStore((s) => s.setSource);
  const togglePlay = useAudioStore((s) => s.togglePlay);

  // Keep the audio element pointed at the active job's audio.
  useEffect(() => {
    audioSetSource(activeJob?.audio_url ?? null);
  }, [activeJob?.id, activeJob?.audio_url, audioSetSource]);

  // Pick a sensible default model once the catalog loads.
  useEffect(() => {
    if (!models?.available?.length) return;
    if (models.available.some((m) => m.id === selectedModel)) return;
    const recommended =
      models.available.find((m) => m.recommended) ?? models.available[0];
    if (recommended) setSelectedModel(recommended.id);
  }, [models, selectedModel]);

  // Listen for the dev-fallback warning emitted by sidecar.ts.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ fallback: string }>).detail;
      toast.warning(
        `Sidecar URL not injected — using dev fallback ${detail.fallback}`,
      );
    };
    window.addEventListener("sidecar:missing", handler as EventListener);
    return () =>
      window.removeEventListener("sidecar:missing", handler as EventListener);
  }, []);

  const handlePick = useCallback(
    async (pick: DropzonePick) => {
      if (!engineReady) {
        toast.message("The engine is still starting…");
        return;
      }
      // In Tauri, convert the absolute filesystem path to an asset URL the
      // <audio> element can load. In browser dev the dropzone already gives
      // us a `blob:` URL.
      let audioUrl = pick.url;
      if (!audioUrl) {
        try {
          audioUrl = convertFileSrc(pick.path);
        } catch {
          audioUrl = undefined;
        }
      }
      // Defer to the WaveformSelector so the user can optionally trim. If
      // they confirm without moving the handles we transcribe the whole
      // file, exactly as before.
      if (audioUrl) {
        setPendingPick({ path: pick.path, filename: pick.name, audioUrl });
        return;
      }
      // No audio URL (e.g. browser dev without Tauri) — fall back to direct
      // start so the dev flow still works without the selector.
      await start({
        audioPath: pick.path,
        filename: pick.name,
        audioUrl,
        model: selectedModel,
      });
    },
    [engineReady, selectedModel, start],
  );

  const handleSelectorConfirm = useCallback(
    async (range: { startS: number; endS: number } | null) => {
      const pick = pendingPick;
      if (!pick) return;
      setPendingPick(null);
      await start({
        audioPath: pick.path,
        filename: pick.filename,
        audioUrl: pick.audioUrl,
        model: selectedModel,
        startS: range?.startS ?? null,
        endS: range?.endS ?? null,
      });
    },
    [pendingPick, selectedModel, start],
  );

  const handleSelectorCancel = useCallback(() => {
    setPendingPick(null);
  }, []);

  // Native Tauri drag-drop. macOS hands us absolute filesystem paths; we
  // filter to media files and route through the same `handlePick` so the
  // overlay state + transcription pipeline stay identical to the file picker.
  const handleNativeDrop = useCallback(
    (paths: string[]) => {
      const media = paths.filter(isAcceptedMediaFile);
      if (media.length === 0) {
        toast.error("Only audio or video files are supported.");
        return;
      }
      const first = media[0];
      const name = first.split(/[\\/]/).pop() ?? first;
      void handlePick({ path: first, name });
      if (media.length > 1) {
        toast.message(`Only the first file (${name}) is being transcribed.`);
      }
    },
    [handlePick],
  );
  const dragState = useTauriDragDrop({
    onDrop: handleNativeDrop,
    enabled: engineReady,
  });

  const handleOpenFile = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "Choose an audio file",
      });
      if (typeof selected === "string" && selected.length > 0) {
        const name = selected.split(/[\\/]/).pop() ?? selected;
        await handlePick({ path: selected, name });
      }
    } catch {
      toast.error("Couldn't open the file picker.");
    }
  }, [handlePick]);

  useKeymap({
    onOpenFile: handleOpenFile,
    onPlayPause: togglePlay,
  });

  const hasJobs = jobs.length > 0;

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Always-on drag region pinned to the top so the window is movable
          regardless of which app state is rendered. It overlays any content
          but never intercepts pointer events on interactive children, which
          opt out via `data-no-drag` or by being actual buttons / inputs. */}
      <DragStrip />
      {/* Native Tauri drag overlay — shown while files are hovering over the
          window (driven by the OS-level drag event, not HTML5). */}
      <DragOverlay active={dragState === "over"} engineReady={engineReady} />
      {/* Waveform selector — rendered ABOVE the current view (empty state or
          workspace) as a modal-style overlay until the user confirms or
          cancels. We give it its own z-index above the drag strip so the
          close button stays clickable but the title bar drag still works. */}
      {pendingPick && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/95 pt-[48px] backdrop-blur-sm">
          <WaveformSelector
            audioUrl={pendingPick.audioUrl}
            audioPath={pendingPick.path}
            filename={pendingPick.filename}
            disabled={!engineReady}
            onConfirm={handleSelectorConfirm}
            onCancel={handleSelectorCancel}
          />
        </div>
      )}
      {hasJobs ? (
        <>
          <Header
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
          />
          <div className="flex min-h-0 flex-1">
            <JobList
              onPick={handlePick}
              disabled={!engineReady}
              collapsed={sidebarCollapsed}
            />
            {activeJob ? (
              <WorkspaceView job={activeJob} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a job
              </div>
            )}
          </div>
          <StatusBar selectedModel={selectedModel} />
        </>
      ) : (
        <>
          <main className="min-h-0 flex-1 pt-[44px]">
            <EmptyState
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              onPick={handlePick}
              engineReady={engineReady}
            />
          </main>
          <StatusBar selectedModel={selectedModel} />
        </>
      )}
    </div>
  );
}

/**
 * Full-window overlay rendered when Tauri reports files being dragged over
 * the app. Purely visual — the actual drop is handled by `useTauriDragDrop`
 * one level up. `pointer-events-none` so the OS can keep delivering its drag
 * events to us without the WebView swallowing them.
 */
function DragOverlay({
  active,
  engineReady,
}: {
  active: boolean;
  engineReady: boolean;
}) {
  if (!active) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div
        className="relative flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-primary/70 bg-card/40 px-12 py-10 text-center [box-shadow:0_0_0_6px_oklch(from_var(--primary)_l_c_h/0.18)]"
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary">
          Drop to transcribe
        </div>
        <div className="text-base font-medium text-foreground">
          {engineReady ? "Release the file" : "Engine still starting…"}
        </div>
      </div>
    </div>
  );
}

/**
 * Always-visible drag region overlaying the top edge of the window. Sits
 * above other content via z-index and is fully transparent. macOS traffic
 * lights (rendered by the OS in the same band thanks to titleBarStyle:
 * "Overlay") remain interactive because they live on a higher OS layer.
 */
function DragStrip() {
  return (
    <div
      data-tauri-drag-region
      aria-hidden
      className="pointer-events-auto absolute inset-x-0 top-0 z-50 h-[44px]"
    />
  );
}

export default App;
