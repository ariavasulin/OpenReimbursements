"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import GroupByToggle from "@/components/photos/group-by-toggle";
import InfiniteSentinel from "@/components/photos/infinite-sentinel";
import PhotoGrid from "@/components/photos/photo-grid";
import PhotoLightbox from "@/components/photos/photo-lightbox";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { useLightboxByPhotoId } from "@/hooks/use-photo-deep-link";
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

export default function PhotoSearchPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const q = useSearchParams().get("q")?.trim() ?? "";
  // One search box per route: the phone one below, the TopBar's at desktop.
  // Both are the shell's `query`, so the rail, the box and `?q=` never
  // disagree — and the box is seeded from `?q=` on a pasted link.
  const { query, setQuery } = usePhotosShell();
  const [groupBy, setGroupBy] = useState<GroupBy>("job");

  useEffect(() => setQuery(q), [q, setQuery]);
  // The string is the shell's, and it outlives this route: left alone it
  // becomes the job filter on /photos and the rail, and picks the "most
  // recent job" desktop lands on. Hand it back empty.
  useEffect(() => () => setQuery(""), [setQuery]);

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

  const { setOpenPhotoId, lightboxProps } =
    useLightboxByPhotoId(openablePhotos);

  const submit = () => {
    const next = query.trim();
    // Replace, not push: refining a search on this route must not make Back
    // walk every intermediate query. The TopBar box does the same here.
    if (next) router.replace(photoSearchHref(next));
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-5 lg:max-w-6xl lg:px-8 desktop:max-w-none desktop:px-8 desktop:pb-8">
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
      {/* A failed next page is the sentinel's to report; see the job page. */}
      {error && !isFetchNextPageError && (
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

      {/* TODO(#12): /photos/search mounts the viewer without the ?photo= URL contract (usePhotoDeepLink/useResolvePhotoDeepLink); a cross-job route needs its own resolve semantics before it can share it. */}
      <PhotoLightbox
        {...lightboxProps}
        onChanged={() => invalidatePhotoCaches(queryClient)}
      />
    </main>
  );
}
