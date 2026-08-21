"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import JobCard from "@/components/photos/job-card";
import { CaptureBar, useCaptureBatch } from "@/components/photos/capture-bar";
import UploadSheet from "@/components/photos/upload-sheet";
import { fetchJobs, invalidatePhotoCaches } from "@/lib/photos/api";

// Photos home: searchable job list plus the Take Photos / Upload bar. The
// guard is session-only — deliberately NO role gate: admins use this page too.

export default function PhotosHomePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessionReady = useSessionGuard("/photos");
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const batch = useCaptureBatch();

  // Missing-profile fallback (a DB trigger normally creates the profile row
  // at signup; this covers accounts that predate it).
  useEffect(() => {
    if (!sessionReady) return;
    let cancelled = false;
    const ensureProfile = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session || cancelled) return;

      const { error: profileError } = await supabase
        .from("user_profiles")
        .select("user_id")
        .eq("user_id", session.user.id)
        .single();

      if (profileError?.code === "PGRST116") {
        await supabase.from("user_profiles").insert({
          user_id: session.user.id,
          role: "employee",
          full_name: null,
        });
      }

      if (!cancelled) setReady(true);
    };
    ensureProfile();
    return () => {
      cancelled = true;
    };
  }, [sessionReady]);

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

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && search.trim()) {
            router.push(`/photos/search?q=${encodeURIComponent(search.trim())}`);
          }
        }}
        placeholder="Search jobs, people, or tags..."
        className="mb-2 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
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

      {isLoading && (
        <p className="py-8 text-center text-sm text-[#a0a0a0]">
          Loading jobs...
        </p>
      )}
      {error && (
        <p className="py-8 text-center text-sm text-red-400">
          {error instanceof Error ? error.message : "Failed to load jobs"}
        </p>
      )}
      {jobs && jobs.length === 0 && (
        <p className="py-8 text-center text-sm text-[#a0a0a0]">
          {debouncedSearch
            ? `No jobs match "${debouncedSearch}"`
            : "No jobs yet"}
        </p>
      )}

      <div className="space-y-2.5">
        {jobs?.map((job) => <JobCard key={job.id} job={job} />)}
      </div>

      <CaptureBar
        batch={batch}
        maxWidthClass="max-w-2xl"
        inputId="photos-home-upload-input"
      />

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
