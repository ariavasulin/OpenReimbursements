"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { usePhotoAlbums, usePhotoJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { PHOTO_SEARCH_PATH, photoSearchHref } from "@/lib/photos/photo-link";

// The one search field (desktop top bar, phone header). While you type it
// opens a panel of clearly separate, labeled sections — matching projects,
// matching albums, and a way to search the photos themselves — so an empty
// project list can never read as "your search found nothing" when photos match.

const SUGGESTION_LIMIT = 5;
const rowClass =
  "flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-base text-white hover:bg-[#353535] focus:bg-[#353535] focus:outline-none";
const headingClass = "px-3 pb-1 pt-3 text-sm font-semibold text-[#b4b4b4]";

export default function SearchBox({ className = "" }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { query, setQuery, debouncedQuery } = usePhotosShell();
  const [focused, setFocused] = useState(false);

  const active = focused && debouncedQuery.length > 0;
  const { data: jobs } = usePhotoJobs(active, debouncedQuery);
  const { data: albums } = usePhotoAlbums(active, debouncedQuery);
  const projectMatches = (jobs ?? []).slice(0, SUGGESTION_LIMIT);
  const albumMatches = (albums ?? []).slice(0, SUGGESTION_LIMIT);

  const submit = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const href = photoSearchHref(trimmed);
    // Replace on the search route itself, so refining a query does not make
    // Back walk every intermediate one.
    if (pathname === PHOTO_SEARCH_PATH) router.replace(href);
    else router.push(href);
    setFocused(false);
  };

  return (
    <div
      className={`relative ${className}`}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // Moving focus into the panel (Tab to a suggestion) keeps it open.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#b4b4b4]"
        aria-hidden="true"
      />
      <input
        type="search"
        aria-label="Search photos, projects, and albums"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") setFocused(false);
        }}
        placeholder="Search projects, albums, people, or tags"
        // The focus indicator is the ring, not the border tint: #2680FC on the
        // field's own #3e3e3e is 2.84:1, under the 3:1 WCAG 1.4.11 asks of a
        // non-text indicator. The ring sits on the #222222 page: 4.22:1.
        className="min-h-11 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] py-2 pl-9 pr-3 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none focus:ring-2 focus:ring-[#2680FC]"
      />

      {active && (
        <div
          // Keeps the field focused while a row is clicked, so the click lands
          // before the panel closes.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 top-full z-30 mt-1 max-h-[70dvh] w-full min-w-[280px] overflow-y-auto rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] pb-1 shadow-xl"
        >
          <Link
            href={photoSearchHref(debouncedQuery)}
            onClick={() => setFocused(false)}
            className={`${rowClass} border-b border-[#3e3e3e] text-[#8bbaff]`}
          >
            <span className="min-w-0 break-words">
              Search all photos for &ldquo;{debouncedQuery}&rdquo;
            </span>
            <span aria-hidden="true">&rsaquo;</span>
          </Link>

          {projectMatches.length > 0 && (
            <section aria-label="Projects">
              <h3 className={headingClass}>Projects</h3>
              {projectMatches.map((job) => (
                <Link
                  key={job.id}
                  href={`/photos/${job.id}`}
                  onClick={() => setFocused(false)}
                  className={`${rowClass} flex-col items-start gap-1`}
                >
                  <span className="min-w-0 break-words">{job.name}</span>
                  <span className="shrink-0 text-sm text-[#b4b4b4]">
                    #{job.job_number} · {plural(job.photo_count, "photo")}
                  </span>
                </Link>
              ))}
            </section>
          )}

          {albumMatches.length > 0 && (
            <section aria-label="Albums">
              <h3 className={headingClass}>Albums</h3>
              {albumMatches.map((album) => (
                <Link
                  key={album.id}
                  href={`/photos/albums/${album.id}`}
                  onClick={() => setFocused(false)}
                  className={`${rowClass} flex-col items-start gap-1`}
                >
                  <span className="min-w-0 break-words">{album.name}</span>
                  <span className="shrink-0 text-sm text-[#b4b4b4]">
                    {plural(album.photo_count, "photo")}
                  </span>
                </Link>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
