"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import EmptyState from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS, PAGE_TITLE_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { usePhotoAlbums, usePhotoJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

const sectionHeading = "mb-2 mt-5 text-base font-semibold text-white";
const resultLink =
  "flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[#3e3e3e] bg-[#2a2a2a] px-3 py-2 text-base text-white hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]";

/**
 * Search results as three separate, labeled sections — Projects, Albums,
 * Photos — so "no project is called that" can never sit beside forty matching
 * photos looking like a failed search.
 */
export default function PhotoSearchPage() {
  const q = useSearchParams().get("q")?.trim() ?? "";
  // One search box per layout: the phone header's below, the top bar's at
  // desktop. Both are the shell's `query`, seeded from `?q=` on a pasted link.
  const { setQuery } = usePhotosShell();
  useEffect(() => setQuery(q), [q, setQuery]);
  // The string is the shell's and outlives this route; hand it back empty.
  useEffect(() => () => setQuery(""), [setQuery]);

  const { data: jobs } = usePhotoJobs(q.length > 0, q);
  const { data: albums } = usePhotoAlbums(q.length > 0, q);

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <h1 className={PAGE_TITLE_CLASS}>
        {q ? <>Results for &ldquo;{q}&rdquo;</> : "Search"}
      </h1>

      {!q && (
        <EmptyState icon={<Search className="h-7 w-7" aria-hidden="true" />} title="Search DWS Photos">
          Type a project, an album, a person&apos;s name, or a tag in the search box.
        </EmptyState>
      )}

      {q && jobs && jobs.length > 0 && (
        <section aria-label="Projects">
          <h2 className={sectionHeading}>Projects · {jobs.length}</h2>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link href={`/photos/${job.id}`} className={resultLink}>
                  <span className="line-clamp-2 min-w-0 break-words">{job.name}</span>
                  <span className="shrink-0 text-sm text-[#b4b4b4]">
                    #{job.job_number} · {plural(job.photo_count, "photo")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {q && albums && albums.length > 0 && (
        <section aria-label="Albums">
          <h2 className={sectionHeading}>Albums · {albums.length}</h2>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {albums.map((album) => (
              <li key={album.id}>
                <Link href={`/photos/albums/${album.id}`} className={resultLink}>
                  <span className="line-clamp-2 min-w-0 break-words">{album.name}</span>
                  <span className="shrink-0 text-sm text-[#b4b4b4]">
                    {plural(album.photo_count, "photo")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {q && (
        <section aria-label="Photos">
          <PhotoBrowser
            scope={{ kind: "search", q }}
            groupModes={["job", "date", "tag"] as const}
            summary={({ count, hasMore, projectCount }) => (
              <>
                <h2 className={sectionHeading}>
                  Photos · {hasMore ? `${count}+` : count}
                </h2>
                {count > 0 && (
                  <p className="mb-2 text-sm text-[#b4b4b4]">
                    {hasMore ? `${count}+ photos` : plural(count, "photo")}
                    {projectCount > 0 ? ` across ${plural(projectCount, "project")}` : ""} ·
                    {" "}&ldquo;{q}&rdquo;
                  </p>
                )}
              </>
            )}
            empty={
              <p className="py-6 text-base text-[#b4b4b4]">
                No photos match &ldquo;{q}&rdquo;. Photos are matched by project, uploader
                name, and tag.
              </p>
            }
          />
        </section>
      )}
    </main>
  );
}
