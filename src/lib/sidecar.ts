/**
 * Sidecar base URL resolver.
 *
 * In production Tauri injects `window.__SIDECAR_URL__` after the FastAPI
 * process binds to a free port. In dev (vite without tauri) we fall back to
 * the conventional `127.0.0.1:8765` so the UI is still inspectable in a
 * browser, with a single warning surfaced via the toast system.
 */

const DEV_FALLBACK = "http://127.0.0.1:8765";

let warned = false;

export function getSidecarUrl(): string {
  const fromTauri =
    typeof window !== "undefined" ? window.__SIDECAR_URL__ : undefined;

  if (fromTauri) return fromTauri.replace(/\/+$/, "");

  if (!warned && typeof window !== "undefined") {
    warned = true;
    // Surface a soft warning the first time we fall back. We intentionally
    // do not use console.log per the project rules — the StatusBar component
    // will show an "engine starting" state until health() returns ok.
    window.dispatchEvent(
      new CustomEvent("sidecar:missing", { detail: { fallback: DEV_FALLBACK } }),
    );
  }

  return DEV_FALLBACK;
}

/** Helper to build a fully-qualified URL. */
export function sidecarUrl(path: string): string {
  return `${getSidecarUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
