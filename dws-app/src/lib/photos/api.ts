import { collectPages, COLLECTION_PAGE_SIZE } from "./collectionPagination";
import type { KeysetDirection } from "@/lib/keysetCursor";
import { MAX_ARRANGE_PHOTOS } from "./apiShared";
import type { PurgeMarked } from "./action-types";
import { NO_FILTERS, withFilterParams, type BrowseFilters } from "./browse-state";
import { applyTagChange, editGrid, isCachedGrid, listFiltersByTag } from "./cache-patch";
import type { PhotoPermissions } from "./permissions";
import type { PhotoSettings, PhotoSettingsPatch } from "./settings";
import { DEFAULT_STARTER_TAGS } from "./tags";
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  PhotoAlbum,
  PhotoAlbumRef,
  PhotoAlbumSummary,
  PhotoDetail,
  PhotoJobSummary,
  PhotoRow,
} from "./types";

// ---- Fetching -----------------------------------------------------------------

/** A read gives up after this long: a phone on a stalled connection otherwise waits forever. */
export const READ_TIMEOUT_MS = 20_000;

/** What a failed or stalled connection reads as, instead of the browser's "Failed to fetch". */
export const NO_CONNECTION_MESSAGE = "No connection — check your signal and try again";

/** What a list shows while React Query holds its request until the phone is back online. */
export const WAITING_FOR_CONNECTION = "Waiting for connection...";

/** A non-OK answer, with its HTTP status so a caller can tell "not found" from a failure. */
export class FetchJsonError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * The caller's signal plus a READ_TIMEOUT_MS deadline, as one signal. Built by
 * hand rather than with AbortSignal.any/timeout, which iPhones before iOS 17.4
 * do not have. `done()` stops the clock once the body is read.
 */
function readDeadline(outer: AbortSignal | null | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, READ_TIMEOUT_MS);
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    },
  };
}

/**
 * fetch + JSON; a non-OK response throws the server's `error` message (as a
 * FetchJsonError carrying the status). A dropped or stalled connection throws
 * NO_CONNECTION_MESSAGE; a cancel by the caller's own signal is passed on as it is.
 *
 * Only GET reads time out. This also carries writes (trash, tags, a purge call
 * that runs up to 60 seconds), and giving up on a write the server may still
 * finish would report a failure for a change that happened.
 */
