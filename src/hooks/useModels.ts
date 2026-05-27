/**
 * TanStack Query hook for the model catalog.
 * staleTime 5min — the catalog rarely changes mid-session.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ModelsResponse } from "@/types/domain";

export function useModels() {
  return useQuery<ModelsResponse>({
    queryKey: ["models"],
    queryFn: () => api.getModels(),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
