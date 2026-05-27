/**
 * Polls the sidecar `/health` endpoint until it answers, then switches
 * to a slow keep-alive cadence. Used by the StatusBar and the App shell
 * to surface a "Starting transcription engine…" banner.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.getHealth(),
    refetchInterval: (q) => (q.state.data ? 15_000 : 1_000),
    retry: false,
    staleTime: 0,
  });
}
