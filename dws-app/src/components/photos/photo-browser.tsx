"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import BrowseToolbar from "@/components/photos/browse-toolbar";
import { useProjectFilterLabel, type FilterChoices } from "@/components/photos/filter-bar";
import InfiniteSentinel from "@/components/photos/infinite-sentinel";
import { LoadBoundary, retryableLoader } from "@/components/photos/load-boundary";
import PhotoGrid, { type GridSelection } from "@/components/photos/photo-grid";
import SelectionBar from "@/components/photos/selection-bar";
import { useSlideshowStart } from "@/components/photos/slideshow-link";
import StatusLine from "@/components/photos/status-line";
import { useBrowseState } from "@/hooks/use-browse-state";
import { usePhotoSelection } from "@/hooks/use-photo-selection";
import {
  useLightboxByPhotoId,
  useOpenLinkedPhoto,
  usePhotoDeepLink,
} from "@/hooks/use-photo-deep-link";
import {
  photoCountOptions,
  photoIdsOptions,
  photoListOptions,
  photoListParams,
  scopeKey,
  usePhotoDetail,
  usePhotoTags,
  WAITING_FOR_CONNECTION,
  type PhotoListScope,
  type PhotoSort,
} from "@/lib/photos/api";
import { activeFilterCount, groupFilters } from "@/lib/photos/browse-state";
import {
  accumulateSeenOptions,
  emptySeenOptions,
  toTagOptions,
  toUploaderOptions,
  type SeenOptions,
} from "@/lib/photos/filter-options";
import {
  groupPhotos,
  openableInDisplayOrder,
  type GroupBy,
  type PhotoGroup,
} from "@/lib/photos/group";
import type { PhotoRow } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

// The one photo grid screen, shared by Photos (every photo), an album, a
// project, and search results: the toolbar (filters, Group by, Sort, all kept
// in the URL), the grid with select-many and its action bar, endless
// scrolling, and the viewer with its `?photo=` link.

// The viewer (YARL and its plugins, about 50 KB gzipped) is not needed to draw
// the grid, so it is its own chunk, fetched after the first page of photos
// has landed (see viewerWanted below) instead of before the page can paint.
// A failed download leaves the grid up and the next tap tries again
// (LoadBoundary, retryableLoader).
const PhotoLightbox = dynamic(
  retryableLoader(() => import("@/components/photos/photo-lightbox")),
  { ssr: false, loading: () => null }
);

/** What this grid lists. The query keys and fetchers live in api.ts, so a prefetch names the same cache entry. */
export type BrowserScope = PhotoListScope;

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

const albumNameOf = (scope: BrowserScope) => (scope.kind === "album" ? scope.album.name : null);

