/**
 * Centralized global key bindings.
 *
 * - `⌘O` → open file
 * - `⌘E` → export menu (signal — the caller decides what to do)
 * - `Space` → toggle play/pause, only when no input/textarea has focus.
 */
import { useEffect } from "react";

interface KeymapOptions {
  onOpenFile?: () => void;
  onExport?: () => void;
  onPlayPause?: () => void;
}

const isEditable = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
};

export function useKeymap(opts: KeymapOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === "o") {
        e.preventDefault();
        opts.onOpenFile?.();
        return;
      }

      if (meta && e.key.toLowerCase() === "e") {
        e.preventDefault();
        opts.onExport?.();
        return;
      }

      if (e.code === "Space" && !meta && !isEditable(document.activeElement)) {
        e.preventDefault();
        opts.onPlayPause?.();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts]);
}
