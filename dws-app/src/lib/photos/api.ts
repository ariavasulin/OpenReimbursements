import type { QueryClient } from "@tanstack/react-query";
import type { PhotoJobSummary, PhotoRow } from "./types";

/** fetch + JSON; a non-OK response throws the server's `error` message. */
export async function fetchJson<T>(
  url: string,
  fallbackMessage: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `${fallbackMessage} (${response.status})`);
  }
  return (await response.json()) as T;
}

/** One page of GET /api/photos (keyset-paginated). */
export interface PhotosPage {
  photos: PhotoRow[];
  nextCursor: string | null;
}

export function fetchPhotosPage(params: URLSearchParams): Promise<PhotosPage> {
  return fetchJson<PhotosPage>(`/api/photos?${params}`, "Failed to load photos");
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
