"use client";

import { useRef } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { fetchJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

/**
 * Desktop-only jobs navigation. Shares ["photo-jobs", debouncedQuery] with
 * the /photos overview so the rail and the overview are one fetch; being
 * always mounted makes it a permanent observer of that key, and staleTime
 * bounds the refetch traffic.
 */
export default function JobsRail() {
  const navRef = useRef<HTMLElement>(null);
  const { debouncedQuery, activeJobId } = usePhotosShell();

  const {
    data: jobs,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["photo-jobs", debouncedQuery],
    queryFn: () => fetchJobs(debouncedQuery),
    staleTime: 60_000,
  });

  // ArrowUp/ArrowDown move focus between rows without scrolling the rail;
  // rows are <Link>s so Enter-to-open is native.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      navRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-rail-row]") ??
        []
    );
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      index === -1
        ? 0
        : event.key === "ArrowDown"
          ? Math.min(index + 1, rows.length - 1)
          : Math.max(index - 1, 0);
    rows[next]?.focus();
  };

  return (
    <nav
      ref={navRef}
      aria-label="Jobs"
      onKeyDown={handleKeyDown}
      // 200px below 1280 so the photo grid clears five columns at 1024 — the
      // count the phone layout renders at 1023 (see TileGrid).
      className="w-[200px] shrink-0 overflow-y-auto border-r border-[#444444] py-2 xl:w-[280px]"
    >
      {isLoading &&
        Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="animate-pulse space-y-1.5 px-4 py-3">
            <div className="h-3.5 w-3/4 rounded bg-[#2e2e2e]" />
            <div className="h-2.5 w-1/3 rounded bg-[#2e2e2e]" />
          </div>
        ))}

      {error && (
        <div className="px-4 py-3 text-xs text-red-400">
          {error instanceof Error ? error.message : "Failed to load jobs"}
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-1.5 block rounded border border-[#4e4e4e] px-2 py-1 text-[#d0d0d0] hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]"
          >
            Retry
          </button>
        </div>
      )}

      {jobs && jobs.length === 0 && (
        <div className="px-4 py-3 text-xs text-[#a0a0a0]">
          {debouncedQuery ? `No jobs match "${debouncedQuery}"` : "No active jobs"}
        </div>
      )}

      {jobs?.map((job) => {
        const active = job.id === activeJobId;
        return (
          <Link
            key={job.id}
            data-rail-row
            href={`/photos/${job.id}`}
            aria-current={active ? "page" : undefined}
            // Focus is the same ring the grid tiles use, not a background
            // tint: #2a2a2a on #222222 is 1.11:1, and hover and the active row
            // already paint it. The ring is 4.22:1 / 3.81:1 on those two.
            className={`block border-l-2 px-4 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2680FC] ${
              active
                ? "border-[#2680FC] bg-[#2a2a2a]"
                : "border-transparent hover:bg-[#2a2a2a]"
            }`}
          >
            <div className="truncate text-[13px] font-medium text-white">
              <span className="text-[#2680FC]">#{job.job_number}</span> ·{" "}
              {job.name}
            </div>
            <div className="text-[11px] text-[#a0a0a0]">
              {plural(job.photo_count, "photo")}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}
