import { collectPages, COLLECTION_PAGE_SIZE } from "./collectionPagination";
import type { KeysetDirection } from "@/lib/keysetCursor";
import { MAX_ARRANGE_PHOTOS } from "./apiShared";
import type { PurgeMarked } from "./action-types";
import type { PhotoPermissions } from "./permissions";
import type { PhotoSettings, PhotoSettingsPatch } from "./settings";
import { DEFAULT_STARTER_TAGS } from "./tags";
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

/**
 * GET /api/photos `sort`: newest capture first (`desc`, the default), oldest,
 * or, with `album`, the album's arranged order (`custom`).
 */
export type PhotoSort = KeysetDirection | "custom";

/** One page of GET /api/photos (keyset-paginated). */
export interface PhotosPage {
  photos: PhotoRow[];
  nextCursor: string | null;
}

export function fetchPhotosPage(params: URLSearchParams): Promise<PhotosPage> {
  return fetchJson<PhotosPage>(`/api/photos?${params}`, "Failed to load photos");
}

/**
 * GET /api/photos/ids: every photo the same parameters list (no cursor), in
 * the grid's order, at most MAX_SELECTION_PHOTOS of them. `truncated` when
 * `total` matched more than `ids` holds.
 */
export interface PhotoIdsAnswer {
  ids: string[];
  total: number;
  truncated: boolean;
}

export function fetchPhotoIds(params: URLSearchParams): Promise<PhotoIdsAnswer> {
  return fetchJson<PhotoIdsAnswer>(`/api/photos/ids?${params}`, "Could not select those photos");
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

/** Tags in use, for tag suggestions: one project's when `jobId` is given, else every tag. */
export function usePhotoTags(enabled: boolean, jobId?: string | null) {
  return useQuery({
    queryKey: ["photo-tags", jobId || ""],
    queryFn: () => fetchTags(jobId || undefined),
    enabled,
  });
}

/** The query key of the signed-in person's photo permissions. */
export const PHOTO_ACTOR_KEY = ["photo-actor"] as const;

/**
 * The signed-in employee's photo permissions (GET /api/photos/actor), for
 * showing Trash, Delete forever, Empty trash, and project or album Delete only
 * where they will work. Undefined while loading: callers show nothing they
 * cannot yet promise. The server checks every write regardless.
 *
 * The "Photo admin" box can be ticked in another tab, or for this person by
 * someone else, so coming back to the tab asks again even inside the 30
 * seconds — a one-row read — rather than keep offering yesterday's controls.
 */
export function usePhotoActor() {
  return useQuery({
    queryKey: PHOTO_ACTOR_KEY,
    queryFn: () => fetchJson<PhotoPermissions>("/api/photos/actor", "Failed to load your permissions"),
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
  }).data;
}

/** After the Users page saves someone's role or "Photo admin" box: the next screen asks again. */
export function invalidatePhotoActor(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: PHOTO_ACTOR_KEY });
}

/** The query key of the settings: the default tags and the person's slideshow setting. */
export const PHOTO_SETTINGS_KEY = ["photo-settings"] as const;

/**
 * GET /api/photos/settings: the app-wide default tags and the signed-in
 * person's slideshow setting. Undefined while loading; the pickers fall back
 * to DEFAULT_STARTER_TAGS and the viewer to DEFAULT_SLIDESHOW until then.
 */
export function usePhotoSettings() {
  return useQuery({
    queryKey: PHOTO_SETTINGS_KEY,
    queryFn: () => fetchJson<PhotoSettings>("/api/photos/settings", "Failed to load settings"),
    staleTime: 60_000,
  }).data;
}

/** The default tags every tag picker offers, as a photo admin set them. */
export function usePhotoStarterTags(): readonly string[] {
  return usePhotoSettings()?.starter_tags ?? DEFAULT_STARTER_TAGS;
}

