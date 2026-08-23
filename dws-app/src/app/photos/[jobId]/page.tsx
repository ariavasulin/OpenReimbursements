"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CaptureBar } from "@/components/photos/capture-bar";
import { FilterChip, chipClass } from "@/components/photos/filter-bar";
import GroupByToggle from "@/components/photos/group-by-toggle";
import InfiniteSentinel from "@/components/photos/infinite-sentinel";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import StatusLine from "@/components/photos/status-line";
import {
  fetchPhotosPage,
  fetchTags,
  invalidatePhotoCaches,
  usePhotoJobs,
} from "@/lib/photos/api";
import {
  accumulateSeenOptions,
  emptySeenOptions,
  toSheetOptions,
  toUploaderOptions,
  type SeenOptions,
} from "@/lib/photos/filter-options";
import { plural } from "@/lib/photos/format";
import { groupPhotos, openableInDisplayOrder } from "@/lib/photos/group";
import {
  useLightboxByPhotoId,
  usePhotoDeepLink,
  useResolvePhotoDeepLink,
} from "@/hooks/use-photo-deep-link";

const PINNED_TAG = "professional";

interface Filters {
  sheet: string | null;
  uploader: { id: string; name: string } | null;
  tag: string | null;
}

const NO_FILTERS: Filters = { sheet: null, uploader: null, tag: null };

