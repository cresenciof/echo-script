/**
 * Typed HTTP client wrapping fetch against the sidecar.
 */
import { sidecarUrl } from "./sidecar";
import type {
  HealthResponse,
  JobDetail,
  ModelsResponse,
  TranscribeAccepted,
  TranscribeRequest,
} from "@/types/domain";

class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 8_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(sidecarUrl(path), {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const detail =
        typeof body === "object" && body && "detail" in body
          ? String((body as { detail?: unknown }).detail)
          : res.statusText;
      throw new ApiError(res.status, body, detail);
    }

    return body as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>("/health", undefined, 4_000);
  },
  getModels(): Promise<ModelsResponse> {
    return request<ModelsResponse>("/models");
  },
  startTranscription(req: TranscribeRequest): Promise<TranscribeAccepted> {
    return request<TranscribeAccepted>("/transcribe", {
      method: "POST",
      body: JSON.stringify(req),
    });
  },
  getJob(id: string): Promise<JobDetail> {
    return request<JobDetail>(`/jobs/${encodeURIComponent(id)}`);
  },
};

export { ApiError };
