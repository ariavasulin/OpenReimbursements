"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import JobCard from "@/components/photos/job-card";
import type { PhotoJobSummary } from "@/lib/photos/types";

// Photos home: searchable job list (one card per job, newest activity first).
// Guard is session-only — deliberately NO role gate: admins use this page too.

async function fetchJobs(q: string): Promise<PhotoJobSummary[]> {
  const params = q ? `?q=${encodeURIComponent(q)}` : "";
  const response = await fetch(`/api/photo-jobs${params}`);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `Failed to load jobs (${response.status})`);
  }
  const data = await response.json();
  return data.jobs as PhotoJobSummary[];
}

export default function PhotosHomePage() {
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const mountedRef = useRef(true);

  // Session guard + missing-profile fallback (a DB trigger normally creates
  // the profile row at signup; this covers accounts that predate it).
  useEffect(() => {
    mountedRef.current = true;

    const guard = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mountedRef.current) return;

      if (!session) {
        window.location.replace("/login?next=/photos");
        return;
      }

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

      if (mountedRef.current) setReady(true);
    };

    guard();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          window.location.replace("/login?next=/photos");
        }
      }
    );

    return () => {
      mountedRef.current = false;
      authListener?.subscription?.unsubscribe();
    };
  }, []);

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
    <main className="mx-auto w-full max-w-2xl px-4 pb-10 pt-5">
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
        placeholder="Search jobs..."
        className="mb-3 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
      />

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
    </main>
  );
}
