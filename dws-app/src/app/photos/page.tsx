"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import JobCard from "@/components/photos/job-card";
import { CaptureBar, useCaptureBatch } from "@/components/photos/capture-bar";
import SearchInput from "@/components/photos/search-input";
import StatusLine from "@/components/photos/status-line";
import UploadSheet from "@/components/photos/upload-sheet";
import { fetchJobs, invalidatePhotoCaches } from "@/lib/photos/api";

export default function PhotosHomePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ready = useSessionGuard("/photos");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const batch = useCaptureBatch();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data: jobs,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["photo-jobs", debouncedSearch],
    queryFn: () => fetchJobs(debouncedSearch),
    enabled: ready,
  });

  if (!ready) return <AuthLoading />;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-5">
      <header className="relative mb-3 text-center">
        <div className="text-[15px] font-semibold tracking-wide">
          DWS <span className="text-[#2680FC]">Photos</span>
        </div>
        <a
          href="/employee"
          className="absolute right-0 top-0 text-[13px] text-[#2680FC] hover:text-[#1a6fd8]"
        >
          Receipts
        </a>
      </header>

      <SearchInput
        value={search}
        onChange={setSearch}
        onSubmit={() => {
          if (search.trim()) {
            router.push(`/photos/search?q=${encodeURIComponent(search.trim())}`);
          }
        }}
      />

      {debouncedSearch ? (
        <Link
          href={`/photos/search?q=${encodeURIComponent(debouncedSearch)}`}
          className="mb-3 block text-xs text-[#2680FC] hover:text-[#1a6fd8]"
        >
          Search all photos for &ldquo;{debouncedSearch}&rdquo; ›
        </Link>
      ) : (
        <div className="mb-1" />
      )}

      {isLoading && <StatusLine>Loading jobs...</StatusLine>}
      {error && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load jobs"}
        </StatusLine>
      )}
      {jobs && jobs.length === 0 && (
        <StatusLine>
          {debouncedSearch
            ? `No jobs match "${debouncedSearch}"`
            : "No jobs yet"}
        </StatusLine>
      )}

      <div className="space-y-2.5">
        {jobs?.map((job) => <JobCard key={job.id} job={job} />)}
      </div>

      <CaptureBar batch={batch} maxWidthClass="max-w-2xl" />

      <UploadSheet
        files={batch.pickedFiles}
        open={batch.sheetOpen}
        onOpenChange={batch.setSheetOpen}
        onUploaded={() => invalidatePhotoCaches(queryClient)}
        capturedAtOverrides={batch.capturedAtOverrides}
      />
    </main>
  );
}
