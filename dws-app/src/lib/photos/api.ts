import { collectPages, COLLECTION_PAGE_SIZE } from "./collectionPagination";
import {
  keepPreviousData,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  PhotoAlbum,
  PhotoAlbumSummary,
  PhotoDetail,
  PhotoJobSummary,
  PhotoRow,
} from "./types";

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

export async function fetchJobs(q = "", signal?: AbortSignal): Promise<PhotoJobSummary[]> {
  return collectPages(async (cursor) => {
    const params = new URLSearchParams({ q, limit: String(COLLECTION_PAGE_SIZE) });
    if (cursor !== null) params.set("cursor", cursor);
    const data = await fetchJson<{ jobs: PhotoJobSummary[]; nextCursor: string | null }>(
      `/api/photo-jobs?${params}`, "Failed to load jobs", { signal }
    );
    return { rows: data.jobs, nextCursor: data.nextCursor };
  });
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
    queryFn: ({ signal }) => fetchJobs(q, signal),
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
  for (const key of [
    "photos", "photo-jobs", "photo-tags", "photo-search", "photo-trash",
    "photo-albums", "photo-album", "photo-detail", "photo-albums-deleted", "photo-jobs-deleted",
  ]) {
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

const jobUrl = (id: string) => `/api/photo-jobs/${encodeURIComponent(id)}`;

/** Rename a project; a `jobNumber` also changes its number (409 when another project has it). */
export function renameJob(id: string, name: string, jobNumber?: string) {
  return fetchJson<{ job: PhotoJobRef }>(
    jobUrl(id), "Failed to rename the project",
    jsonInit("PATCH", { name, ...(jobNumber !== undefined ? { job_number: jobNumber } : {}) })
  );
}

/** The project and every photo in it go to Trash for 30 days. */
export function deleteJob(id: string) {
  return fetchJson<{ job: PhotoJobRef; trashed: number }>(jobUrl(id), "Failed to delete the project", { method: "DELETE" });
}

/** Back from Trash, with the photos that went there together with it. */
export function restoreJob(id: string) {
  return fetchJson<{ job: PhotoJobRef; restored: number }>(
    jobUrl(id), "Failed to restore the project", jsonInit("PATCH", { action: "restore" })
  );
}

/** A project deleted in the last 30 days, as the Trash page lists it. */
export interface DeletedJob {
  id: string;
  job_number: string;
  name: string;
  deleted_at: string;
  deleted_by: string | null;
  /** Its photos still in Trash. */
  photo_count: number;
  restore_before: string;
}

export async function fetchDeletedJobs(): Promise<DeletedJob[]> {
  const data = await fetchJson<{ jobs: DeletedJob[] }>(
    "/api/photo-jobs?deleted=1", "Failed to load deleted projects", { cache: "no-store" }
  );
  return data.jobs;
}

// ---- Albums ---------------------------------------------------------------

export async function fetchAlbums(q = "", signal?: AbortSignal): Promise<PhotoAlbumSummary[]> {
  return collectPages(async (cursor) => {
    const params = new URLSearchParams({ q, limit: String(COLLECTION_PAGE_SIZE) });
    if (cursor !== null) params.set("cursor", cursor);
    const data = await fetchJson<{ albums: PhotoAlbumSummary[]; nextCursor: string | null }>(
      `/api/photo-albums?${params}`, "Failed to load albums", { signal }
    );
    return { rows: data.albums, nextCursor: data.nextCursor };
  });
}

/** Album cards, most recently added-to first. Shared by the list, rail, and pickers. */
export function usePhotoAlbums(enabled: boolean, q = "") {
  return useQuery({
    queryKey: ["photo-albums", q],
    queryFn: ({ signal }) => fetchAlbums(q, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** One live album as its page shows it. */
export interface PhotoAlbumHeader {
  id: string;
  name: string;
  photo_count: number;
  created_at: string;
}

export function usePhotoAlbum(albumId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["photo-album", albumId],
    queryFn: async () =>
      (
        await fetchJson<{ album: PhotoAlbumHeader }>(
          `/api/photo-albums/${encodeURIComponent(albumId)}`,
          "Failed to load the album"
        )
      ).album,
    // A deleted album is a 404; asking three more times only delays saying so.
    retry: false,
  });
}

/** An album deleted in the last 30 days, as the Trash page lists it. */
export interface DeletedAlbum {
  id: string;
  name: string;
  deleted_at: string;
  deleted_by: string | null;
  restore_before: string;
}

export async function fetchDeletedAlbums(): Promise<DeletedAlbum[]> {
  const data = await fetchJson<{ albums: DeletedAlbum[] }>(
    "/api/photo-albums?deleted=1",
    "Failed to load deleted albums",
    { cache: "no-store" }
  );
  return data.albums;
}

export function createAlbum(name: string) {
  return fetchJson<{ status: "created"; album: PhotoAlbum }>(
    "/api/photo-albums", "Failed to create the album", jsonInit("POST", { name })
  );
}

const albumUrl = (id: string) => `/api/photo-albums/${encodeURIComponent(id)}`;

export function renameAlbum(id: string, name: string) {
  return fetchJson<{ album: PhotoAlbum }>(albumUrl(id), "Failed to rename the album", jsonInit("PATCH", { name }));
}

export function restoreAlbum(id: string) {
  return fetchJson<{ album: PhotoAlbum }>(albumUrl(id), "Failed to restore the album", jsonInit("PATCH", { action: "restore" }));
}

export function deleteAlbum(id: string) {
  return fetchJson<{ album: PhotoAlbum }>(albumUrl(id), "Failed to delete the album", { method: "DELETE" });
}

/** 1-500 ids; safe to repeat. `missing` counts ids that are trashed or unknown. */
export function addPhotosToAlbum(albumId: string, photoIds: string[]) {
  return fetchJson<{ added: number; already: number; missing: number }>(
    `${albumUrl(albumId)}/photos`, "Failed to add to the album", jsonInit("POST", { photo_ids: photoIds })
  );
}

export function removePhotosFromAlbum(albumId: string, photoIds: string[]) {
  return fetchJson<{ removed: number }>(
    `${albumUrl(albumId)}/photos`, "Failed to remove from the album", jsonInit("DELETE", { photo_ids: photoIds })
  );
}

// ---- Bulk tags, one photo, action batches ----------------------------------

/** Rename one photo. A blank name goes back to the uploaded filename. */
export function renamePhoto(id: string, name: string) {
  return fetchJson<{ photo: PhotoRow }>(
    `/api/photos/${encodeURIComponent(id)}`, "Failed to rename the photo",
    jsonInit("PATCH", { display_name: name.trim() || null })
  );
}

/** `skipped` counts photos the change would push past 20 tags; they are untouched. */
export function bulkTagPhotos(photoIds: string[], change: { add?: string[]; remove?: string[] }) {
  return fetchJson<{ updated: number; skipped: number; missing: number }>(
    "/api/photos/tags", "Failed to tag the photos", jsonInit("POST", { photo_ids: photoIds, ...change })
  );
}

/** One active photo with its albums. Throws when it is trashed or unknown (404). */
export async function fetchPhotoDetail(photoId: string): Promise<PhotoDetail> {
  const data = await fetchJson<{ photo: PhotoDetail }>(
    `/api/photos/${encodeURIComponent(photoId)}`,
    "Photo not found"
  );
  return data.photo;
}

export function usePhotoDetail(photoId: string | null) {
  return useQuery({
    queryKey: ["photo-detail", photoId],
    queryFn: () => fetchPhotoDetail(photoId!),
    enabled: photoId !== null,
    retry: false,
  });
}

/**
 * A draft move or trash of exactly these photos, for the confirm page. Nothing
 * changes until the person confirms there. `destinationJobId: null` on a move
 * means "No project".
 */
export async function createActionBatch(
  input:
    | { action: "trash"; photoIds: string[] }
    | { action: "move"; photoIds: string[]; destinationJobId: string | null }
): Promise<string> {
  const data = await fetchJson<{ batch: { id: string } }>(
    "/api/photo-actions/batches",
    "Could not start that. Try again.",
    jsonInit("POST", {
      action: input.action,
      selector: { photos: input.photoIds.map((photo_id) => ({ photo_id })) },
      ...(input.action === "move" ? { destination_job_id: input.destinationJobId } : {}),
    })
  );
  return data.batch.id;
}

// ---- Delete forever ---------------------------------------------------------

/** What to delete forever. Everything named must already be in Trash. */
export type PurgeRequest =
  | { everything: true }
  | { photo_ids?: string[]; album_ids?: string[]; project_ids?: string[] };

interface PurgeResponse {
  marked: { photos: number; albums: number; projects: number };
  purged: number;
  remaining: number;
  failed: number;
}

/**
 * Delete forever, then keep calling until every marked photo's files are gone.
 * `onProgress` gets the photos removed so far and the number still waiting.
 * Resolves with the photos that could not be removed this time (0 on success);
 * those stay marked and the next delete-forever finishes them.
 */
export async function purgeTrash(
  request: PurgeRequest,
  onProgress?: (removed: number, remaining: number) => void
): Promise<{ marked: PurgeResponse["marked"]; stuck: number }> {
  const call = (body: unknown) =>
    fetchJson<PurgeResponse>("/api/photos/trash/purge", "Failed to delete forever", jsonInit("POST", body));
  let result = await call(request);
  const marked = result.marked;
  let removed = result.purged;
  onProgress?.(removed, result.remaining);
  // Each call works for up to ~45 seconds. Stop when a call makes no progress.
  while (result.remaining > 0 && result.purged > 0) {
    result = await call({});
    removed += result.purged;
    onProgress?.(removed, result.remaining);
  }
  return { marked, stuck: result.remaining };
}