export default function JobPhotosPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const queryClient = useQueryClient();
  const [groupBy, setGroupBy] = useState<"date" | "sheet">("date");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [seen, setSeen] = useState<SeenOptions>(emptySeenOptions);

  // Always enabled: the shell holds the session guard, so this page only
  // renders once the session is ready.
  const { data: jobs } = usePhotoJobs(true);
  const job = jobs?.find((candidate) => candidate.id === jobId);

  const { data: jobTags } = useQuery({
    queryKey: ["photo-tags", jobId],
    queryFn: () => fetchTags(jobId),
  });

  const {
    data,
    error,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: [
      "photos",
      jobId,
      filters.sheet,
      filters.uploader?.id ?? null,
      filters.tag,
    ],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ job: jobId });
      if (filters.sheet) params.set("sheet", filters.sheet);
      if (filters.uploader) params.set("uploader", filters.uploader.id);
      if (filters.tag) params.set("tags", filters.tag);
      if (pageParam) params.set("cursor", pageParam);
      return fetchPhotosPage(params);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const photos = useMemo(
    () => data?.pages.flatMap((page) => page.photos) ?? [],
    [data]
  );

  useEffect(() => {
    setSeen((previous) => accumulateSeenOptions(previous, photos));
  }, [photos]);

  // Keyed on `seen`, which only changes when a page brings a new sheet or
  // uploader — otherwise every scroll-appended page would re-partition and
  // re-sort the whole accumulated set.
  const sheetOptions = useMemo(() => toSheetOptions(seen), [seen]);
  const uploaderOptions = useMemo(() => toUploaderOptions(seen), [seen]);
  const tagOptions = (jobTags ?? []).map((tag) => ({ value: tag, label: tag }));

  const groups = useMemo(() => groupPhotos(photos, groupBy), [photos, groupBy]);
  // The lightbox flips through the set as displayed: grouped order, images
  // with previews only (file tiles download instead).
  const openablePhotos = useMemo(() => openableInDisplayOrder(groups), [groups]);

  const {
    openPhotoId,
    setOpenPhotoId,
    isOpen: lightboxOpen,
    lightboxProps,
  } = useLightboxByPhotoId(openablePhotos);

  useResolvePhotoDeepLink({
    photos: openablePhotos,
    pagesLoaded: data?.pages.length ?? 0,
    isFetching: isLoading || isFetchingNextPage,
    hasNextPage,
    fetchFailed: isFetchNextPageError,
    fetchNextPage,
    isLightboxOpen: lightboxOpen,
    onResolve: setOpenPhotoId,
  });

  usePhotoDeepLink({
    openPhotoId: lightboxOpen ? openPhotoId : null,
    onPopClose: () => setOpenPhotoId(null),
    onPopOpen: (photoId) => {
      if (!openablePhotos.some((candidate) => candidate.id === photoId)) {
        return false;
      }
      setOpenPhotoId(photoId);
      return true;
    },
  });

  const noFiltersActive = !filters.sheet && !filters.uploader && !filters.tag;

  const refetchPhotos = () => invalidatePhotoCaches(queryClient);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-5 lg:max-w-6xl lg:px-8 desktop:max-w-none desktop:px-8 desktop:pb-8">
      <Link
        href="/photos"
        className="desktop:hidden mb-2 block text-[13px] text-[#2680FC] hover:text-[#1a6fd8]"
      >
        &lsaquo; All jobs
      </Link>

      <h1 className="text-[17px] font-semibold">
        {job ? (
          <>
            <span className="text-[#2680FC]">#{job.job_number}</span> ·{" "}
            {job.name}
          </>
        ) : (
          "Job"
        )}
      </h1>
      <p className="mb-3 text-xs text-[#a0a0a0]">
        {job
          ? `${plural(job.photo_count, "photo")}${
              job.location ? ` · ${job.location}` : ""
            }`
          : " "}
      </p>

      <div className="desktop:mb-1 desktop:flex desktop:items-center desktop:justify-between desktop:gap-3">
        <div className="mb-3 flex flex-wrap gap-1.5 desktop:mb-0">
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className={chipClass(noFiltersActive)}
          >
            All
          </button>
          <FilterChip
            label="Sheet"
            active={filters.sheet ? `Sheet ${filters.sheet}` : null}
            options={sheetOptions}
            onSelect={(value) =>
              setFilters((previous) => ({ ...previous, sheet: value }))
            }
            onClear={() =>
              setFilters((previous) => ({ ...previous, sheet: null }))
            }
          />
          <FilterChip
            label="Uploader"
            active={filters.uploader?.name ?? null}
            options={uploaderOptions}
            onSelect={(value) =>
              setFilters((previous) => ({
                ...previous,
                uploader: {
                  id: value,
                  name: seen.uploaders.get(value) ?? "Uploader",
                },
              }))
            }
            onClear={() =>
              setFilters((previous) => ({ ...previous, uploader: null }))
            }
          />
          <FilterChip
            label="Tags"
            active={filters.tag}
            options={tagOptions}
            onSelect={(value) =>
              setFilters((previous) => ({ ...previous, tag: value }))
            }
            onClear={() => setFilters((previous) => ({ ...previous, tag: null }))}
          />
        </div>
        {/* Block-level at phone width (full-width segmented control); a
            shrink-to-fit flex item in the desktop row. */}
        <div className="desktop:shrink-0">
          <GroupByToggle
            modes={["date", "sheet"] as const}
            value={groupBy}
            onChange={(mode) => setGroupBy(mode)}
          />
        </div>
      </div>

      {isLoading && <StatusLine>Loading photos...</StatusLine>}
      {/* A failed next page is the sentinel's to report (it keeps the loaded
          grid and offers retry); the banner is for the first page only. */}
      {error && !isFetchNextPageError && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load photos"}
        </StatusLine>
      )}
      {!isLoading && !error && photos.length === 0 && (
        <StatusLine>
          {noFiltersActive
            ? "No photos yet — upload the first one."
            : "No photos match these filters."}
        </StatusLine>
      )}

      <PhotoGrid
        groups={groups}
        groupBy={groupBy}
        onOpenPhoto={(photo) => setOpenPhotoId(photo.id)}
        pinnedTag={noFiltersActive ? PINNED_TAG : undefined}
        pinnedLabel="Professional Photography"
        onExpandPinned={() =>
          setFilters((previous) => ({ ...previous, tag: PINNED_TAG }))
        }
      />

      <InfiniteSentinel
        hasNextPage={hasNextPage}
        isFetching={isFetchingNextPage}
        failed={isFetchNextPageError}
        onVisible={() => fetchNextPage()}
      />

      <CaptureBar maxWidthClass="max-w-3xl" />

      <PhotoLightbox {...lightboxProps} onChanged={refetchPhotos} />
    </main>
  );
}
