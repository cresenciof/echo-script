/**
 * Audio playback store. Holds a live reference to the singleton <audio>
 * element. Components consume `currentTime`, `playing`, etc. and call the
 * action methods to drive it.
 *
 * We deliberately keep the audio element *outside* React's render tree —
 * React only sees the state snapshot. The AudioPlayer component is the one
 * place that wires up listeners and reports back via `_setState`.
 */
import { create } from "zustand";

interface AudioState {
  src: string | null;
  currentTime: number;
  duration: number;
  playing: boolean;

  /** Internal — the AudioPlayer component registers the element here. */
  _element: HTMLAudioElement | null;

  registerElement: (el: HTMLAudioElement | null) => void;
  setSource: (src: string | null) => void;
  seekTo: (seconds: number) => void;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;

  /** Internal mutators called by the AudioPlayer event listeners. */
  _setState: (patch: Partial<Pick<AudioState, "currentTime" | "duration" | "playing">>) => void;
}

export const useAudioStore = create<AudioState>((set, get) => ({
  src: null,
  currentTime: 0,
  duration: 0,
  playing: false,
  _element: null,

  registerElement: (el) => set({ _element: el }),

  setSource: (src) => {
    const el = get()._element;
    if (el && src !== get().src) {
      el.src = src ?? "";
    }
    set({ src, currentTime: 0, duration: 0, playing: false });
  },

  seekTo: (seconds) => {
    const el = get()._element;
    if (el && Number.isFinite(seconds)) {
      el.currentTime = Math.max(0, seconds);
      set({ currentTime: el.currentTime });
    }
  },

  togglePlay: () => {
    const { playing, play, pause } = get();
    if (playing) pause();
    else play();
  },

  play: () => {
    const el = get()._element;
    if (!el || !get().src) return;
    void el.play().catch(() => {
      /* play() can reject if interrupted — state will update via listener */
    });
  },

  pause: () => {
    const el = get()._element;
    el?.pause();
  },

  _setState: (patch) => set(patch),
}));
