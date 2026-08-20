"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import PhotoGrid from "@/components/photos/photo-grid";
import UploadSheet, { pickerAccept } from "@/components/photos/upload-sheet";
import type { PhotoJobSummary, PhotoRow } from "@/lib/photos/types";

// One job's photos: date-grouped grid (newest first) + the Upload flow.
// Guard is session-only — no role gate (admins use this page too).

interface PhotosPage {
  photos: PhotoRow[];
  nextCursor: string | null;
}

async function fetchPhotosPage(
  jobId: string,
  cursor: string | null
): Promise<PhotosPage> {
  const params = new URLSearchParams({ job: jobId });
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

export default function JobPhotosPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

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

  const {
    data,
    error,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["photos", jobId],
    queryFn: ({ pageParam }) => fetchPhotosPage(jobId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: ready && Boolean(jobId),
  });

  const photos = data?.pages.flatMap((page) => page.photos) ?? [];

  const handleFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-picking the same files
    if (files.length > 0) {
      setPickedFiles(files);
      setSheetOpen(true);
    }
  };

  const refetchPhotos = () => {
    queryClient.invalidateQueries({ queryKey: ["photos", jobId] });
    queryClient.invalidateQueries({ queryKey: ["photo-jobs"] });
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
          : " "}
      </p>

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
          No photos yet — upload the first one.
        </p>
      )}

      <PhotoGrid photos={photos} />

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
    </main>
  );
}
