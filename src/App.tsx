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
import { WorkspaceView } from "./components/WorkspaceView";

import { useShallow } from "zustand/react/shallow";

import { useAudioStore } from "./state/useAudioStore";
import { useHealth } from "./hooks/useHealth";
import { useKeymap } from "./hooks/useKeymap";
import { useModels } from "./hooks/useModels";
import { useTranscription } from "./hooks/useTranscription";
import {
  selectActiveJob,
  selectJobsInOrder,
  useJobsStore,
} from "./state/useJobsStore";

const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";

function App() {
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
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
      await start({
        audioPath: pick.path,
        filename: pick.name,
        audioUrl,
        model: selectedModel,
      });
    },
    [engineReady, selectedModel, start],
  );

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
      {hasJobs ? (
        <>
          <Header
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
          />
          <div className="flex min-h-0 flex-1">
            <JobList onPick={handlePick} disabled={!engineReady} />
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
