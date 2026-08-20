"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import UploadSheet, { pickerAccept } from "@/components/photos/upload-sheet";
import { groupPhotos } from "@/lib/photos/group";
import { isOpenable } from "@/lib/photos/urls";
import type { PhotoJobSummary, PhotoRow } from "@/lib/photos/types";

// One job's photos: grouped grid (date default, sheet regroup), filter chips
// (sheet / uploader / tags — the "subfolders", implemented as filters), the
// pinned Professional Photography section, the lightbox, and the Upload flow.
// Guard is session-only — no role gate (admins use this page too).

const PINNED_TAG = "professional";

interface PhotosPage {
  photos: PhotoRow[];
  nextCursor: string | null;
}

interface Filters {
  sheet: string | null;
  uploader: { id: string; name: string } | null;
  tag: string | null;
}

const NO_FILTERS: Filters = { sheet: null, uploader: null, tag: null };

async function fetchPhotosPage(
  jobId: string,
  filters: Filters,
  cursor: string | null
): Promise<PhotosPage> {
  const params = new URLSearchParams({ job: jobId });
  if (filters.sheet) params.set("sheet", filters.sheet);
  if (filters.uploader) params.set("uploader", filters.uploader.id);
  if (filters.tag) params.set("tags", filters.tag);
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/photos?${params}`);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `Failed to load photos (${response.status})`);
  }
  return (await response.json()) as PhotosPage;
}

async function fetchJobs(): Promise<PhotoJobSummary[]> {
  const response = await fetch("/api/photo-jobs");
  if (!response.ok) throw new Error("Failed to load job");
  return (await response.json()).jobs as PhotoJobSummary[];
}

async function fetchJobTags(jobId: string): Promise<string[]> {
  const response = await fetch(`/api/photo-tags?job=${jobId}`);
  if (!response.ok) throw new Error("Failed to load tags");
  return (await response.json()).tags as string[];
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
          className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs ${
            active
              ? "border-[#2680FC] bg-[#2680FC] text-white"
              : "border-[#4e4e4e] bg-[#2e2e2e] text-[#d0d0d0]"
          }`}
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
  const [ready, setReady] = useState(false);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<"date" | "sheet">("date");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  // Filter options accumulate from every page of photos seen for this job,
  // so picking a filter doesn't shrink the menus to the filtered set.
  const seenSheetsRef = useRef(new Set<string>());
  const seenUploadersRef = useRef(new Map<string, string>());

  useEffect(() => {
    mountedRef.current = true;
    const guard = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mountedRef.current) return;
      if (!session) {
        window.location.replace(`/login?next=/photos/${jobId}`);
        return;
      }
      setReady(true);
    };
    guard();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          window.location.replace(`/login?next=/photos/${jobId}`);
        }
      }
    );
    return () => {
      mountedRef.current = false;
      authListener?.subscription?.unsubscribe();
    };
  }, [jobId]);

  const { data: jobs } = useQuery({
    queryKey: ["photo-jobs", ""],
    queryFn: fetchJobs,
    enabled: ready,
  });
  const job = jobs?.find((candidate) => candidate.id === jobId);

  const { data: jobTags } = useQuery({
    queryKey: ["photo-tags", jobId],
    queryFn: () => fetchJobTags(jobId),
    enabled: ready && Boolean(jobId),
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
    queryFn: ({ pageParam }) => fetchPhotosPage(jobId, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: ready && Boolean(jobId),
  });

  const photos = useMemo(
    () => data?.pages.flatMap((page) => page.photos) ?? [],
    [data]
  );

  // Remember every sheet/uploader we've seen on this job for the chip menus.
  useEffect(() => {
    for (const photo of photos) {
      if (photo.sheet_number?.trim()) {
        seenSheetsRef.current.add(photo.sheet_number.trim());
      }
      if (photo.uploader?.full_name) {
        seenUploadersRef.current.set(photo.uploader_id, photo.uploader.full_name);
      }
    }
  }, [photos]);

  const sheetOptions = [...seenSheetsRef.current]
    .sort((a, b) => Number(b) - Number(a) || a.localeCompare(b))
    .map((sheet) => ({ value: sheet, label: `Sheet ${sheet}` }));
  const uploaderOptions = [...seenUploadersRef.current.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ value: id, label: name }));
  const tagOptions = (jobTags ?? []).map((tag) => ({ value: tag, label: tag }));

  // The lightbox flips through the set as displayed: grouped order, images
  // with previews only (file tiles download instead).
  const openablePhotos = useMemo(() => {
    const flattened = groupPhotos(photos, groupBy).flatMap(
      (group) => group.photos
    );
    return flattened.filter(isOpenable);
  }, [photos, groupBy]);

  const noFiltersActive = !filters.sheet && !filters.uploader && !filters.tag;

  const handleFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-picking the same files
    if (files.length > 0) {
      setPickedFiles(files);
      setSheetOpen(true);
    }
  };

  const refetchPhotos = () => {
    queryClient.invalidateQueries({ queryKey: ["photos"] });
    queryClient.invalidateQueries({ queryKey: ["photo-jobs"] });
    queryClient.invalidateQueries({ queryKey: ["photo-tags"] });
  };

  if (!ready) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-8">
        <div className="text-center">
          <p className="mb-2 text-lg">Loading...</p>
          <p className="text-sm text-gray-400">Verifying authentication</p>
        </div>
      </div>
    );
  }

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
          ? `${job.photo_count === 1 ? "1 photo" : `${job.photo_count} photos`}${
              job.location ? ` · ${job.location}` : ""
            }`
          : " "}
      </p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setFilters(NO_FILTERS)}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            noFiltersActive
              ? "border-[#2680FC] bg-[#2680FC] text-white"
              : "border-[#4e4e4e] bg-[#2e2e2e] text-[#d0d0d0]"
          }`}
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
                name: seenUploadersRef.current.get(value) ?? "Uploader",
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

      <div className="mb-1 flex overflow-hidden rounded-lg border border-[#4e4e4e] bg-[#2e2e2e]">
        {(["date", "sheet"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setGroupBy(mode)}
            className={`flex-1 py-1.5 text-xs capitalize ${
              groupBy === mode
                ? "bg-[#3e3e3e] font-semibold text-white"
                : "text-[#a0a0a0]"
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

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
        photos={photos}
        groupBy={groupBy}
        onOpenPhoto={(photo) => {
          const index = openablePhotos.findIndex(
            (candidate) => candidate.id === photo.id
          );
          if (index >= 0) setLightboxIndex(index);
        }}
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

      <div className="fixed bottom-4 left-0 right-0 mx-auto w-full max-w-3xl px-4">
        <input
          ref={fileInputRef}
          id="photos-upload-input"
          type="file"
          multiple
          accept={pickerAccept()}
          onChange={handleFilesPicked}
          className="sr-only"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full rounded-lg bg-[#2680FC] py-3 text-sm font-medium text-white shadow-lg hover:bg-[#1a6fd8]"
        >
          Upload
        </button>
      </div>

      <UploadSheet
        files={pickedFiles}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        defaultJobId={jobId}
        onUploaded={refetchPhotos}
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
