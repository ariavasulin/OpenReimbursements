// Client-side fetch helpers shared by the photos pages and components.

import type { QueryClient } from "@tanstack/react-query";
import type { PhotoJobSummary } from "./types";

/** fetch + JSON; a non-OK response throws the server's `error` message. */
export async function fetchJson<T>(
  url: string,
  fallbackMessage: string
): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `${fallbackMessage} (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchJobs(q = ""): Promise<PhotoJobSummary[]> {
  const params = q ? `?q=${encodeURIComponent(q)}` : "";
  const data = await fetchJson<{ jobs: PhotoJobSummary[] }>(
    `/api/photo-jobs${params}`,
    "Failed to load jobs"
  );
  return data.jobs;
}

export async function fetchTags(jobId?: string): Promise<string[]> {
  const params = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
  const data = await fetchJson<{ tags: string[] }>(
    `/api/photo-tags${params}`,
    "Failed to load tags"
  );
  return data.tags;
}

/** After an upload, edit, or delete: every photo-derived query refetches. */
export function invalidatePhotoCaches(queryClient: QueryClient) {
  for (const key of ["photos", "photo-jobs", "photo-tags", "photo-search"]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}
