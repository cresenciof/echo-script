/**
 * Centralized list of file extensions the app accepts.
 *
 * Split into AUDIO and VIDEO so UI surfaces (Dropzone, ExportBar) can branch
 * on which group a file belongs to — e.g. only show "Export with subtitles"
 * for video files.
 */

export const AUDIO_EXTENSIONS = [
  "m4a",
  "mp3",
  "wav",
  "aac",
  "flac",
  "ogg",
  "aiff",
] as const;

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
] as const;

export const ACCEPTED_EXTENSIONS = [
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
] as const;

/** MIME map for `react-dropzone`'s `accept` option (browser-dev fallback). */
export const ACCEPT_MIME: Record<string, string[]> = {
  "audio/*": AUDIO_EXTENSIONS.map((e) => `.${e}`),
  "video/*": VIDEO_EXTENSIONS.map((e) => `.${e}`),
};

function fileExt(pathOrName: string): string {
  const i = pathOrName.lastIndexOf(".");
  if (i < 0) return "";
  return pathOrName.slice(i + 1).toLowerCase();
}

export function isVideoFile(pathOrName: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(fileExt(pathOrName));
}

export function isAudioFile(pathOrName: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(fileExt(pathOrName));
}

export function isAcceptedMediaFile(pathOrName: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(
    fileExt(pathOrName),
  );
}
