"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import BrowseToolbar from "@/components/photos/browse-toolbar";
import type { FilterChoices } from "@/components/photos/filter-bar";
import InfiniteSentinel from "@/components/photos/infinite-sentinel";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import SelectionBar from "@/components/photos/selection-bar";
import StatusLine from "@/components/photos/status-line";
import { useBrowseState } from "@/hooks/use-browse-state";
import { usePhotoSelection } from "@/hooks/use-photo-selection";
import {
  useLightboxByPhotoId,
  useOpenLinkedPhoto,
  usePhotoDeepLink,
} from "@/hooks/use-photo-deep-link";
import {
  fetchPhotoIds,
  fetchPhotosPage,
  invalidatePhotoCaches,
  usePhotoDetail,
  usePhotoJobs,
  usePhotoTags,
  type PhotoSort,
} from "@/lib/photos/api";
import {
  activeFilterCount,
  groupFilters,
  NO_PROJECT_VALUE,
  withFilterParams,
} from "@/lib/photos/browse-state";
import {
  accumulateSeenOptions,
  emptySeenOptions,
  toTagOptions,
  toUploaderOptions,
  type SeenOptions,
} from "@/lib/photos/filter-options";
import { jobLabel, NO_PROJECT } from "@/lib/photos/format";
import {
  groupPhotos,
  openableInDisplayOrder,
  type GroupBy,
  type PhotoGroup,
} from "@/lib/photos/group";
import type { PhotoAlbumRef, PhotoRow } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

// The one photo grid screen, shared by Photos (every photo), an album, a
// project, and search results: the toolbar (filters, Group by, Sort, all kept
// in the URL), the grid with select-many and its action bar, endless
// scrolling, and the viewer with its `?photo=` link.

export type BrowserScope =
  | { kind: "all" }
  | { kind: "album"; album: PhotoAlbumRef }
  | { kind: "job"; jobId: string }
  | { kind: "search"; q: string };

/** What a page's summary line can say about the loaded results. */
export interface BrowserSummary {
  count: number;
  hasMore: boolean;
  /** Distinct projects among the loaded photos ("No project" is not one). */
  projectCount: number;
}

interface PhotoBrowserProps {
  scope: BrowserScope;
  /** Shown instead of the filters and grid when the scope holds no photos. */
  empty: ReactNode;
  /** Group modes on offer; the first is the default. */
  groupModes?: readonly GroupBy[];
  /** A line above the controls, e.g. search's "12 photos across 2 projects". */
  summary?(info: BrowserSummary): ReactNode;
  pinnedTag?: string;
  pinnedLabel?: string;
  /**
   * An album's order: Sort's default (`custom` while the album shows its
   * arranged order), whether Custom is offered, and a hook told of every Sort
   * pick, which an album page uses to switch the order everyone sees.
   */
  albumOrder?: {
    defaultSort: PhotoSort;
    customOffered: boolean;
    onSortPicked(sort: PhotoSort): void;
  };
}

const DEFAULT_MODES = ["date", "tag", "uploader", "type"] as const;

function scopeParams(scope: BrowserScope): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.kind === "album") params.set("album", scope.album.id);
  if (scope.kind === "job") params.set("job", scope.jobId);
  if (scope.kind === "search") params.set("q", scope.q);
  return params;
}

const scopeKey = (scope: BrowserScope) =>
  scope.kind === "album"
    ? `album:${scope.album.id}`
    : scope.kind === "job"
      ? `job:${scope.jobId}`
      : scope.kind === "search"
        ? `search:${scope.q}`
        : "all";

