/**
 * Modal that drives the `export_subtitled_video` Tauri command (soft mux or
 * burn-in). Listens to `ffmpeg_progress` for the progress bar. Closing is
 * blocked while an export is running.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  SubtitleModeOption,
  type SubtitleMode,
} from "@/components/SubtitleModeOption";
import type { Segment, UIJob } from "@/types/domain";

interface FfmpegProgress {
  out_time_s: number;
  total_s: number | null;
  status: "running" | "done";
}

interface Props {
  job: UIJob;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const baseNameOf = (path: string): string =>
  (path.split(/[\\/]/).pop() ?? path).replace(/\.[^/.]+$/, "");

export function SubtitleExportDialog({ job, open, onOpenChange }: Props) {
  const [mode, setMode] = useState<SubtitleMode>("soft");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FfmpegProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!open) {
      setMode("soft");
      setProgress(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const handleExport = async () => {
    setError(null);
    setProgress(null);

    const defaultName = `${baseNameOf(job.audio_path)}.with-subs.mp4`;
    let chosen: string | null = null;
    try {
      const res = await save({
        title: "Export subtitled video",
        defaultPath: defaultName,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      });
      chosen = typeof res === "string" ? res : null;
    } catch (e) {
      setError(`Couldn't open save dialog: ${String(e)}`);
      return;
    }
    if (!chosen) return; // user cancelled

    setRunning(true);
    try {
      unlistenRef.current = await listen<FfmpegProgress>(
        "ffmpeg_progress",
        (event) => setProgress(event.payload),
      );

      const segments: Segment[] = job.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
      const outPath = await invoke<string>("export_subtitled_video", {
        inputVideoPath: job.audio_path,
        transcriptSegments: segments,
        outputPath: chosen,
        mode,
      });
      toast.success(`Exported to ${outPath}`);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const percent =
    progress && progress.total_s && progress.total_s > 0
      ? Math.min(100, Math.round((progress.out_time_s / progress.total_s) * 100))
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return; // block close while exporting
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export subtitled video</DialogTitle>
          <DialogDescription>
            Embed the transcript into the original video.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2" disabled={running}>
          <SubtitleModeOption
            value="soft"
            current={mode}
            onSelect={setMode}
            title="Soft subtitles (recommended, fast)"
            description="Adds an embedded subtitle track. Toggleable in QuickTime / VLC. Lossless, finishes in seconds."
          />
          <SubtitleModeOption
            value="burn"
            current={mode}
            onSelect={setMode}
            title="Burn into video (slower, always visible)"
            description="Re-encodes the video with subtitles rendered into the picture. Best for social media uploads."
          />
        </fieldset>

        {running && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {percent !== null ? `Encoding… ${percent}%` : "Encoding…"}
            </div>
            {percent !== null && <Progress value={percent} />}
          </div>
        )}

        {error && (
          <p className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={running}>
            {running ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
