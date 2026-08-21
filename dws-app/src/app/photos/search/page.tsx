"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import GroupByToggle from "@/components/photos/group-by-toggle";
import LoadMoreButton from "@/components/photos/load-more-button";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import SearchInput from "@/components/photos/search-input";
import StatusLine from "@/components/photos/status-line";
import { fetchPhotosPage, invalidatePhotoCaches } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import {
  groupPhotos,
  openableInDisplayOrder,
  type GroupBy,
} from "@/lib/photos/group";

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
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q });
      if (pageParam) params.set("cursor", pageParam);
      return fetchPhotosPage(params);
    },
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

  const groups = useMemo(() => groupPhotos(photos, groupBy), [photos, groupBy]);
  const openablePhotos = useMemo(() => openableInDisplayOrder(groups), [groups]);

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

      <SearchInput value={input} onChange={setInput} onSubmit={submit} />

      {q && !isLoading && !error && (
        <p className="mb-2 text-xs text-[#a0a0a0]">
          {photos.length === 0
            ? `No photos match "${q}"`
            : `${
                hasNextPage
                  ? `${photos.length}+ photos`
                  : plural(photos.length, "photo")
              } across ${plural(jobCount, "job")} · "${q}"`}
        </p>
      )}

      <GroupByToggle
        modes={["job", "date", "sheet"] as const}
        value={groupBy}
        onChange={(mode) => setGroupBy(mode)}
      />

      {!q && <StatusLine>Search for a job, a person, or a tag.</StatusLine>}
      {isLoading && q && <StatusLine>Searching...</StatusLine>}
      {error && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Search failed"}
        </StatusLine>
      )}

      <PhotoGrid
        groups={groups}
        groupBy={groupBy}
        onOpenPhoto={(photo) =>
          setLightboxIndex(openablePhotos.findIndex((p) => p.id === photo.id))
        }
      />

      {hasNextPage && (
        <LoadMoreButton
          onClick={() => fetchNextPage()}
          loading={isFetchingNextPage}
        />
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