export default function PhotoBrowser({
  scope,
  empty,
  groupModes = DEFAULT_MODES,
  summary,
  pinnedTag,
  pinnedLabel,
  albumOrder,
}: PhotoBrowserProps) {
  const queryClient = useQueryClient();
  // Project is a filter where the page is not already one project or album.
  const projectFilter = scope.kind === "all" || scope.kind === "search";
  const {
    filters,
    sort,
    group: groupBy,
    setFilters,
    clearFilters,
    setSort,
    setGroup,
  } = useBrowseState({
    groupModes,
    projectFilter,
    defaultSort: albumOrder?.defaultSort,
    customSort: albumOrder !== undefined,
  });
  const custom = sort === "custom";
  const pickSort = useCallback(
    (next: PhotoSort) => {
      setSort(next);
      albumOrder?.onSortPicked(next);
    },
    [setSort, albumOrder]
  );
  const [seen, setSeen] = useState<SeenOptions>(emptySeenOptions);
  const key = scopeKey(scope);
  const enabled = scope.kind !== "search" || scope.q.length > 0;
  // "photos" / "photo-search" are the prefixes invalidatePhotoCaches refreshes.
  const prefix = scope.kind === "search" ? "photo-search" : "photos";
  // Exactly what the grid lists, for GET /api/photos and /ids alike.
  const scopeQuery = scopeParams(scope).toString();
  const listParams = useMemo(
    () => withFilterParams(new URLSearchParams(scopeQuery), filters, sort),
    [scopeQuery, filters, sort]
  );
  const listKey = listParams.toString();

  // A new album, project, or search is a new screen: its menus start empty.
  // (Its filters come from its own URL.)
  useEffect(() => {
    setSeen(emptySeenOptions());
  }, [key]);

  const {
    data,
    error,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData,
  } = useInfiniteQuery({
    queryKey: [prefix, key, listKey],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(listKey);
      if (pageParam) params.set("cursor", pageParam);
      return fetchPhotosPage(params);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    // A new sort or filter keeps the grid and toolbar on screen (dimmed) until
    // its first page lands, so the chip just used keeps focus. Only within the
    // same album, project, or search: another one starts blank.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === key ? keepPreviousData(previous) : undefined,
  });

  const photos = useMemo(
    () => data?.pages.flatMap((page) => page.photos) ?? [],
    [data]
  );

  useEffect(() => {
    setSeen((previous) => accumulateSeenOptions(previous, photos));
  }, [photos]);

  // Filter menus. Keyed on `seen`, which only changes when a page brings a new
  // uploader or tag — otherwise every appended page would re-sort the lot.
  const uploaderOptions = useMemo(() => toUploaderOptions(seen), [seen]);
  // Photos and a project know every tag in use up front; an album or a search
  // offers the tags its loaded photos carry.
  const knownTagScope =
    scope.kind === "all" ? "" : scope.kind === "job" ? scope.jobId : null;
  const { data: knownTags } = usePhotoTags(knownTagScope !== null, knownTagScope);
  const tagOptions = useMemo(() => toTagOptions(seen, knownTags ?? []), [seen, knownTags]);
  const { data: jobs } = usePhotoJobs(projectFilter);
  const projectOptions = useMemo(
    () =>
      projectFilter
        ? [
            { value: NO_PROJECT_VALUE, label: NO_PROJECT },
            ...(jobs ?? [])
              .filter((job) => job.photo_count > 0)
              .map((job) => ({ value: job.id, label: jobLabel(job) })),
          ]
        : null,
    [jobs, projectFilter]
  );
  const choices = useMemo<FilterChoices>(
    () => ({ projects: projectOptions, uploaders: uploaderOptions, tags: tagOptions }),
    [projectOptions, uploaderOptions, tagOptions]
  );

  // GET /api/photos/ids answers, shared by "Select all" and the group ticks;
  // under the grid's own prefix, so an edit that refreshes the grid refreshes them.
  const idsQuery = useCallback(
    (params: URLSearchParams) => ({
      queryKey: [prefix, key, params.toString(), "ids"],
      queryFn: () => fetchPhotoIds(params),
      staleTime: 30_000,
    }),
    [prefix, key]
  );
  const groupIds = useCallback(
    (group: PhotoGroup) => {
      const narrowed = groupFilters(group, filters);
      return narrowed
        ? queryClient.fetchQuery(
            idsQuery(withFilterParams(new URLSearchParams(scopeQuery), narrowed, sort))
          )
        : null;
    },
    [queryClient, idsQuery, filters, sort, scopeQuery]
  );

  // An arranged album is one list in its own order: grouping would reshuffle it.
  const groups = useMemo<PhotoGroup[]>(
    () =>
      custom
        ? photos.length > 0
          ? [{ key: "custom:all", label: "Custom order", photos }]
          : []
        : groupPhotos(photos, groupBy),
    [photos, groupBy, custom]
  );
  const { selection, selectedIds, clear, limitMessage, selectAll } = usePhotoSelection(
    groups,
    groupIds
  );
  // Every match, once something is selected: the bar offers "Select all M".
  const allMatches = useQuery({
    ...idsQuery(listParams),
    enabled: enabled && selectedIds.size > 0,
  });
  // Another album, project, or search is another screen, so its selection goes.
  // Changing a filter keeps it: that is how photos from two projects get picked
  // for one album — filter to the first, tick, filter to the second, tick.
  useEffect(clear, [key, clear]);

  // Bulk Tag suggests one project's tags when every selected photo is in it;
  // on a project page that is the page's project, whatever pages are loaded.
  const sharedJobId = useMemo(() => {
    if (selectedIds.size === 0) return null;
    if (scope.kind === "job") return scope.jobId;
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    let shared: string | null = null;
    for (const id of selectedIds) {
      const jobId = byId.get(id)?.job_id ?? null;
      if (jobId === null || (shared !== null && shared !== jobId)) return null;
      shared = jobId;
    }
    return shared;
  }, [photos, selectedIds, scope]);

  // The viewer flips through the set as displayed: grouped order, images and
  // videos with previews only (file tiles download instead). A photo opened
  // from a link that the loaded pages do not hold joins the set by id.
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const linked = usePhotoDetail(linkedId);
  const openablePhotos = useMemo(() => {
    const openable = openableInDisplayOrder(groups);
    const extra: PhotoRow | undefined = linked.isError ? undefined : linked.data;
    return extra && !openable.some((photo) => photo.id === extra.id)
      ? [extra, ...openable]
      : openable;
  }, [groups, linked.data, linked.isError]);

  const {
    openPhotoId,
    setOpenPhotoId,
    isOpen: lightboxOpen,
    lightboxProps,
  } = useLightboxByPhotoId(openablePhotos);

  useOpenLinkedPhoto({
    photos: openablePhotos,
    firstPageLoaded: (data?.pages.length ?? 0) > 0,
    isLightboxOpen: lightboxOpen,
    onResolve: (photoId, fetched) => {
      if (fetched) {
        // Seeded, so the set holds the photo in the same render that opens it.
        queryClient.setQueryData(["photo-detail", photoId], fetched);
        setLinkedId(photoId);
      }
      setOpenPhotoId(photoId);
    },
  });

  usePhotoDeepLink({
    openPhotoId,
    onPopClose: () => setOpenPhotoId(null),
    onPopOpen: (photoId) => {
      if (!openablePhotos.some((candidate) => candidate.id === photoId)) {
        return false;
      }
      setOpenPhotoId(photoId);
      return true;
    },
  });

  const noFiltersActive = activeFilterCount(filters) === 0;
  // Known once any data is in hand, including the previous view's while a new
  // sort or filter loads (isLoading is false then). Only a settled answer may
  // say the view is empty: a dimmed previous view is not the new one's answer.
  const loaded = enabled && data !== undefined && !error;
  const settled = loaded && !isPlaceholderData;
  const scopeIsEmpty = settled && noFiltersActive && photos.length === 0;
  const projectCount = useMemo(
    () => new Set(photos.flatMap((photo) => photo.job_id ?? [])).size,
    [photos]
  );

  return (
    <>
      {loaded && summary?.({ count: photos.length, hasMore: hasNextPage, projectCount })}

      {/* Filters and grouping only appear when there is something to filter;
          they stay through a failed first page so Clear or Newest is reachable. */}
      {(loaded || error !== null) && !scopeIsEmpty && (
        <BrowseToolbar
          filters={filters}
          choices={choices}
          onFiltersChange={setFilters}
          onClear={clearFilters}
          groupModes={custom ? [] : groupModes}
          group={groupBy}
          onGroupChange={setGroup}
          sort={sort}
          onSortChange={pickSort}
          customSort={albumOrder?.customOffered || custom}
          showView={photos.length > 0 || error !== null}
        />
      )}
      {enabled && isLoading && <StatusLine>Loading photos...</StatusLine>}
      {/* A failed next page is the sentinel's to report (it keeps the loaded
          grid and offers retry); the banner is for the first page only. */}
      {error && !isFetchNextPageError && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load photos"}
        </StatusLine>
      )}

      {scopeIsEmpty && empty}
      {settled && !noFiltersActive && photos.length === 0 && (
        <div className="py-10 text-center">
          <p className="text-base text-[#d0d0d0]">No photos match</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mx-auto mt-3 flex min-h-11 items-center rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] px-4 text-base text-white hover:border-[#2680FC]"
          >
            Clear filters
          </button>
        </div>
      )}

      <div
        aria-busy={isPlaceholderData || undefined}
        className={cn("transition-opacity", isPlaceholderData && "opacity-60")}
      >
        <PhotoGrid
          groups={groups}
          // "date" draws the custom list's one header without a loaded-count.
          groupBy={custom ? "date" : groupBy}
          onOpenPhoto={(photo) => setOpenPhotoId(photo.id)}
          selection={selection}
          pinnedTag={noFiltersActive ? pinnedTag : undefined}
          pinnedLabel={pinnedLabel}
          onExpandPinned={() =>
            pinnedTag && setFilters({ tags: [pinnedTag] })
          }
        />
      </div>

      <InfiniteSentinel
        hasNextPage={hasNextPage && !isPlaceholderData}
        isFetching={isFetchingNextPage}
        failed={isFetchNextPageError}
        onVisible={() => fetchNextPage()}
      />

      <SelectionBar
        selectedIds={selectedIds}
        onClear={clear}
        album={scope.kind === "album" ? scope.album : undefined}
        limitMessage={limitMessage}
        photos={photos}
        listQuery={listKey}
        sharedJobId={sharedJobId}
        allMatches={allMatches.data}
        onSelectAll={selectAll}
      />

      <PhotoLightbox
        {...lightboxProps}
        onChanged={() => invalidatePhotoCaches(queryClient)}
      />
    </>
  );
}
