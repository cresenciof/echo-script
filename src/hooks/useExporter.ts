/**
 * Pure formatters that turn a job into exportable strings.
 * Stays decoupled from the file-system layer — the ExportBar component
 * is the one that asks Tauri for a save path.
 */
import { useMemo } from "react";
import { formatHMS, formatSRTTime, formatVTTTime } from "@/lib/timeFormat";
import type { UIJob } from "@/types/domain";

export interface ExportPayloads {
  txt: string;
  srt: string;
  vtt: string;
  md: string;
}

function buildTxt(job: UIJob): string {
  if (job.segments.length === 0) return job.text.trim();
  return job.segments.map((s) => s.text.trim()).join("\n");
}

function buildSrt(job: UIJob): string {
  return job.segments
    .map((seg, i) => {
      return [
        String(i + 1),
        `${formatSRTTime(seg.start)} --> ${formatSRTTime(seg.end)}`,
        seg.text.trim(),
        "",
      ].join("\n");
    })
    .join("\n");
}

function buildVtt(job: UIJob): string {
  const cues = job.segments
    .map((seg, i) => {
      return [
        `${i + 1}`,
        `${formatVTTTime(seg.start)} --> ${formatVTTTime(seg.end)}`,
        seg.text.trim(),
        "",
      ].join("\n");
    })
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}

function buildMd(job: UIJob): string {
  const title = job.filename.replace(/\.[^/.]+$/, "");
  const meta = [
    `# ${title}`,
    "",
    `- Model: \`${job.model}\``,
    job.language ? `- Language: \`${job.language}\`` : null,
    job.audio_duration_s ? `- Duration: ${formatHMS(job.audio_duration_s)}` : null,
    "",
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const body =
    job.segments.length > 0
      ? job.segments
          .map(
            (seg) =>
              `**[${formatHMS(seg.start)}]** ${seg.text.trim()}`,
          )
          .join("\n\n")
      : job.text;

  return `${meta}\n${body}\n`;
}

export function useExporter(job: UIJob | null): ExportPayloads | null {
  return useMemo<ExportPayloads | null>(() => {
    if (!job) return null;
    return {
      txt: buildTxt(job),
      srt: buildSrt(job),
      vtt: buildVtt(job),
      md: buildMd(job),
    };
  }, [job]);
}
