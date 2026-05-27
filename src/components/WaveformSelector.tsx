/**
 * Visual range selector — waveform + two draggable handles.
 *
 * Shown after the user picks a file but BEFORE starting transcription.
 * Defaults to selecting the entire file; if the user adjusts the
 * handles, only the selected slice is sent to /transcribe (which
 * ffmpeg-clips it server-side and offsets the segment timestamps).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";

import { Button } from "@/components/ui/button";
import { formatHMS } from "@/lib/timeFormat";
import { cn } from "@/lib/utils";

interface WaveformSelectorProps {
  /** Asset URL the WebView can load (used by the audio player; not used to
   *  generate the waveform — peaks come from the bundled ffmpeg). */
  audioUrl: string;
  /** Absolute filesystem path passed to `compute_audio_peaks`. */
  audioPath: string;
  /** Display-friendly filename for the header. */
  filename: string;
  /** Disabled until the engine is ready. */
  disabled?: boolean;
  /**
   * Called when the user confirms the selection. `range === null` means
   * "transcribe the entire file" (caller should NOT send start_s/end_s).
   * `range` is in seconds, both inclusive.
   */
  onConfirm: (range: { startS: number; endS: number } | null) => void;
  /** Called when the user backs out without transcribing. */
  onCancel: () => void;
}

interface PeaksResponse {
  peaks: number[];
  duration_s: number;
  sample_rate: number;
}

const TARGET_PEAKS = 800;

export function WaveformSelector({
  audioUrl,
  audioPath,
  filename,
  disabled,
  onConfirm,
  onCancel,
}: WaveformSelectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);

  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let ws: WaveSurfer | null = null;

    const setup = async () => {
      try {
        // Decode peaks via the bundled ffmpeg. We do NOT pass `url` to
        // WaveSurfer — its Web Audio decoder fails on m4a/AAC in WKWebView.
        // Instead we provide pre-computed peaks + duration; the visual
        // waveform draws from those directly. The HTML5 <audio> element
        // (used for preview playback) still loads the asset URL fine.
        const data = await invoke<PeaksResponse>("compute_audio_peaks", {
          audioPath,
          targetPeaks: TARGET_PEAKS,
        });
        if (cancelled) return;

        const regions = RegionsPlugin.create();
        ws = WaveSurfer.create({
          container: el,
          url: audioUrl, // for playback only; peaks below override decode
          peaks: [data.peaks],
          duration: data.duration_s,
          waveColor: "oklch(0.42 0.012 250)",
          progressColor: "oklch(0.78 0.155 75)",
          cursorColor: "oklch(0.88 0.05 75)",
          cursorWidth: 2,
          barWidth: 2,
          barGap: 1,
          barRadius: 1,
          height: 96,
          normalize: true,
          plugins: [regions],
        });
        wsRef.current = ws;

        const dur = data.duration_s;
        setDuration(dur);
        const r = regions.addRegion({
          start: 0,
          end: dur,
          drag: true,
          resize: true,
          color: "oklch(from var(--primary) l c h / 0.18)",
        });
        regionRef.current = r;
        const sync = () => setRange({ start: r.start, end: r.end });
        r.on("update", sync);
        r.on("update-end", sync);
        sync();
        setReady(true);

        ws.on("error", (e: Error) => {
          setError(e.message || "Audio playback failed");
        });
        ws.on("play", () => setPlaying(true));
        ws.on("pause", () => setPlaying(false));
        ws.on("finish", () => setPlaying(false));
        ws.on("timeupdate", (currentTime) => {
          const region = regionRef.current;
          if (!region || !ws) return;
          if (currentTime >= region.end) {
            ws.pause();
            ws.setTime(region.start);
          }
        });
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : typeof e === "string"
                ? e
                : "Couldn't analyze audio",
          );
        }
      }
    };

    void setup();

    return () => {
      cancelled = true;
      ws?.destroy();
      wsRef.current = null;
      regionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath, audioUrl]);

  const playSelection = useCallback(() => {
    const ws = wsRef.current;
    const r = regionRef.current;
    if (!ws || !r) return;
    if (playing) {
      ws.pause();
    } else {
      // Start from region.start every time the user hits play.
      ws.setTime(r.start);
      ws.play();
    }
  }, [playing]);

  const selectedDuration = Math.max(0, range.end - range.start);
  const isFullFile = useMemo(() => {
    if (duration <= 0) return true;
    // Treat near-edge selections as "full file" — saves the user from
    // pixel-perfect handle positioning.
    return range.start < 0.05 && range.end > duration - 0.05;
  }, [range, duration]);

  const handleTranscribe = () => {
    if (isFullFile || selectedDuration < 0.5) {
      onConfirm(null);
      return;
    }
    onConfirm({ startS: range.start, endS: range.end });
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
            Trim & transcribe
          </span>
          <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
            {filename}
          </h2>
        </div>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onCancel}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      <div className="rounded-lg border border-border bg-card/40 p-4 backdrop-blur-sm">
        <div
          ref={containerRef}
          className={cn(
            "min-h-[96px] w-full",
            !ready && "opacity-50",
          )}
        />
        {!ready && !error && (
          <p className="mt-2 text-center font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/60">
            Loading waveform…
          </p>
        )}
        {error && (
          <p className="mt-2 text-center text-[12px] text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 font-mono text-[11px] tabular text-muted-foreground">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={playing ? "Pause selection" : "Play selection"}
            onClick={playSelection}
            disabled={!ready}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-105 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:bg-muted disabled:text-muted-foreground"
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
            ) : (
              <Play className="ml-0.5 h-3.5 w-3.5 fill-current" strokeWidth={0} />
            )}
          </button>
          <div className="flex flex-col">
            <span className="text-foreground">
              {formatHMS(range.start)} → {formatHMS(range.end)}
            </span>
            <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
              {formatHMS(selectedDuration)} of {formatHMS(duration)}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]",
            isFullFile
              ? "border-border bg-muted text-muted-foreground"
              : "border-primary/30 bg-primary/15 text-primary",
          )}
        >
          {isFullFile ? "Full file" : "Selection"}
        </span>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleTranscribe} disabled={disabled || !ready}>
          {isFullFile
            ? "Transcribe full file"
            : `Transcribe ${formatHMS(selectedDuration)} selection`}
        </Button>
      </div>
    </div>
  );
}
