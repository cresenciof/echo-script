/**
 * Drop area for audio files. Two modes:
 * - Expansive (empty state): big poster on the welcome screen.
 * - Compact: a small "add another file" button in the job list footer.
 *
 * Uses the Tauri dialog plugin for native open dialog. Falls back to the
 * HTML <input type="file"> via react-dropzone when running in a plain browser.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { FileAudio, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

import { cn } from "@/lib/utils";

const ACCEPTED_EXT = ["m4a", "mp3", "wav", "mp4", "aac", "flac", "ogg", "aiff"];
const ACCEPT_MIME: Record<string, string[]> = {
  "audio/*": ACCEPTED_EXT.map((e) => `.${e}`),
  "video/mp4": [".mp4"],
};

export interface DropzonePick {
  /** Best-known absolute path to the file (Tauri only). */
  path: string;
  /** Display filename. */
  name: string;
  /** Local URL the audio player can load (`blob:` in browser fallback). */
  url?: string;
}

interface DropzoneProps {
  onPick: (pick: DropzonePick) => void;
  disabled?: boolean;
  variant?: "expansive" | "compact";
}

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window ||
    Boolean((window as { __SIDECAR_URL__?: string }).__SIDECAR_URL__)
  );
}

export function Dropzone({ onPick, disabled, variant = "expansive" }: DropzoneProps) {
  const [picking, setPicking] = useState(false);

  /** Native dialog (Tauri) — preferred. Gives us an absolute path. */
  const openNative = useCallback(async () => {
    if (picking || disabled) return;
    setPicking(true);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Choose an audio file",
        filters: [
          { name: "Audio", extensions: ACCEPTED_EXT },
        ],
      });
      if (typeof selected === "string" && selected.length > 0) {
        const name = selected.split(/[\\/]/).pop() ?? selected;
        onPick({ path: selected, name });
      }
    } finally {
      setPicking(false);
    }
  }, [picking, disabled, onPick]);

  /** Browser fallback through react-dropzone. */
  const onDrop = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;
      // In browser dev we don't have an OS path. We surface the name and a
      // blob URL — the API call to /transcribe will still fail in dev, but
      // at least the UI is testable.
      const fakePath = (file as File & { path?: string }).path ?? file.name;
      onPick({
        path: fakePath,
        name: file.name,
        url: URL.createObjectURL(file),
      });
    },
    [onPick],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: ACCEPT_MIME,
    noClick: isTauriRuntime(), // we use the native dialog in Tauri
    disabled,
  });

  const handleClick = () => {
    if (isTauriRuntime()) {
      void openNative();
    }
  };

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || picking}
        className="group inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card/40 text-[12.5px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        aria-label="Add another audio file"
      >
        <Upload
          className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5"
          aria-hidden
        />
        Add audio file
      </button>
    );
  }

  return (
    <div
      {...getRootProps({
        onClick: handleClick,
      })}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col items-center justify-center gap-6 overflow-hidden rounded-xl border-2 border-dashed bg-card/30 px-10 py-14 text-center transition-all",
        "border-border hover:border-primary/60 hover:bg-accent/20",
        isDragActive &&
          "border-primary bg-primary/10 [box-shadow:0_0_0_4px_oklch(from_var(--primary)_l_c_h/0.18)]",
        disabled && "pointer-events-none opacity-50",
      )}
      role="button"
      tabIndex={0}
      aria-label="Drop audio file or click to choose"
    >
      <input {...getInputProps()} />

      {/* Subtle inner glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(80% 60% at 50% 40%, oklch(from var(--primary) l c h / 0.08), transparent 60%)",
        }}
      />

      <div
        className={cn(
          "relative flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface-elevated transition-transform",
          isDragActive ? "scale-110" : "group-hover:scale-105",
        )}
      >
        <FileAudio
          className={cn(
            "h-7 w-7 transition-colors",
            isDragActive ? "text-primary" : "text-muted-foreground group-hover:text-primary",
          )}
          strokeWidth={1.5}
          aria-hidden
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-1 rounded-2xl opacity-0 transition-opacity",
            isDragActive && "opacity-100 [box-shadow:0_0_24px_4px_oklch(from_var(--primary)_l_c_h/0.45)]",
          )}
        />
      </div>

      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-xl font-medium tracking-tight text-foreground">
          {isDragActive ? "Release to begin" : "Drop an audio file to transcribe"}
        </h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Runs locally on Apple Silicon. Nothing leaves your Mac.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
        {ACCEPTED_EXT.map((ext, i) => (
          <span key={ext} className="flex items-center gap-3">
            {i > 0 && (
              <span
                aria-hidden
                className="h-[3px] w-[3px] rounded-full bg-muted-foreground/30"
              />
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              .{ext}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
