"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilterChip, chipClass } from "@/components/photos/filter-bar";
import GroupByToggle from "@/components/photos/group-by-toggle";
import InfiniteSentinel from "@/components/photos/infinite-sentinel";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import SelectionBar from "@/components/photos/selection-bar";
import StatusLine from "@/components/photos/status-line";
import { usePhotoSelection } from "@/hooks/use-photo-selection";
import {
  useLightboxByPhotoId,
  useOpenLinkedPhoto,
  usePhotoDeepLink,
} from "@/hooks/use-photo-deep-link";
import {
  fetchPhotosPage,
  fetchTags,
  invalidatePhotoCaches,
  usePhotoDetail,
  usePhotoJobs,
} from "@/lib/photos/api";
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
} from "@/lib/photos/group";
import type { PhotoAlbumRef, PhotoRow } from "@/lib/photos/types";

// The one photo grid screen, shared by Photos (every photo), an album, a
// project, and search results: filters, Group by, the grid with select-many and
// its action bar, endless scrolling, and the viewer with its `?photo=` link.

export type BrowserScope =
  | { kind: "all" }
  | { kind: "album"; album: PhotoAlbumRef }
  | { kind: "job"; jobId: string }
  | { kind: "search"; q: string };

/** `job=none` on GET /api/photos: photos with no project. */
const NO_PROJECT_VALUE = "none";

interface Filters {
  project: { id: string; label: string } | null;
  uploader: { id: string; name: string } | null;
  tag: string | null;
}

const NO_FILTERS: Filters = { project: null, uploader: null, tag: null };

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
}

const DEFAULT_MODES = ["date", "tag"] as const;

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
}: PhotoBrowserProps) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>(groupModes[0]);
  const [seen, setSeen] = useState<SeenOptions>(emptySeenOptions);
  const key = scopeKey(scope);
  const enabled = scope.kind !== "search" || scope.q.length > 0;

  // A new album, project, or search is a new screen: nothing carries over.
  useEffect(() => {
    setFilters(NO_FILTERS);
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
  } = useInfiniteQuery({
    // "photos" / "photo-search" are the prefixes invalidatePhotoCaches refreshes.
    queryKey: [
      scope.kind === "search" ? "photo-search" : "photos",
      key,
      filters.project?.id ?? null,
      filters.uploader?.id ?? null,
      filters.tag,
    ],
    queryFn: ({ pageParam }) => {
      const params = scopeParams(scope);
      if (filters.project) params.set("job", filters.project.id);
      if (filters.uploader) params.set("uploader", filters.uploader.id);
      if (filters.tag) params.set("tags", filters.tag);
      if (pageParam) params.set("cursor", pageParam);
      return fetchPhotosPage(params);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
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
  const { data: knownTags } = useQuery({
    queryKey: ["photo-tags", knownTagScope],
    queryFn: () => fetchTags(knownTagScope || undefined),
    enabled: knownTagScope !== null,
  });
  const tagOptions = useMemo(() => toTagOptions(seen, knownTags ?? []), [seen, knownTags]);
  const { data: jobs } = usePhotoJobs(scope.kind === "all");
  const projectOptions = useMemo(
    () => [
      { value: NO_PROJECT_VALUE, label: NO_PROJECT },
      ...(jobs ?? [])
        .filter((job) => job.photo_count > 0)
        .map((job) => ({ value: job.id, label: jobLabel(job) })),
    ],
    [jobs]
  );

  const groups = useMemo(() => groupPhotos(photos, groupBy), [photos, groupBy]);
  const { selection, selectedIds, clear, limitMessage } = usePhotoSelection(groups);
  // Another album, project, or search is another screen, so its selection goes.
  // Changing a filter keeps it: that is how photos from two projects get picked
  // for one album — filter to the first, tick, filter to the second, tick.
  useEffect(clear, [key, clear]);

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

  const noFiltersActive = !filters.project && !filters.uploader && !filters.tag;
  const loaded = enabled && !isLoading && !error;
  const scopeIsEmpty = loaded && noFiltersActive && photos.length === 0;
  const projectCount = useMemo(
    () => new Set(photos.flatMap((photo) => photo.job_id ?? [])).size,
    [photos]
  );

  return (
    <>
      {loaded && summary?.({ count: photos.length, hasMore: hasNextPage, projectCount })}

      {/* Filters and grouping only appear when there is something to filter. */}
      {loaded && !scopeIsEmpty && (
        <div className="mb-1 flex flex-col gap-2 desktop:flex-row desktop:flex-wrap desktop:items-center desktop:justify-between">
          <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={noFiltersActive}
              onClick={() => setFilters(NO_FILTERS)}
              className={chipClass(noFiltersActive)}
            >
              All
            </button>
            {scope.kind === "all" && (
              <FilterChip
                label="Project"
                active={filters.project?.label ?? null}
                options={projectOptions}
                onSelect={(value) =>
                  setFilters((previous) => ({
                    ...previous,
                    project: {
                      id: value,
                      label:
                        projectOptions.find((option) => option.value === value)?.label ??
                        "Project",
                    },
                  }))
                }
                onClear={() => setFilters((previous) => ({ ...previous, project: null }))}
              />
            )}
            <FilterChip
              label="Tag"
              active={filters.tag}
              options={tagOptions}
              onSelect={(value) => setFilters((previous) => ({ ...previous, tag: value }))}
              onClear={() => setFilters((previous) => ({ ...previous, tag: null }))}
            />
            <FilterChip
              label="Uploader"
              active={filters.uploader?.name ?? null}
              options={uploaderOptions}
              onSelect={(value) =>
                setFilters((previous) => ({
                  ...previous,
                  uploader: { id: value, name: seen.uploaders.get(value) ?? "Uploader" },
                }))
              }
              onClear={() => setFilters((previous) => ({ ...previous, uploader: null }))}
            />
          </div>
          {photos.length > 0 && groupModes.length > 1 && (
            <GroupByToggle modes={groupModes} value={groupBy} onChange={setGroupBy} />
          )}
        </div>
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
      {loaded && !noFiltersActive && photos.length === 0 && (
        <div className="py-10 text-center">
          <p className="text-base text-[#d0d0d0]">No photos match these filters.</p>
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="mx-auto mt-3 flex min-h-11 items-center rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] px-4 text-base text-white hover:border-[#2680FC]"
          >
            Show all photos
          </button>
        </div>
      )}

      <PhotoGrid
        groups={groups}
        groupBy={groupBy}
        onOpenPhoto={(photo) => setOpenPhotoId(photo.id)}
        selection={selection}
        pinnedTag={noFiltersActive ? pinnedTag : undefined}
        pinnedLabel={pinnedLabel}
        onExpandPinned={() =>
          pinnedTag && setFilters((previous) => ({ ...previous, tag: pinnedTag }))
        }
      />

      <InfiniteSentinel
        hasNextPage={hasNextPage}
        isFetching={isFetchingNextPage}
        failed={isFetchNextPageError}
        onVisible={() => fetchNextPage()}
      />

      <SelectionBar
        selectedIds={selectedIds}
        onClear={clear}
        album={scope.kind === "album" ? scope.album : undefined}
        limitMessage={limitMessage}
      />

      <PhotoLightbox
        {...lightboxProps}
        onChanged={() => invalidatePhotoCaches(queryClient)}
      />
    </>
  );
}
