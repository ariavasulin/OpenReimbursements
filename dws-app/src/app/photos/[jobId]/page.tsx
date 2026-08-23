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
import FilterBar, {
  FilterChip,
  chipClass,
} from "@/components/photos/filter-bar";
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
  // The open photo is identified by id, never by list position: an edit that
  // moves it to another job shrinks the set, and the same index would then
  // address a different photo.
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);

  // Filter options accumulate from every page of photos seen for this job,
  // so picking a filter doesn't shrink the menus to the filtered set.
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

  // Remember every sheet/uploader we've seen on this job for the chip menus.
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

  // -1 once the open photo leaves the set (reassigned to another job), which
  // closes the viewer instead of silently sliding to whoever took its slot.
  const lightboxIndex =
    openPhotoId === null
      ? -1
      : openablePhotos.findIndex((photo) => photo.id === openPhotoId);
  const lightboxOpen = lightboxIndex !== -1;

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
    onPopOpen: setOpenPhotoId,
  });

  const noFiltersActive = !filters.sheet && !filters.uploader && !filters.tag;

  const refetchPhotos = () => invalidatePhotoCaches(queryClient);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-5 lg:max-w-6xl lg:px-8 desktop:max-w-none desktop:px-8 desktop:pb-8">
      {/* The rail replaces this back link at desktop. */}
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

      <FilterBar
        groupModes={["date", "sheet"] as const}
        groupBy={groupBy}
        onGroupByChange={(mode) => setGroupBy(mode)}
      >
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
      </FilterBar>

      {isLoading && <StatusLine>Loading photos...</StatusLine>}
      {error && (
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

      <PhotoLightbox
        photos={openablePhotos}
        open={lightboxOpen}
        index={lightboxOpen ? lightboxIndex : 0}
        onIndexChange={(next) =>
          setOpenPhotoId(openablePhotos[next]?.id ?? null)
        }
        onClose={() => setOpenPhotoId(null)}
        onChanged={refetchPhotos}
      />
    </main>
  );
}