export async function fetchJson<T>(
  url: string,
  fallbackMessage: string,
  init?: RequestInit
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const deadline = method === "GET" ? readDeadline(init?.signal) : null;
  try {
    const response = await fetch(url, deadline ? { ...init, signal: deadline.signal } : init);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const message = typeof data?.error === "string" ? data.error : data?.error?.message;
      throw new FetchJsonError(
        typeof message === "string" ? message : `${fallbackMessage} (${response.status})`,
        response.status
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    // fetch rejects with a TypeError when the network is down or drops mid-way.
    if (deadline?.timedOut() || error instanceof TypeError) throw new Error(NO_CONNECTION_MESSAGE);
    throw error;
  } finally {
    deadline?.done();
  }
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

export function fetchPhotosPage(params: URLSearchParams, signal?: AbortSignal): Promise<PhotosPage> {
  return fetchJson<PhotosPage>(`/api/photos?${params}`, "Failed to load photos", { signal });
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

export function fetchPhotoIds(params: URLSearchParams, signal?: AbortSignal): Promise<PhotoIdsAnswer> {
  return fetchJson<PhotoIdsAnswer>(`/api/photos/ids?${params}`, "Could not select those photos", { signal });
}

/**
 * How many photos the same parameters list, for the "Select all N" label:
 * GET /api/photos/ids with `count=1`, which answers the count without walking
 * every id. (A server that does not know `count=1` sends the ids too; the
 * total is read the same way.)
 */
export async function fetchPhotoCount(params: URLSearchParams, signal?: AbortSignal): Promise<number> {
  const counting = new URLSearchParams(params);
  counting.set("count", "1");
  const { total } = await fetchJson<{ total: number }>(
    `/api/photos/ids?${counting}`, "Could not count those photos", { signal }
  );
  return total;
}

// ---- Query keys ------------------------------------------------------------------

/** What one photo grid lists: every photo, an album, a project, or a search. */
export type PhotoListScope =
  | { kind: "all" }
  | { kind: "album"; album: PhotoAlbumRef }
  | { kind: "job"; jobId: string }
  | { kind: "search"; q: string };

/** A search grid's pages live under their own prefix; every other grid's under "photos". */
const gridPrefix = (scope: PhotoListScope) => (scope.kind === "search" ? "photo-search" : "photos");

/** One grid's place in the cache: a new album, project, or search is a new screen. */
export const scopeKey = (scope: PhotoListScope): string =>
  scope.kind === "album"
    ? `album:${scope.album.id}`
    : scope.kind === "job"
      ? `job:${scope.jobId}`
      : scope.kind === "search"
        ? `search:${scope.q}`
        : "all";

/** The scope as GET /api/photos parameters (the filters are added by withFilterParams). */
export function scopeParams(scope: PhotoListScope): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.kind === "album") params.set("album", scope.album.id);
  if (scope.kind === "job") params.set("job", scope.jobId);
  if (scope.kind === "search") params.set("q", scope.q);
  return params;
}

/** Exactly what a grid lists, for GET /api/photos and /ids alike. */
export function photoListParams(scope: PhotoListScope, filters: BrowseFilters, sort: PhotoSort): URLSearchParams {
  return withFilterParams(scopeParams(scope), filters, sort);
}

/**
 * Every photo query key, in one place, so a fetch, a prefetch, and an edit
 * that updates the cache all name the same entry. `listKey` is a grid's list
 * parameters as a string (photoListParams(...).toString()).
 */
export const photoKeys = {
  /** Every grid and search page list, and their "Select all" answers. */
  grids: ["photos"] as const,
  searches: ["photo-search"] as const,
  list: (scope: PhotoListScope, listKey: string) => [gridPrefix(scope), scopeKey(scope), listKey] as const,
  /** Under the grid's own prefix, so an edit that refreshes the grid reaches them. */
  ids: (scope: PhotoListScope, listKey: string) => [gridPrefix(scope), scopeKey(scope), listKey, "ids"] as const,
  count: (scope: PhotoListScope, listKey: string) => [gridPrefix(scope), scopeKey(scope), listKey, "count"] as const,
  detail: (photoId: string | null) => ["photo-detail", photoId] as const,
  details: ["photo-detail"] as const,
  /** Project cards. Each search prefix is its own entry. */
  jobs: (q = "") => ["photo-jobs", q] as const,
  allJobs: ["photo-jobs"] as const,
  /** The first few project matches, for the search box. */
  jobSuggestions: (q: string, limit: number) => ["photo-jobs", q, `first:${limit}`] as const,
  job: (jobId: string) => ["photo-job", jobId] as const,
  jobHeaders: ["photo-job"] as const,
  albums: (q = "") => ["photo-albums", q] as const,
  allAlbums: ["photo-albums"] as const,
  albumSuggestions: (q: string, limit: number) => ["photo-albums", q, `first:${limit}`] as const,
  album: (albumId: string) => ["photo-album", albumId] as const,
  albumHeaders: ["photo-album"] as const,
  /** One project's tags in use, or every tag (""). */
  tags: (jobId?: string | null) => ["photo-tags", jobId || ""] as const,
  allTags: ["photo-tags"] as const,
  trash: ["photo-trash"] as const,
  deletedAlbums: ["photo-albums-deleted"] as const,
  deletedJobs: ["photo-jobs-deleted"] as const,
};

/** A key's last part names a "Select all" answer: ids or their count. */
const isSelectAllKey = (queryKey: QueryKey) => {
  const last = queryKey[queryKey.length - 1];
  return last === "ids" || last === "count";
};

/**
 * One grid's pages: its key and fetcher, shared by the grid itself and the
 * prefetch a project card starts when the pointer reaches it. The grid adds
 * its own `enabled` and `placeholderData`.
 */
export function photoListOptions(scope: PhotoListScope, filters: BrowseFilters, sort: PhotoSort) {
  const listKey = photoListParams(scope, filters, sort).toString();
  return infiniteQueryOptions({
    queryKey: photoKeys.list(scope, listKey),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(listKey);
      if (pageParam) params.set("cursor", pageParam);
      return fetchPhotosPage(params, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: PhotosPage) => lastPage.nextCursor,
  });
}

/** Every id one grid (or one group of it: narrowed `params`) lists, for "Select all" and a group tick. */
export function photoIdsOptions(scope: PhotoListScope, params: URLSearchParams) {
  return queryOptions({
    queryKey: photoKeys.ids(scope, params.toString()),
    queryFn: ({ signal }) => fetchPhotoIds(params, signal),
    staleTime: 30_000,
  });
}

/** How many photos one grid lists: all the "Select all N" label needs until it is clicked. */
export function photoCountOptions(scope: PhotoListScope, params: URLSearchParams) {
  return queryOptions({
    queryKey: photoKeys.count(scope, params.toString()),
    queryFn: ({ signal }) => fetchPhotoCount(params, signal),
    staleTime: 30_000,
  });
}

// ---- Projects -------------------------------------------------------------------

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

/** The first `limit` projects matching `q`, in one request (no paging on). */
export async function fetchJobsPage(q: string, limit: number, signal?: AbortSignal): Promise<PhotoJobSummary[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const data = await fetchJson<{ jobs: PhotoJobSummary[] }>(`/api/photo-jobs?${params}`, "Failed to load jobs", { signal });
  return data.jobs;
}

export async function fetchTags(jobId?: string, signal?: AbortSignal): Promise<string[]> {
  const params = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
  const data = await fetchJson<{ tags: string[] }>(
    `/api/photo-tags${params}`,
    "Failed to load tags",
    { signal }
  );
  return data.tags;
}

/** All jobs (unfiltered), for job pickers. Shares a cache entry across sheets. */
export function usePhotoJobs(enabled: boolean, q = "") {
  return useQuery({
    queryKey: photoKeys.jobs(q),
    queryFn: ({ signal }) => fetchJobs(q, signal),
    enabled,
    staleTime: 60_000,
    // Each debounced prefix is a cold key; keep the list the user is reading
    // (and the rail's active row) on screen until the new one lands.
    placeholderData: keepPreviousData,
  });
}

/**
 * The search box's project matches: at most `limit` of them, in one small
 * request per typed prefix, instead of every match page after page. Ask for
 * one more than you show to know whether there are more.
 */
export function usePhotoJobSuggestions(enabled: boolean, q: string, limit: number) {
  return useQuery({
    queryKey: photoKeys.jobSuggestions(q, limit),
    queryFn: ({ signal }) => fetchJobsPage(q, limit, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Any cached list's card for this project: the Projects list, the rail, a search. */
function jobFromLists(queryClient: QueryClient, jobId: string): PhotoJobSummary | undefined {
  const exact = queryClient.getQueryData<PhotoJobSummary[]>(photoKeys.jobs(""));
  const hit = exact?.find((job) => job.id === jobId);
  if (hit) return hit;
  for (const [, jobs] of queryClient.getQueriesData<PhotoJobSummary[]>({ queryKey: photoKeys.allJobs })) {
    const found = Array.isArray(jobs) ? jobs.find((job) => job.id === jobId) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * GET /api/photo-jobs/[id]: one active project as its card shows it. Null when
 * it is deleted or unknown (404), or the id is not one (400).
 */
export async function fetchJob(jobId: string, signal?: AbortSignal): Promise<PhotoJobSummary | null> {
  try {
    return (await fetchJson<{ job: PhotoJobSummary }>(jobUrl(jobId), "Failed to load the project", { signal })).job;
  } catch (error) {
    if (error instanceof FetchJsonError && (error.status === 404 || error.status === 400)) return null;
    // A deploy without the one-project read answers 405: find it in the full list, as before.
    if (error instanceof FetchJsonError && error.status === 405) {
      return (await fetchJobs("", signal)).find((job) => job.id === jobId) ?? null;
    }
    throw error;
  }
}

/**
 * One project for its page header and the shell's label. Shown at once from
 * any list already in cache (opened from Projects, the rail, or search), and
 * otherwise read by itself, so the header never waits for every project.
 * `data` is null once the server says the project is not there.
 */
export function usePhotoJob(jobId: string | null) {
  const queryClient = useQueryClient();
  return useQuery<PhotoJobSummary | null>({
    queryKey: photoKeys.job(jobId ?? ""),
    queryFn: ({ signal }) => fetchJob(jobId!, signal),
    enabled: jobId !== null,
    staleTime: 60_000,
    placeholderData: () => (jobId === null ? undefined : jobFromLists(queryClient, jobId)),
  });
}

/** Tags in use, for tag suggestions: one project's when `jobId` is given, else every tag. */
export function usePhotoTags(enabled: boolean, jobId?: string | null) {
  return useQuery({
    queryKey: photoKeys.tags(jobId),
    queryFn: ({ signal }) => fetchTags(jobId || undefined, signal),
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
    queryFn: ({ signal }) =>
      fetchJson<PhotoPermissions>("/api/photos/actor", "Failed to load your permissions", { signal }),
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
    queryFn: ({ signal }) => fetchJson<PhotoSettings>("/api/photos/settings", "Failed to load settings", { signal }),
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

// ---- Keeping the cache true after a change ------------------------------------------
//
// Refetching is what makes an edit slow: TanStack refetches every loaded page
// of a grid one after another and shows none of them until the last lands, so
// a person 20 pages deep waits for 20 requests to see one tag. So an edit
// patches the cached rows itself (the change shows at once), then marks the
// grids stale without refetching them: the next visit to a grid reconciles it
// with the server. The broad refreshes are kept for what a patch cannot work
// out in the browser: uploads, a new or renamed or deleted project or album,
// restores, and any answer that says some photos were skipped or missing.

/** Mark the "Select all" answers stale without asking again: the next click asks fresh. */
function staleSelectAll(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ predicate: (query) => isSelectAllKey(query.queryKey), refetchType: "none" });
}

/** Refresh the given prefixes as on-screen queries need; "Select all" answers only go stale. */
function refreshPrefixes(queryClient: QueryClient, prefixes: readonly string[]) {
  const named = (query: Query) => prefixes.includes(query.queryKey[0] as string);
  void queryClient.invalidateQueries({ predicate: (query) => named(query) && !isSelectAllKey(query.queryKey) });
  staleSelectAll(queryClient);
}

const COLLECTION_PREFIXES = ["photo-jobs", "photo-job", "photo-albums", "photo-album"] as const;
const GRID_PREFIXES = ["photos", "photo-search"] as const;

/**
 * Everything photo-derived refetches (what is on screen at once, the rest on
 * its next visit). For a change a patch cannot describe: a project or album
 * created, renamed, or deleted, a restore, a move, a partial bulk failure.
 * Prefer the targeted helpers below for edits to photos.
 */
export function invalidatePhotoCaches(queryClient: QueryClient) {
  refreshPrefixes(queryClient, [
    ...GRID_PREFIXES, ...COLLECTION_PREFIXES, "photo-tags", "photo-trash",
    "photo-detail", "photo-albums-deleted", "photo-jobs-deleted",
  ]);
}

/**
 * After an upload finishes: the grids, project and album cards, and tags.
 * Not Trash, the deleted lists, or open photos, which a new photo cannot change.
 */
export function invalidateAfterUpload(queryClient: QueryClient) {
  refreshPrefixes(queryClient, [...GRID_PREFIXES, ...COLLECTION_PREFIXES, "photo-tags"]);
}

/** Every cached grid and search page list, each row passed through `edit` (null takes the row out). */
function editCachedGrids(
  queryClient: QueryClient,
  edit: (photo: PhotoRow, queryKey: QueryKey) => PhotoRow | null
) {
  for (const prefix of GRID_PREFIXES) {
    for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: [prefix] })) {
      if (!isCachedGrid(data)) continue;
      const next = editGrid(data, (photo) => edit(photo, queryKey));
      if (next !== data) queryClient.setQueryData(queryKey, next);
    }
  }
}

/** Grids and searches marked stale, refetched on their next visit, not now. */
function staleGrids(queryClient: QueryClient) {
  for (const prefix of GRID_PREFIXES) {
    void queryClient.invalidateQueries({ queryKey: [prefix], refetchType: "none" });
  }
}

/**
 * Put rows the server sent back (PATCH /api/photos/[id] answers the whole
 * row, for a rename or the viewer's Edit) into every cached grid, search, and
 * open photo, at once and without a refetch. Fields a row does not carry (a
 * favorite, a photo's albums) are kept.
 */
export function patchPhotoRows(queryClient: QueryClient, rows: readonly (Partial<PhotoRow> & { id: string })[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  editCachedGrids(queryClient, (photo) => {
    const row = byId.get(photo.id);
    return row ? { ...photo, ...row } : photo;
  });
  for (const row of rows) {
    queryClient.setQueryData<PhotoDetail>(photoKeys.detail(row.id), (photo) => photo && { ...photo, ...row });
  }
  // A new name can join or leave a search; the next visit to it asks again.
  staleGrids(queryClient);
  staleSelectAll(queryClient);
  if (rows.some((row) => row.tags !== undefined)) refreshTagViews(queryClient);
}

/** After tags changed: grids filtered by a tag refetch where on screen, and the tag menus learn new tags. */
function refreshTagViews(queryClient: QueryClient) {
  for (const prefix of GRID_PREFIXES) {
    void queryClient.invalidateQueries({
      queryKey: [prefix],
      predicate: (query) => listFiltersByTag(query.queryKey[2]) && !isSelectAllKey(query.queryKey),
    });
  }
  void queryClient.invalidateQueries({ queryKey: photoKeys.allTags });
}

/**
 * A bulk Tag or Untag, shown at once in every cached grid and open photo.
 * Pass what was sent to POST /api/photos/tags. A grid filtered by a tag is
 * refetched when on screen, since photos may have joined or left it. When the
 * answer says some photos were skipped or missing, call invalidatePhotoCaches
 * instead: the browser cannot tell which.
 */
export function patchPhotoTags(
  queryClient: QueryClient,
  photoIds: readonly string[],
  change: { add?: readonly string[]; remove?: readonly string[] }
) {
  const ids = new Set(photoIds);
  // The server stores a new tag in the library's spelling; the cached list of every tag knows most of them.
  const spellings = queryClient.getQueryData<string[]>(photoKeys.tags()) ?? [];
  const retag = <T extends PhotoRow>(photo: T): T => {
    if (!ids.has(photo.id)) return photo;
    const tags = applyTagChange(photo.tags, change, spellings);
    return tags === null || tags === photo.tags ? photo : { ...photo, tags };
  };
  editCachedGrids(queryClient, retag);
  for (const id of ids) {
    queryClient.setQueryData<PhotoDetail>(photoKeys.detail(id), (photo) => photo && retag(photo));
  }
  staleGrids(queryClient);
  staleSelectAll(queryClient);
  refreshTagViews(queryClient);
}

/**
 * Photos that left some grids: trashed (every grid), or taken out of one
 * album (`fromAlbumId`: that album's grid only). They go from the cached
 * pages at once; the project and album cards, whose counts and thumbnails
 * changed, refresh where on screen. When the answer says some photos were
 * skipped or missing, call invalidatePhotoCaches instead.
 */
export function removePhotosFromLists(
  queryClient: QueryClient,
  photoIds: readonly string[],
  options: { fromAlbumId?: string } = {}
) {
  const ids = new Set(photoIds);
  const albumScope = options.fromAlbumId === undefined ? null : `album:${options.fromAlbumId}`;
  editCachedGrids(queryClient, (photo, queryKey) =>
    ids.has(photo.id) && (albumScope === null || queryKey[1] === albumScope) ? null : photo
  );
  staleGrids(queryClient);
  staleSelectAll(queryClient);
  // An open photo's Details lists its albums; a trashed one is gone (404) on its next read.
  for (const id of ids) void queryClient.invalidateQueries({ queryKey: photoKeys.detail(id) });
  if (albumScope === null) {
    refreshPrefixes(queryClient, [...COLLECTION_PREFIXES, "photo-trash"]);
  } else {
    void queryClient.invalidateQueries({ queryKey: photoKeys.album(options.fromAlbumId!) });
    void queryClient.invalidateQueries({ queryKey: photoKeys.allAlbums });
  }
}

/**
 * One album changed and nothing else did: its order switched, or photos were
 * added to it. Only that album's grid, header, and card refresh, plus the
 * open Details of `photoIds` (which list their albums).
 */
export function invalidateAlbum(queryClient: QueryClient, albumId: string, photoIds: readonly string[] = []) {
  void queryClient.invalidateQueries({
    queryKey: ["photos", `album:${albumId}`],
    predicate: (query) => !isSelectAllKey(query.queryKey),
  });
  staleSelectAll(queryClient);
  void queryClient.invalidateQueries({ queryKey: photoKeys.album(albumId) });
  void queryClient.invalidateQueries({ queryKey: photoKeys.allAlbums });
  for (const id of photoIds) void queryClient.invalidateQueries({ queryKey: photoKeys.detail(id) });
}

// ---- Prefetching on intent -------------------------------------------------------

/** A project or album card the pointer or a finger has just reached. */
export type CollectionTarget = { kind: "job"; id: string } | { kind: "album"; id: string };

/**
 * Start loading what opening this card will show, a moment before the tap:
 * a project's first grid page (a fresh project page has no filters and the
 * newest first), or an album's header, plus its first page when the album
 * card says which order the album shows. Already-fresh data is not asked for
 * again. Call on hover, focus, or touch, never because a card is on screen.
 */
export function prefetchCollection(queryClient: QueryClient, target: CollectionTarget) {
  if (target.kind === "job") {
    void queryClient.prefetchInfiniteQuery(photoListOptions({ kind: "job", jobId: target.id }, NO_FILTERS, "desc"));
    return;
  }
  void queryClient.prefetchQuery(photoAlbumOptions(target.id));
  const header = albumFromLists(queryClient, target.id);
  if (header) {
    const scope: PhotoListScope = { kind: "album", album: { id: header.id, name: header.name } };
    void queryClient.prefetchInfiniteQuery(
      photoListOptions(scope, NO_FILTERS, header.sort_mode === "custom" ? "custom" : "desc")
    );
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
export function fetchDeletedJobs(
  { signal }: { signal?: AbortSignal } = {}
): Promise<{ jobs: DeletedJob[]; truncated: boolean }> {
  return fetchJson<{ jobs: DeletedJob[]; truncated: boolean }>(
    "/api/photo-jobs?deleted=1", "Failed to load deleted projects", { cache: "no-store", signal }
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

/** The first `limit` albums matching `q`, in one request (no paging on). */
export async function fetchAlbumsPage(q: string, limit: number, signal?: AbortSignal): Promise<PhotoAlbumSummary[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const data = await fetchJson<{ albums: PhotoAlbumSummary[] }>(`/api/photo-albums?${params}`, "Failed to load albums", { signal });
  return data.albums;
}

/** Album cards, by name A to Z. Shared by the list, rail, and pickers. */
export function usePhotoAlbums(enabled: boolean, q = "") {
  return useQuery({
    queryKey: photoKeys.albums(q),
    queryFn: ({ signal }) => fetchAlbums(q, signal),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** The search box's album matches: at most `limit`, in one small request (see usePhotoJobSuggestions). */
export function usePhotoAlbumSuggestions(enabled: boolean, q: string, limit: number) {
  return useQuery({
    queryKey: photoKeys.albumSuggestions(q, limit),
    queryFn: ({ signal }) => fetchAlbumsPage(q, limit, signal),
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

/**
 * An album card as its page's header, when the card carries the album's
 * order (the album list sends `sort_mode` and `has_custom_order`). Without
 * them there is no header to show early: the page's Sort default depends on
 * the order, and guessing it would load the grid in the wrong one first.
 */
export function albumHeaderFromSummary(
  album: PhotoAlbumSummary & Partial<Pick<PhotoAlbumHeader, "sort_mode" | "has_custom_order">>
): PhotoAlbumHeader | undefined {
  if ((album.sort_mode !== "date" && album.sort_mode !== "custom") || typeof album.has_custom_order !== "boolean") {
    return undefined;
  }
  return {
    id: album.id,
    name: album.name,
    photo_count: album.photo_count,
    created_at: album.created_at,
    created_by: album.created_by ?? "",
    sort_mode: album.sort_mode,
    has_custom_order: album.has_custom_order,
  };
}

/** Any cached album list's card for this album, as a header (see albumHeaderFromSummary). */
function albumFromLists(queryClient: QueryClient, albumId: string): PhotoAlbumHeader | undefined {
  for (const [, albums] of queryClient.getQueriesData<PhotoAlbumSummary[]>({ queryKey: photoKeys.allAlbums })) {
    const found = Array.isArray(albums) ? albums.find((album) => album.id === albumId) : undefined;
    if (found) return albumHeaderFromSummary(found);
  }
  return undefined;
}

/** The album header read (GET /api/photo-albums/[id]), shared by the page and a card's prefetch. */
export function photoAlbumOptions(albumId: string) {
  return queryOptions({
    queryKey: photoKeys.album(albumId),
    queryFn: async ({ signal }) =>
      (
        await fetchJson<{ album: PhotoAlbumHeader }>(
          `/api/photo-albums/${encodeURIComponent(albumId)}`,
          "Failed to load the album",
          { signal }
        )
      ).album,
    // A deleted album is a 404; asking three more times only delays saying so.
    retry: false,
  });
}

/**
 * One album's header. Opened from the Albums list or the rail, it shows at
 * once from that list's card, so the grid starts loading in the same moment
 * instead of one round trip later; the album's own read then confirms it.
 */
export function usePhotoAlbum(albumId: string, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    ...photoAlbumOptions(albumId),
    enabled,
    placeholderData: () => albumFromLists(queryClient, albumId),
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

/** Takes the query's context, so it can be a queryFn as it is and still be cancelled. */
export async function fetchDeletedAlbums({ signal }: { signal?: AbortSignal } = {}): Promise<DeletedAlbum[]> {
  const data = await fetchJson<{ albums: DeletedAlbum[] }>(
    "/api/photo-albums?deleted=1",
    "Failed to load deleted albums",
    { cache: "no-store", signal }
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
  const patch = <T extends PhotoRow>(photo: T): T =>
    ids.has(photo.id) ? { ...photo, favorites: on ? [{ user_id: me }] : [] } : photo;
  // Grid pages only: the same prefixes hold "Select all" answers, which have no rows.
  editCachedGrids(queryClient, patch);
  for (const id of ids) {
    queryClient.setQueryData<PhotoDetail>(photoKeys.detail(id), (photo) => photo && patch(photo));
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
export async function fetchPhotoDetail(photoId: string, signal?: AbortSignal): Promise<PhotoDetail> {
  const data = await fetchJson<{ photo: PhotoDetail }>(
    `/api/photos/${encodeURIComponent(photoId)}`,
    "Photo not found",
    { signal }
  );
  return data.photo;
}

export function usePhotoDetail(photoId: string | null) {
  return useQuery({
    queryKey: photoKeys.detail(photoId),
    queryFn: ({ signal }) => fetchPhotoDetail(photoId!, signal),
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
