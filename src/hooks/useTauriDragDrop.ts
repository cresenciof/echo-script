/**
 * Native Tauri drag-and-drop integration.
 *
 * Tauri 2 on macOS intercepts file drops at the OS level — the WebView never
 * sees HTML5 `dragenter`/`dragover`/`drop` events. `react-dropzone` is
 * therefore silent for files coming from Finder. The official replacement is
 * `getCurrentWindow().onDragDropEvent(...)`, which delivers the absolute
 * filesystem paths and an `enter`/`over`/`drop`/`leave` lifecycle we can use
 * to render a drag overlay.
 *
 * This hook is a no-op in browser dev (no Tauri runtime), so `react-dropzone`
 * keeps working for `pnpm dev` against vite directly.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type DragState = "idle" | "over";

interface UseTauriDragDropOpts {
  /** Called once per drop with the absolute filesystem paths Finder handed us. */
  onDrop: (paths: string[]) => void;
  /** When false, drops are ignored (e.g. engine not ready). Overlay is still
   *  shown so the user gets visual feedback, but `onDrop` is suppressed. */
  enabled?: boolean;
}

/**
 * Registers a single global listener on the main webview window. Returns the
 * current drag state so any component can show its own visual treatment.
 */
export function useTauriDragDrop({
  onDrop,
  enabled = true,
}: UseTauriDragDropOpts): DragState {
  const [dragState, setDragState] = useState<DragState>("idle");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | null = null;

    const register = async () => {
      try {
        unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          const t = event.payload.type;
          if (t === "enter" || t === "over") {
            setDragState("over");
          } else if (t === "leave") {
            setDragState("idle");
          } else if (t === "drop") {
            setDragState("idle");
            if (!enabled) return;
            const paths = (event.payload as { paths?: string[] }).paths ?? [];
            if (paths.length > 0) onDrop(paths);
          }
        });
      } catch {
        // Out of Tauri — leave dragState idle; no-op.
      }
    };

    register();
    return () => {
      unlisten?.();
    };
  }, [onDrop, enabled]);

  return dragState;
}
