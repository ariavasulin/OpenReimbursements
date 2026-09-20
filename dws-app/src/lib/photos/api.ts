import {
  keepPreviousData,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
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
    const message = typeof data?.error === "string" ? data.error : data?.error?.message;
    throw new Error(typeof message === "string" ? message : `${fallbackMessage} (${response.status})`);
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

/** All jobs (unfiltered), for job pickers. Shares a cache entry across sheets. */
export function usePhotoJobs(enabled: boolean, q = "") {
  return useQuery({
    queryKey: ["photo-jobs", q],
    queryFn: () => fetchJobs(q),
    enabled,
    staleTime: 60_000,
    // Each debounced prefix is a cold key; keep the list the user is reading
    // (and the rail's active row) on screen until the new one lands.
    placeholderData: keepPreviousData,
  });
}

/** Every tag in use, for tag suggestions. */
export function usePhotoTags(enabled: boolean) {
  return useQuery({
    queryKey: ["photo-tags"],
    queryFn: () => fetchTags(),
    enabled,
  });
}

/** After an upload, edit, or delete: every photo-derived query refetches. */
export function invalidatePhotoCaches(queryClient: QueryClient) {
  for (const key of ["photos", "photo-jobs", "photo-tags", "photo-search", "photo-trash"]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** A job as the create/rename routes return it. */
export interface PhotoJobRef { id: string; job_number: string; name: string; is_active: boolean }

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

/** Create a project by hand. `exists` means that job number was already taken by `job`. */
export function createJob(input: { name: string; job_number?: string }) {
  return fetchJson<{ status: "created" | "exists"; job: PhotoJobRef }>(
    "/api/photo-jobs", "Failed to create the project", jsonInit("POST", input)
  );
}

export function renameJob(id: string, name: string) {
  return fetchJson<{ job: PhotoJobRef }>(
    `/api/photo-jobs/${encodeURIComponent(id)}`, "Failed to rename the project", jsonInit("PATCH", { name })
  );
}
