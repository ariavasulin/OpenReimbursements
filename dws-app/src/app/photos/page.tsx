"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDesktop } from "@/hooks/use-desktop";
import { signOut } from "@/hooks/use-session-guard";
import JobCard from "@/components/photos/job-card";
import { CaptureBar } from "@/components/photos/capture-bar";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import SearchInput from "@/components/photos/search-input";
import StatusLine from "@/components/photos/status-line";
import { usePhotoJobs } from "@/lib/photos/api";
import { photoSearchHref } from "@/lib/photos/photo-link";

export default function PhotosHomePage() {
  const router = useRouter();
  const isDesktop = useDesktop();
  // Job search state lives on the shell, shared with the desktop TopBar input
  // and the jobs rail, so all of them agree and there is one fetch.
  const { query, setQuery, debouncedQuery } = usePhotosShell();

  const {
    data: jobs,
    isLoading,
    error,
  } = usePhotoJobs(true, debouncedQuery);

  // At desktop the rail is already the job list, so this page would show the
  // same jobs twice. Land on the most recent one instead. replace(), not
  // push(): Back from a job must not bounce straight back here and forward
  // again. With no jobs there is nowhere to go, so the empty state still
  // renders.
  const firstJobId = jobs?.[0]?.id;
  const goingToFirstJob = isDesktop && firstJobId !== undefined;

  useEffect(() => {
    if (goingToFirstJob) router.replace(`/photos/${firstJobId}`);
  }, [goingToFirstJob, firstJobId, router]);

  // Also while loading at desktop: a cold load would otherwise paint the
  // overview this route is about to leave.
  if (goingToFirstJob || (isDesktop && isLoading)) return null;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-5 lg:max-w-6xl lg:px-8 desktop:max-w-none desktop:px-8 desktop:pb-8">
      <header className="desktop:hidden relative mb-3 text-center">
        <button
          type="button"
          onClick={signOut}
          className="absolute left-0 top-0 text-[13px] text-[#a0a0a0] hover:text-white"
        >
          Sign out
        </button>
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

      <div className="desktop:hidden">
        <SearchInput
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            if (query.trim()) {
              router.push(photoSearchHref(query.trim()));
            }
          }}
        />
      </div>

      {debouncedQuery && (
        <Link
          href={photoSearchHref(debouncedQuery)}
          className="desktop:hidden mb-3 block text-xs text-[#2680FC] hover:text-[#1a6fd8]"
        >
          Search all photos for &ldquo;{debouncedQuery}&rdquo; ›
        </Link>
      )}

      {isLoading && <StatusLine>Loading jobs...</StatusLine>}
      {error && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load jobs"}
        </StatusLine>
      )}
      {jobs && jobs.length === 0 && (
        <StatusLine>
          {debouncedQuery
            ? `No jobs match "${debouncedQuery}"`
            : "No jobs yet"}
        </StatusLine>
      )}

      {/* Desktop only ever reaches this page with no jobs to list — with a
          first job it redirects to it above. */}
      <div className="mt-1 space-y-2.5">
        {jobs?.map((job) => <JobCard key={job.id} job={job} />)}
      </div>

      <CaptureBar maxWidthClass="max-w-2xl" />
    </main>
  );
}
