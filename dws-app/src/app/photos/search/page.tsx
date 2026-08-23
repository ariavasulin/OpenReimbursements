"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import GroupByToggle from "@/components/photos/group-by-toggle";
import InfiniteSentinel from "@/components/photos/infinite-sentinel";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import SearchInput from "@/components/photos/search-input";
import StatusLine from "@/components/photos/status-line";
import { fetchPhotosPage, invalidatePhotoCaches } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { photoSearchHref } from "@/lib/photos/photo-link";
import {
  groupPhotos,
  openableInDisplayOrder,
  type GroupBy,
} from "@/lib/photos/group";

function SearchResults() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const q = useSearchParams().get("q")?.trim() ?? "";
  // One search box per route: the phone one below, the TopBar's at desktop.
  // Both are the shell's `query`, so the rail, the box and `?q=` never
  // disagree — and the box is seeded from `?q=` on a pasted link.
  const { query, setQuery } = usePhotosShell();
  const [groupBy, setGroupBy] = useState<GroupBy>("job");
  // The open photo is identified by id, never by list position: an edit that
  // moves it to another job shrinks the set, and the same index would then
  // address a different photo.
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);

  useEffect(() => setQuery(q), [q, setQuery]);

  const {
    data,
    error,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: ["photo-search", q],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q });
      if (pageParam) params.set("cursor", pageParam);
      return fetchPhotosPage(params);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: q.length > 0,
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

  // -1 once the open photo leaves the set (reassigned, or edited out of the
  // query), which closes the viewer instead of silently sliding to whoever
  // took its slot.
  const lightboxIndex =
    openPhotoId === null
      ? -1
      : openablePhotos.findIndex((photo) => photo.id === openPhotoId);
  const lightboxOpen = lightboxIndex !== -1;

  const submit = () => {
    const next = query.trim();
    // Replace, not push: refining a search on this route must not make Back
    // walk every intermediate query. The TopBar box does the same here.
    if (next) router.replace(photoSearchHref(next));
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-5 lg:max-w-6xl lg:px-8 desktop:max-w-none desktop:px-8 desktop:pb-8">
      {/* The rail replaces this back link at desktop. */}
      <Link
        href="/photos"
        className="desktop:hidden mb-2 block text-[13px] text-[#2680FC] hover:text-[#1a6fd8]"
      >
        &lsaquo; All jobs
      </Link>

      <div className="desktop:hidden">
        <SearchInput value={query} onChange={setQuery} onSubmit={submit} />
      </div>

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
        onOpenPhoto={(photo) => setOpenPhotoId(photo.id)}
      />

      <InfiniteSentinel
        hasNextPage={hasNextPage}
        isFetching={isFetchingNextPage}
        failed={isFetchNextPageError}
        onVisible={() => fetchNextPage()}
      />

      <PhotoLightbox
        photos={openablePhotos}
        open={lightboxOpen}
        index={lightboxOpen ? lightboxIndex : 0}
        onIndexChange={(next) =>
          setOpenPhotoId(openablePhotos[next]?.id ?? null)
        }
        onClose={() => setOpenPhotoId(null)}
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