/** PATCH /api/photos/settings; answers the whole settings object. The caller sets the query to it. */
export function savePhotoSettings(patch: PhotoSettingsPatch): Promise<PhotoSettings> {
  return fetchJson<PhotoSettings>("/api/photos/settings", "Could not save settings", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
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

/** A project in Trash, as the Trash page lists it. */
export interface DeletedJob {
  id: string;
  job_number: string;
  name: string;
  deleted_at: string;
  deleted_by: string | null;
  /** The photos a restore brings back: those trashed together with it. */
  photo_count: number;
  /** After this it can only be deleted forever. */
  restore_before: string;
}

/** `truncated` when there were more deleted projects than the list returns. */
export function fetchDeletedJobs(): Promise<{ jobs: DeletedJob[]; truncated: boolean }> {
  return fetchJson<{ jobs: DeletedJob[]; truncated: boolean }>(
    "/api/photo-jobs?deleted=1", "Failed to load deleted projects", { cache: "no-store" }
  );
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

/** Album cards, by name A to Z. Shared by the list, rail, and pickers. */
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
  /** Who made it: they and photo admins may delete it. */
  created_by: string;
  /** `custom` while the album shows its arranged order, for everyone. */
  sort_mode: "date" | "custom";
  /** An arranged order is saved (kept when the album goes back to date order). */
  has_custom_order: boolean;
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

/** Save the album's whole order (every active photo, each once): it then shows that order to everyone. */
export function saveAlbumOrder(id: string, photoIds: string[]) {
  return fetchJson<{ sort_mode: "custom" }>(
    `${albumUrl(id)}/order`, "Failed to save the order", jsonInit("PATCH", { photo_ids: photoIds })
  );
}

/** Put the album back in date order for everyone; its arranged order is kept. */
export function setAlbumDateOrder(id: string) {
  return fetchJson<{ sort_mode: "date" }>(
    `${albumUrl(id)}/order`, "Failed to change the order", jsonInit("PATCH", { sort_mode: "date" })
  );
}

/**
 * Show the album's saved arranged order again: read it (photos added since go
 * last) and save it as the order. Throws when the album is too big to arrange.
 */
export async function restoreAlbumOrder(id: string) {
  const params = new URLSearchParams({ album: id, sort: "custom" });
  const { ids, total } = await fetchPhotoIds(params);
  if (total > MAX_ARRANGE_PHOTOS || ids.length !== total) {
    throw new Error(`Only albums of up to ${MAX_ARRANGE_PHOTOS.toLocaleString("en-US")} photos can be arranged.`);
  }
  return saveAlbumOrder(id, ids);
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

// ---- Favorites ---------------------------------------------------------------

/** POST /api/photos/favorites: the signed-in person's own favorites, on or off, up to 500 ids. */
export function setFavorites(photoIds: string[], on: boolean) {
  return fetchJson<{ updated: number }>(
    "/api/photos/favorites", on ? "Could not add to favorites" : "Could not remove from favorites",
    jsonInit("POST", { photo_ids: photoIds, on })
  );
}

/**
 * Mark `photoIds` as `me`'s favorites (or not) in every cached grid, search,
 * and detail, without a refetch: a heart should fill the moment it is tapped.
 * A grid filtered to favorites keeps an unfavorited photo in place until it
 * is next loaded, so the viewer does not lose its slide; it is marked stale.
 */
export function patchFavorites(queryClient: QueryClient, photoIds: readonly string[], me: string, on: boolean) {
  const ids = new Set(photoIds);
  const patch = (photo: PhotoRow): PhotoRow =>
    ids.has(photo.id) ? { ...photo, favorites: on ? [{ user_id: me }] : [] } : photo;
  for (const prefix of ["photos", "photo-search"]) {
    queryClient.setQueriesData<{ pages: PhotosPage[]; pageParams: unknown[] }>({ queryKey: [prefix] }, (data) =>
      data && { ...data, pages: data.pages.map((page) => ({ ...page, photos: page.photos.map(patch) })) }
    );
  }
  for (const id of ids) {
    queryClient.setQueryData<PhotoDetail>(["photo-detail", id], (photo) => photo && (patch(photo) as PhotoDetail));
  }
  void queryClient.invalidateQueries({
    predicate: (query) => typeof query.queryKey[2] === "string" && query.queryKey[2].includes("favorites=1"),
    refetchType: "none",
  });
}

// ---- Bulk tags, one photo, action batches ----------------------------------

/** Rename one photo. A blank name goes back to the automatic name. */
export function renamePhoto(id: string, name: string) {
  return fetchJson<{ photo: PhotoRow }>(
    `/api/photos/${encodeURIComponent(id)}`, "Failed to rename the photo",
    jsonInit("PATCH", { display_name: name })
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
  marked: PurgeMarked;
  purged: number;
  remaining: number;
  failed: number;
}

/**
 * Delete forever, then keep calling until every marked photo's files are gone.
 * `onProgress` gets the photos removed so far and the number still waiting.
 * Resolves with the photos that could not be removed this time (0 on success);
 * those stay marked; a `{}` request finishes them.
 */
export async function purgeTrash(
  request: PurgeRequest,
  onProgress?: (removed: number, remaining: number) => void
): Promise<{ marked: PurgeMarked; stuck: number }> {
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
