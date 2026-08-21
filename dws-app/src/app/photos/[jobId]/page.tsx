"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CaptureBar, useCaptureBatch } from "@/components/photos/capture-bar";
import GroupByToggle from "@/components/photos/group-by-toggle";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import UploadSheet from "@/components/photos/upload-sheet";
import {
  fetchJobs,
  fetchPhotosPage,
  fetchTags,
  invalidatePhotoCaches,
} from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { groupPhotos, openableInDisplayOrder } from "@/lib/photos/group";

// One job's photos: grouped grid, filter chips, the pinned Professional
// Photography section, the lightbox, and the Upload flow.

const PINNED_TAG = "professional";

interface Filters {
  sheet: string | null;
  uploader: { id: string; name: string } | null;
  tag: string | null;
}

const NO_FILTERS: Filters = { sheet: null, uploader: null, tag: null };

const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-1.5 text-xs ${
    active
      ? "border-[#2680FC] bg-[#2680FC] text-white"
      : "border-[#4e4e4e] bg-[#2e2e2e] text-[#d0d0d0]"
  }`;

interface SeenOptions {
  sheets: Set<string>;
  uploaders: Map<string, string>;
}

function FilterChip({
  label,
  active,
  options,
  onSelect,
  onClear,
}: {
  label: string;
  active: string | null;
  options: { value: string; label: string }[];
  onSelect(value: string): void;
  onClear(): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1 ${chipClass(Boolean(active))}`}
        >
          {active ?? label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="border-[#4e4e4e] bg-[#2e2e2e] text-white">
        {active && (
          <DropdownMenuItem
            onClick={onClear}
            className="text-[#a0a0a0] focus:bg-[#3e3e3e] focus:text-white"
          >
            Clear {label.toLowerCase()}
          </DropdownMenuItem>
        )}
        {options.length === 0 && (
          <DropdownMenuItem disabled className="text-[#7e7e7e]">
            None yet
          </DropdownMenuItem>
        )}
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSelect(option.value)}
            className="focus:bg-[#3e3e3e] focus:text-white"
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function JobPhotosPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const queryClient = useQueryClient();
  const ready = useSessionGuard(`/photos/${jobId}`);
  const batch = useCaptureBatch();
  const [groupBy, setGroupBy] = useState<"date" | "sheet">("date");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Filter options accumulate from every page of photos seen for this job,
  // so picking a filter doesn't shrink the menus to the filtered set.
  const [seen, setSeen] = useState<SeenOptions>(() => ({
    sheets: new Set(),
    uploaders: new Map(),
  }));

  const { data: jobs } = useQuery({
    queryKey: ["photo-jobs", ""],
    queryFn: () => fetchJobs(),
    enabled: ready,
  });
  const job = jobs?.find((candidate) => candidate.id === jobId);

  const { data: jobTags } = useQuery({
    queryKey: ["photo-tags", jobId],
    queryFn: () => fetchTags(jobId),
    enabled: ready,
  });

  const {
    data,
    error,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
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
    enabled: ready,
  });

  const photos = useMemo(
    () => data?.pages.flatMap((page) => page.photos) ?? [],
    [data]
  );

  // Remember every sheet/uploader we've seen on this job for the chip menus.
  useEffect(() => {
    setSeen((previous) => {
      let changed = false;
      const sheets = new Set(previous.sheets);
      const uploaders = new Map(previous.uploaders);
      for (const photo of photos) {
        const sheet = photo.sheet_number?.trim();
        if (sheet && !sheets.has(sheet)) {
          sheets.add(sheet);
          changed = true;
        }
        const name = photo.uploader?.full_name;
        if (name && uploaders.get(photo.uploader_id) !== name) {
          uploaders.set(photo.uploader_id, name);
          changed = true;
        }
      }
      return changed ? { sheets, uploaders } : previous;
    });
  }, [photos]);

  const sheetOptions = [...seen.sheets]
    .sort((a, b) => Number(b) - Number(a) || a.localeCompare(b))
    .map((sheet) => ({ value: sheet, label: `Sheet ${sheet}` }));
  const uploaderOptions = [...seen.uploaders.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ value: id, label: name }));
  const tagOptions = (jobTags ?? []).map((tag) => ({ value: tag, label: tag }));

  const groups = useMemo(() => groupPhotos(photos, groupBy), [photos, groupBy]);
  // The lightbox flips through the set as displayed: grouped order, images
  // with previews only (file tiles download instead).
  const openablePhotos = useMemo(() => openableInDisplayOrder(groups), [groups]);

  const noFiltersActive = !filters.sheet && !filters.uploader && !filters.tag;

  const refetchPhotos = () => invalidatePhotoCaches(queryClient);

  if (!ready) return <AuthLoading />;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-5">
      <Link
        href="/photos"
        className="mb-2 block text-[13px] text-[#2680FC] hover:text-[#1a6fd8]"
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

      <div className="mb-3 flex flex-wrap gap-1.5">
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

      <GroupByToggle
        modes={["date", "sheet"] as const}
        value={groupBy}
        onChange={(mode) => setGroupBy(mode)}
      />

      {isLoading && (
        <p className="py-8 text-center text-sm text-[#a0a0a0]">
          Loading photos...
        </p>
      )}
      {error && (
        <p className="py-8 text-center text-sm text-red-400">
          {error instanceof Error ? error.message : "Failed to load photos"}
        </p>
      )}
      {!isLoading && !error && photos.length === 0 && (
        <p className="py-8 text-center text-sm text-[#a0a0a0]">
          {noFiltersActive
            ? "No photos yet — upload the first one."
            : "No photos match these filters."}
        </p>
      )}

      <PhotoGrid
        groups={groups}
        groupBy={groupBy}
        onOpenPhoto={setLightboxIndex}
        pinnedTag={noFiltersActive ? PINNED_TAG : undefined}
        pinnedLabel="Professional Photography"
        onExpandPinned={() =>
          setFilters((previous) => ({ ...previous, tag: PINNED_TAG }))
        }
      />

      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-4 w-full rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] py-2.5 text-sm text-white hover:border-[#2680FC]"
        >
          {isFetchingNextPage ? "Loading..." : "Load more"}
        </button>
      )}

      <CaptureBar
        batch={batch}
        maxWidthClass="max-w-3xl"
        inputId="photos-upload-input"
      />

      <UploadSheet
        files={batch.pickedFiles}
        open={batch.sheetOpen}
        onOpenChange={batch.setSheetOpen}
        defaultJobId={jobId}
        onUploaded={refetchPhotos}
        capturedAtOverrides={batch.capturedAtOverrides}
      />

      <PhotoLightbox
        photos={openablePhotos}
        open={lightboxIndex !== null}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onChanged={refetchPhotos}
      />
    </main>
  );
}
