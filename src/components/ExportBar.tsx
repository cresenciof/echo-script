/**
 * Bottom action bar shown when a job has finished. Lets the user export the
 * transcript in TXT / SRT / VTT / MD or copy everything to clipboard.
 *
 * Uses the Tauri save dialog. In a plain browser we fall back to a Blob
 * download (handy in dev).
 */
import { save } from "@tauri-apps/plugin-dialog";
import {
  ClipboardCheck,
  Copy,
  Download,
  FileCode2,
  Film,
  Flame,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { SubtitleExportDialog } from "@/components/SubtitleExportDialog";
import type { SubtitleMode } from "@/components/SubtitleModeOption";
import { Button } from "@/components/ui/button";
import { useExporter } from "@/hooks/useExporter";
import { isVideoFile } from "@/lib/audioFormats";
import { cn } from "@/lib/utils";
import type { UIJob } from "@/types/domain";

/**
 * `@tauri-apps/plugin-fs` is intentionally NOT bundled. Instead, we let the
 * user pick a save location with the native dialog (so they see the proper
 * macOS save sheet) and then trigger a Blob download. WebKit honors the
 * `download` attribute and writes the file to the user's Downloads folder.
 * The dialog path is recorded only for the toast message — exporting to an
 * arbitrary folder needs a Rust command, which is explicitly out of scope.
 */

interface ExportBarProps {
  job: UIJob;
  editing: boolean;
  onToggleEdit: () => void;
}

interface ExportFormat {
  id: "txt" | "srt" | "vtt" | "md";
  label: string;
  ext: string;
}

const FORMATS: ExportFormat[] = [
  { id: "txt", label: "TXT", ext: "txt" },
  { id: "srt", label: "SRT", ext: "srt" },
  { id: "vtt", label: "VTT", ext: "vtt" },
  { id: "md", label: "MD", ext: "md" },
];

function downloadBlob(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportBar({ job, editing, onToggleEdit }: ExportBarProps) {
  const exporter = useExporter(job);
  const [copied, setCopied] = useState(false);
  const [subsMode, setSubsMode] = useState<SubtitleMode | null>(null);
  const disabled = !exporter || job.status !== "done";
  const isVideo = isVideoFile(job.audio_path);

  const baseName = job.filename.replace(/\.[^/.]+$/, "");

  const handleExport = async (fmt: ExportFormat) => {
    if (!exporter) return;
    const contents = exporter[fmt.id];
    const defaultName = `${baseName}.${fmt.ext}`;
    let outName = defaultName;
    try {
      const chosen = await save({
        title: `Export as ${fmt.label}`,
        defaultPath: defaultName,
        filters: [{ name: fmt.label, extensions: [fmt.ext] }],
      });
      if (chosen === null) return; // user cancelled
      if (typeof chosen === "string") {
        outName = chosen.split(/[\\/]/).pop() ?? defaultName;
      }
    } catch {
      // Browser fallback — just use the default name.
    }
    downloadBlob(outName, contents);
    toast.success(`Exported ${fmt.label}`);
  };

  const handleCopy = async () => {
    if (!exporter) return;
    try {
      await navigator.clipboard.writeText(exporter.txt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
      toast.success("Transcript copied to clipboard");
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface-elevated px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          Export
        </span>
        <span className="h-3 w-px bg-border" aria-hidden />
        {FORMATS.map((fmt) => (
          <Button
            key={fmt.id}
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => handleExport(fmt)}
            className="h-7 gap-1.5 border-border bg-card px-2.5 font-mono text-[10.5px] uppercase tracking-wider"
          >
            <Download className="h-3 w-3" aria-hidden />
            {fmt.label}
          </Button>
        ))}
        {isVideo && (
          <>
            <span className="h-3 w-px bg-border" aria-hidden />
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setSubsMode("soft")}
              title="Embed an extra subtitle track. Toggleable in QuickTime / VLC."
              className="h-7 gap-1.5 border-border bg-card px-2.5 font-mono text-[10.5px] uppercase tracking-wider"
            >
              <Film className="h-3 w-3" aria-hidden />
              Soft subs
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setSubsMode("burn")}
              title="Re-encode the video with subtitles rendered into the picture. Takes minutes."
              className="h-7 gap-1.5 border-primary/40 bg-primary/10 px-2.5 font-mono text-[10.5px] uppercase tracking-wider text-primary hover:bg-primary/15"
            >
              <Flame className="h-3 w-3" aria-hidden />
              Burn-in
            </Button>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleEdit}
          disabled={job.status !== "done"}
          className={cn(
            "h-7 gap-1.5 px-2.5 text-[12px]",
            editing && "bg-primary/15 text-primary",
          )}
        >
          <FileCode2 className="h-3.5 w-3.5" aria-hidden />
          {editing ? "Done editing" : "Edit"}
        </Button>

        <Button
          variant="default"
          size="sm"
          onClick={handleCopy}
          disabled={disabled}
          className="h-7 gap-1.5 bg-primary px-2.5 text-[12px] text-primary-foreground hover:bg-primary/90"
        >
          {copied ? (
            <ClipboardCheck className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          {copied ? "Copied" : "Copy all"}
        </Button>
      </div>

      {isVideo && (
        <SubtitleExportDialog
          job={job}
          open={subsMode !== null}
          onOpenChange={(o) => !o && setSubsMode(null)}
          defaultMode={subsMode ?? "soft"}
          lockMode
        />
      )}
    </div>
  );
}
