/**
 * Runtime globals injected by the Tauri shell.
 *
 * The Rust setup hook will resolve a free TCP port for the Python FastAPI
 * sidecar, spawn it, and inject `window.__SIDECAR_URL__` with the full base
 * URL (e.g. `http://127.0.0.1:54321`). The HTTP/SSE client agent will read
 * this value to build requests.
 */
export {};

declare global {
  interface Window {
    __SIDECAR_URL__?: string;
  }
}
