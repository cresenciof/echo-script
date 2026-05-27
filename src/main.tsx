import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { Toaster } from "sonner";

import App from "./App";

// Geist Sans + Geist Mono — distinctive but neutral enough for a tool.
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";

import "./styles.css";

document.documentElement.classList.add("dark");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * Resolve the sidecar URL BEFORE React mounts. The Rust setup hook spawns
 * the Python sidecar and stores its URL in managed state. Reading it via
 * the `get_sidecar_url` IPC command is the only way to avoid the race
 * where the React tree fires `/health` before Rust finishes injecting
 * `window.__SIDECAR_URL__`.
 *
 * Retries every 250 ms for up to ~8 s. If we're not running inside Tauri
 * (vite-only dev), we skip straight to rendering and let the dev fallback
 * URL handle it.
 */
async function resolveSidecarUrlBeforeMount(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.__SIDECAR_URL__) return;

  const inTauri = "__TAURI_INTERNALS__" in window;
  if (!inTauri) return;

  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      const url = await invoke<string>("get_sidecar_url");
      window.__SIDECAR_URL__ = url;
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  // Eight seconds without a URL — fall through. The UI will show
  // "Engine offline" and the user can restart the app.
}

resolveSidecarUrlBeforeMount().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster
          richColors
          position="bottom-right"
          theme="dark"
          toastOptions={{
            classNames: {
              toast:
                "border border-border bg-card text-card-foreground shadow-lg font-sans",
            },
          }}
        />
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
