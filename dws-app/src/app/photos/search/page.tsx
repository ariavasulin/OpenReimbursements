"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import GroupByToggle from "@/components/photos/group-by-toggle";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import { fetchJson, invalidatePhotoCaches } from "@/lib/photos/api";
import { groupPhotos, type GroupBy } from "@/lib/photos/group";
import { isOpenable } from "@/lib/photos/urls";
import type { PhotoRow } from "@/lib/photos/types";

// Cross-job search results grouped by job by default (regroupable by date or
// sheet).

interface PhotosPage {
  photos: PhotoRow[];
  nextCursor: string | null;
}

async function fetchSearchPage(
  q: string,
  cursor: string | null
): Promise<PhotosPage> {
  const params = new URLSearchParams({ q });
  if (cursor) params.set("cursor", cursor);
  return fetchJson<PhotosPage>(`/api/photos?${params}`, "Search failed");
}

function SearchResults() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const q = useSearchParams().get("q")?.trim() ?? "";
  const ready = useSessionGuard(`/photos/search?q=${q}`);
  const [input, setInput] = useState(q);
  const [groupBy, setGroupBy] = useState<GroupBy>("job");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => setInput(q), [q]);

  const {
    data,
    error,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["photo-search", q],
    queryFn: ({ pageParam }) => fetchSearchPage(q, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: ready && q.length > 0,
  });

  const photos = useMemo(
    () => data?.pages.flatMap((page) => page.photos) ?? [],
    [data]
  );
  const jobCount = useMemo(
    () => new Set(photos.map((photo) => photo.job_id)).size,
    [photos]
  );

  const openablePhotos = useMemo(() => {
    const flattened = groupPhotos(photos, groupBy).flatMap(
      (group) => group.photos
    );
    return flattened.filter(isOpenable);
  }, [photos, groupBy]);

  const submit = () => {
    const next = input.trim();
    if (next) router.replace(`/photos/search?q=${encodeURIComponent(next)}`);
  };

  if (!ready) return <AuthLoading />;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-5">
      <Link
        href="/photos"
        className="mb-2 block text-[13px] text-[#2680FC] hover:text-[#1a6fd8]"
      >
        &lsaquo; All jobs
      </Link>

      <input
        type="search"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        placeholder="Search jobs, people, or tags..."
        className="mb-2 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
      />

      {q && !isLoading && !error && (
        <p className="mb-2 text-xs text-[#a0a0a0]">
          {photos.length === 0
            ? `No photos match "${q}"`
            : `${photos.length}${hasNextPage ? "+" : ""} ${
                photos.length === 1 ? "photo" : "photos"
              } across ${jobCount} ${jobCount === 1 ? "job" : "jobs"} · "${q}"`}
        </p>
      )}

      <GroupByToggle
        modes={["job", "date", "sheet"] as const}
        value={groupBy}
        onChange={(mode) => setGroupBy(mode)}
      />

      {!q && (
        <p className="py-8 text-center text-sm text-[#a0a0a0]">
          Search for a job, a person, or a tag.
        </p>
      )}
      {isLoading && q && (
        <p className="py-8 text-center text-sm text-[#a0a0a0]">Searching...</p>
      )}
      {error && (
        <p className="py-8 text-center text-sm text-red-400">
          {error instanceof Error ? error.message : "Search failed"}
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

      <PhotoLightbox
        photos={openablePhotos}
        open={lightboxIndex !== null}
        index={lightboxIndex ?? 0}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onChanged={() => invalidatePhotoCaches(queryClient)}
      />
    </main>
  );
}

export default function PhotoSearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center px-4 py-8">
          <p className="text-sm text-[#a0a0a0]">Loading...</p>
        </div>
      }
    >
      <SearchResults />
    </Suspense>
  );
}