export default function PhotoBrowser({
  scope: scopeProp,
  empty,
  groupModes = DEFAULT_MODES,
  summary,
  pinnedTag,
  pinnedLabel,
  albumOrder,
}: PhotoBrowserProps) {
  const queryClient = useQueryClient();
  // Pages build `scope` inline, a new object on every render. Hold one copy
  // while it names the same grid (and album name), so the memos below and the
  // selection bar's props stay the same between renders.
  const [heldScope, setHeldScope] = useState(scopeProp);
  const sameScope =
    scopeKey(heldScope) === scopeKey(scopeProp) && albumNameOf(heldScope) === albumNameOf(scopeProp);
  const scope = sameScope ? heldScope : scopeProp;
  if (!sameScope) setHeldScope(scopeProp);
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
  const key = scopeKey(scope);
  const enabled = scope.kind !== "search" || scope.q.length > 0;
  // Exactly what the grid lists, for GET /api/photos and its count and ids.
  const listParams = useMemo(() => photoListParams(scope, filters, sort), [scope, filters, sort]);

  const {
    data,
    error,
    isLoading,
    fetchStatus,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData,
  } = useInfiniteQuery({
    // The same key and fetcher a project card's prefetch uses, so a hover's
    // head start is this grid's first page.
    ...photoListOptions(scope, filters, sort),
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
  // Built once per page of photos, not on every tick: the shared-project
  // check below and the selection bar's Trash count look photos up by id.
  const photosById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);

  // Every uploader and tag the loaded pages have shown, for the filter menus;
  // kept across filter changes. A new album, project, or search is a new
  // screen: its menus start empty (its filters come from its own URL).
  // Worked out while rendering, not in an effect, so a new page of photos
  // renders the grid once instead of twice.
  const [seenState, setSeenState] = useState<{
    key: string;
    photos: PhotoRow[];
    seen: SeenOptions;
  }>(() => ({ key, photos: [], seen: emptySeenOptions() }));
  let seen = seenState.seen;
  if (seenState.key !== key || seenState.photos !== photos) {
    seen = accumulateSeenOptions(
      seenState.key === key ? seenState.seen : emptySeenOptions(),
      photos
    );
    setSeenState({ key, photos, seen });
  }

  // Filter menus. Keyed on `seen`, which only changes when a page brings a new
  // uploader or tag — otherwise every appended page would re-sort the lot.
  const uploaderOptions = useMemo(() => toUploaderOptions(seen), [seen]);
  // Photos and a project know every tag in use up front; an album or a search
  // offers the tags its loaded photos carry.
  const knownTagScope =
    scope.kind === "all" ? "" : scope.kind === "job" ? scope.jobId : null;
  const { data: knownTags } = usePhotoTags(knownTagScope !== null, knownTagScope);
  const tagOptions = useMemo(() => toTagOptions(seen, knownTags ?? []), [seen, knownTags]);
  // The project list (every project, page after page) loads only when someone
  // opens the Project filter; until then the chosen project's chip names it
  // from that one project's read.
  const projectLabel = useProjectFilterLabel(projectFilter ? filters.project : null);
  const choices = useMemo<FilterChoices>(
    () => ({
      projects: projectFilter ? [] : null,
      lazyProjects: projectFilter,
      projectLabel,
      uploaders: uploaderOptions,
      tags: tagOptions,
    }),
    [projectFilter, projectLabel, uploaderOptions, tagOptions]
  );

  // A group tick's ids (GET /api/photos/ids for the group's filters), keyed
  // under the grid, so an edit that changes the grid marks them stale too.
  const groupIds = useCallback(
    (group: PhotoGroup) => {
      const narrowed = groupFilters(group, filters);
      return narrowed
        ? queryClient.fetchQuery(photoIdsOptions(scope, photoListParams(scope, narrowed, sort)))
        : null;
    },
    [queryClient, scope, filters, sort]
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
  // Once something is selected the bar offers "Select all M": only the count
  // is asked for now (one small request); the ids (up to 5,000) are fetched
  // when the link is clicked.
  const matchCount = useQuery({
    ...photoCountOptions(scope, listParams),
    enabled: enabled && selectedIds.size > 0,
  });
  const loadAllMatches = useCallback(
    () => queryClient.fetchQuery(photoIdsOptions(scope, listParams)),
    [queryClient, scope, listParams]
  );
  // Another album, project, or search is another screen, so its selection goes.
  // Changing a filter keeps it: that is how photos from two projects get picked
  // for one album — filter to the first, tick, filter to the second, tick.
  useEffect(clear, [key, clear]);

  // Bulk Tag suggests one project's tags when every selected photo is in it;
  // on a project page that is the page's project, whatever pages are loaded.
  const sharedJobId = useMemo(() => {
    if (selectedIds.size === 0) return null;
    if (scope.kind === "job") return scope.jobId;
    let shared: string | null = null;
    for (const id of selectedIds) {
      const jobId = photosById.get(id)?.job_id ?? null;
      if (jobId === null || (shared !== null && shared !== jobId)) return null;
      shared = jobId;
    }
    return shared;
  }, [photosById, selectedIds, scope]);

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

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // While the previous filter's photos are still on screen (dimmed), a group
  // tick would mix those rows with the new filter's ids: wait for the page.
  const gridSelection = useMemo<GridSelection>(
    () => (isPlaceholderData ? { ...selection, onToggleGroup: () => {} } : selection),
    [selection, isPlaceholderData]
  );

  const {
    openPhotoId,
    setOpenPhotoId,
    isOpen: lightboxOpen,
    lightboxProps,
  } = useLightboxByPhotoId(openablePhotos);

  // The page header's Play button: shown as soon as the grid has a still,
  // without waiting for the viewer's code. It opens the viewer, which plays.
  const { autoplay, autoplayStarted } = useSlideshowStart(openablePhotos, setOpenPhotoId, lightboxOpen);

  // Mount the viewer once the first page is in and the browser is idle, or
  // sooner if a tile is pressed or a photo opens (a `?photo=` link, Play).
  // Mounted early, it is ready by the first tap.
  const firstPageLoaded = (data?.pages.length ?? 0) > 0;
  const [viewerWanted, setViewerWanted] = useState(false);
  // Its download failed: no more tries until someone opens a photo.
  const [viewerFailed, setViewerFailed] = useState(false);
  useEffect(() => {
    if (viewerWanted || viewerFailed || !firstPageLoaded) return;
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => setViewerWanted(true), { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    // Safari has no requestIdleCallback.
    const timer = setTimeout(() => setViewerWanted(true), 500);
    return () => clearTimeout(timer);
  }, [viewerWanted, viewerFailed, firstPageLoaded]);
  const wantViewer = useCallback(() => setViewerWanted(true), []);
  // The grid stays; the viewer unmounts, and the next open mounts it afresh,
  // which downloads it again. Only an open the person asked for is reported.
  const viewerLoadFailed = useCallback(() => {
    setViewerFailed(true);
    setViewerWanted(false);
    setOpenPhotoId(null);
    autoplayStarted();
  }, [setOpenPhotoId, autoplayStarted]);
  // Once opened it stays mounted, so closing plays its close animation.
  if (lightboxOpen && !viewerWanted) setViewerWanted(true);

  useOpenLinkedPhoto({
    photos: openablePhotos,
    firstPageLoaded,
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

  // Stable, so the memoized grid skips renders that change nothing it draws
  // (a viewer swipe, a fetch-status flip).
  const openPhoto = useCallback(
    (photo: PhotoRow) => setOpenPhotoId(photo.id),
    [setOpenPhotoId]
  );
  const expandPinned = useCallback(() => {
    if (pinnedTag) setFilters({ tags: [pinnedTag] });
  }, [pinnedTag, setFilters]);

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
      {/* Offline, the first page waits rather than failing (and isLoading is
          false): say so, instead of a blank page. It asks again when the
          connection is back. */}
      {enabled && fetchStatus === "paused" && data === undefined && (
        <StatusLine>{WAITING_FOR_CONNECTION}</StatusLine>
      )}
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
        // A press on a tile starts the viewer's download if idle has not yet.
        onPointerDownCapture={viewerWanted ? undefined : wantViewer}
      >
        <PhotoGrid
          groups={groups}
          // "date" draws the custom list's one header without a loaded-count.
          groupBy={custom ? "date" : groupBy}
          onOpenPhoto={openPhoto}
          selection={gridSelection}
          pinnedTag={noFiltersActive ? pinnedTag : undefined}
          pinnedLabel={pinnedLabel}
          onExpandPinned={expandPinned}
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
        inFavorites={filters.favorites}
        limitMessage={limitMessage}
        photos={photos}
        photosById={photosById}
        sharedJobId={sharedJobId}
        // Not while the previous filter's photos are still on screen (dimmed):
        // their ticks and the new filter's count do not describe one list.
        matchCount={isPlaceholderData ? undefined : matchCount.data}
        loadAllMatches={loadAllMatches}
        onSelectAll={selectAll}
      />

      {(viewerWanted || lightboxOpen) && (
        <LoadBoundary notify={lightboxOpen} onError={viewerLoadFailed}>
          <PhotoLightbox
            {...lightboxProps}
            onNearEnd={loadMore}
            autoplay={autoplay}
            onAutoplayStarted={autoplayStarted}
          />
        </LoadBoundary>
      )}
    </>
  );
}
