/**
 * Time formatters used across the app.
 * All inputs are seconds (float). Negative or non-finite values clamp to 0.
 */

const clamp = (n: number): number =>
  !Number.isFinite(n) || n < 0 ? 0 : n;

/** "12:34" or "1:02:34" — for status bars and segment headers. */
export function formatHMS(seconds: number): string {
  const total = Math.floor(clamp(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "00:12:34,560" — SRT format with comma decimal separator. */
export function formatSRTTime(seconds: number): string {
  const v = clamp(seconds);
  const total = Math.floor(v);
  const ms = Math.round((v - total) * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** "00:12:34.560" — WebVTT format with dot decimal separator. */
export function formatVTTTime(seconds: number): string {
  return formatSRTTime(seconds).replace(",", ".");
}

/** "12:34" — short timestamp shown next to each segment in the UI. */
export function formatSegmentTime(seconds: number): string {
  const total = Math.floor(clamp(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Format a byte count as a human-readable string using decimal (SI) units —
 * matches the units `huggingface_hub` reports via tqdm so the UI numbers
 * line up with what the server saw. "512 MB", "1.6 GB", "103 KB".
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let value = n;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  // 1 decimal once we're past KB so "1.6 GB" reads naturally; whole numbers
  // for B/KB where fractional digits add noise.
  const formatted = i >= 2 ? value.toFixed(1) : Math.round(value).toString();
  return `${formatted} ${units[i]}`;
}

/** Estimated time remaining given elapsed wall time and progress. */
export function estimateRemaining(
  elapsedMs: number,
  currentS: number,
  totalS: number,
): number | null {
  if (currentS <= 0 || totalS <= 0 || elapsedMs <= 0) return null;
  const ratePerSecond = currentS / (elapsedMs / 1000);
  if (ratePerSecond <= 0) return null;
  const remainingAudioS = Math.max(0, totalS - currentS);
  return remainingAudioS / ratePerSecond;
}
