/**
 * Minimal HTML5 audio player rendered at the bottom of the transcript pane.
 *
 * - Single shared <audio> element registered into useAudioStore.
 * - Custom progress bar (click to seek).
 * - Tracks currentTime → store so TranscriptView can highlight segments.
 * - Spacebar play/pause is handled at the App-level keymap (see useKeymap).
 */
import { Pause, Play } from "lucide-react";
import { useEffect, useRef } from "react";

import { useAudioStore } from "@/state/useAudioStore";
import { cn } from "@/lib/utils";
import { formatHMS } from "@/lib/timeFormat";

interface AudioPlayerProps {
  src: string | null;
  /** Total duration in seconds — used when the audio doesn't know its own. */
  fallbackDuration?: number | null;
}

export function AudioPlayer({ src, fallbackDuration }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const playing = useAudioStore((s) => s.playing);
  const currentTime = useAudioStore((s) => s.currentTime);
  const duration = useAudioStore((s) => s.duration);
  const registerElement = useAudioStore((s) => s.registerElement);
  const setSource = useAudioStore((s) => s.setSource);
  const togglePlay = useAudioStore((s) => s.togglePlay);
  const seekTo = useAudioStore((s) => s.seekTo);
  const _setState = useAudioStore((s) => s._setState);

  // Register the audio element exactly once.
  useEffect(() => {
    registerElement(audioRef.current);
    return () => registerElement(null);
  }, [registerElement]);

  // Reflect prop changes into the store.
  useEffect(() => {
    setSource(src ?? null);
  }, [src, setSource]);

  // Wire native events to store updates.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => _setState({ currentTime: el.currentTime });
    const onDuration = () =>
      _setState({ duration: Number.isFinite(el.duration) ? el.duration : 0 });
    const onPlay = () => _setState({ playing: true });
    const onPause = () => _setState({ playing: false });
    const onEnded = () => _setState({ playing: false });

    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onDuration);
    el.addEventListener("durationchange", onDuration);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);

    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onDuration);
      el.removeEventListener("durationchange", onDuration);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [_setState]);

  const total = duration > 0 ? duration : fallbackDuration ?? 0;
  const percent = total > 0 ? Math.min(100, (currentTime / total) * 100) : 0;
  const hasAudio = Boolean(src);

  const handleScrub = (clientX: number) => {
    const track = trackRef.current;
    if (!track || total <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seekTo(ratio * total);
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 border-t border-border bg-card/60 px-4 py-2.5 backdrop-blur-xl",
        !hasAudio && "opacity-60",
      )}
    >
      <audio ref={audioRef} preload="metadata" />

      <button
        type="button"
        aria-label={playing ? "Pause audio" : "Play audio"}
        onClick={togglePlay}
        disabled={!hasAudio}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-105 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:bg-muted disabled:text-muted-foreground"
      >
        {playing ? (
          <Pause className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
        ) : (
          <Play className="ml-0.5 h-3.5 w-3.5 fill-current" strokeWidth={0} />
        )}
      </button>

      <span className="tabular shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatHMS(currentTime)}
      </span>

      <div
        ref={trackRef}
        role="slider"
        aria-label="Seek audio"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={hasAudio ? 0 : -1}
        onPointerDown={(e) => {
          if (!hasAudio) return;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          handleScrub(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) handleScrub(e.clientX);
        }}
        onKeyDown={(e) => {
          if (!hasAudio) return;
          if (e.key === "ArrowLeft") seekTo(currentTime - 5);
          if (e.key === "ArrowRight") seekTo(currentTime + 5);
        }}
        className="group relative h-6 flex-1 cursor-pointer"
      >
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-75"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          aria-hidden
          className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full bg-primary opacity-0 ring-2 ring-background transition-opacity group-hover:opacity-100"
          style={{ left: `${percent}%` }}
        />
      </div>

      <span className="tabular shrink-0 font-mono text-[11px] text-muted-foreground/70">
        {formatHMS(total)}
      </span>
    </div>
  );
}
