"use client";

import { useRef } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { SECTIONS } from "@/components/photos/section-nav";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { usePhotoAlbums, usePhotoJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { cn } from "@/lib/utils";

/**
 * Desktop-only left rail: the three sections, then the list for the open one
 * (every album, or every project), then Trash. The lists share their query
 * with the section pages, so the rail and the page are one fetch.
 */

const focusRing =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2680FC]";

function RailRow({
  href,
  active,
  name,
  detail,
}: {
  href: string;
  active: boolean;
  name: string;
  detail: string;
}) {
  return (
    <Link
      data-rail-row
      href={href}
      aria-current={active ? "page" : undefined}
      // Two lines, then cut; the full name is the tooltip and the page heading.
      title={name}
      // Focus is the ring, not a background tint: #2a2a2a on #222222 is 1.11:1,
      // and hover and the active row already paint it.
      className={cn(
        "block border-l-2 py-2 pl-4 pr-3",
        focusRing,
        active ? "border-[#2680FC] bg-[#2a2a2a]" : "border-transparent hover:bg-[#2a2a2a]"
      )}
    >
      <div className="line-clamp-2 break-words text-sm font-medium leading-snug text-white">
        {name}
      </div>
      <div className="mt-0.5 text-[13px] text-[#a8a8a8]">{detail}</div>
    </Link>
  );
}

function RailStatus({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 text-sm text-[#a8a8a8]">{children}</div>;
}

export default function SectionsRail() {
  const navRef = useRef<HTMLElement>(null);
  const { section, activeJobId, activeAlbumId, openNewAlbum } = usePhotosShell();

  const jobs = usePhotoJobs(section === "projects");
  const albums = usePhotoAlbums(section === "albums");
  const list = section === "projects" ? jobs : section === "albums" ? albums : null;

  // ArrowUp/ArrowDown move focus between rows without scrolling the rail;
  // rows are <Link>s so Enter-to-open is native.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      navRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-rail-row]") ?? []
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
      aria-label="Sections"
      onKeyDown={handleKeyDown}
      // 220px below 1280 so the photo grid still clears five columns at 1024.
      className="flex w-[220px] shrink-0 flex-col border-r border-[#444444] xl:w-[280px]"
    >
      <ul className="shrink-0 space-y-0.5 p-2">
        {SECTIONS.map(({ id, label, href, icon: Icon }) => {
          const active = id === section;
          return (
            <li key={id}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px]",
                  focusRing,
                  active
                    ? "bg-[#2680FC]/20 font-semibold text-white"
                    : "text-[#d0d0d0] hover:bg-[#2a2a2a] hover:text-white"
                )}
              >
                <Icon
                  className={cn("h-5 w-5", active ? "text-[#8bbaff]" : "text-[#a8a8a8]")}
                  aria-hidden="true"
                />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-[#3a3a3a] py-1">
        {section === "albums" && (
          <div className="flex items-center justify-between py-1 pl-4 pr-2">
            <span className="text-[13px] font-semibold uppercase tracking-wide text-[#a8a8a8]">
              All albums
            </span>
            <button
              type="button"
              onClick={openNewAlbum}
              className={cn(
                "flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm text-[#8bbaff] hover:bg-[#2a2a2a]",
                focusRing
              )}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New album
            </button>
          </div>
        )}
        {section === "projects" && (
          <div className="py-2 pl-4 pr-2 text-[13px] font-semibold uppercase tracking-wide text-[#a8a8a8]">
            All projects
          </div>
        )}

        {list?.isLoading &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="animate-pulse space-y-1.5 px-4 py-2.5">
              <div className="h-3.5 w-3/4 rounded bg-[#2e2e2e]" />
              <div className="h-2.5 w-1/3 rounded bg-[#2e2e2e]" />
            </div>
          ))}

        {list?.error && (
          <div className="px-4 py-3 text-sm text-red-400">
            {list.error.message}
            <button
              type="button"
              onClick={() => list.refetch()}
              className={cn(
                "mt-1.5 block rounded border border-[#4e4e4e] px-3 py-1.5 text-[#d0d0d0] hover:border-[#2680FC]",
                focusRing
              )}
            >
              Retry
            </button>
          </div>
        )}

        {section === "albums" && albums.data?.length === 0 && (
          <RailStatus>No albums yet.</RailStatus>
        )}
        {section === "projects" && jobs.data?.length === 0 && (
          <RailStatus>No projects yet.</RailStatus>
        )}

        {section === "albums" &&
          albums.data?.map((album) => (
            <RailRow
              key={album.id}
              href={`/photos/albums/${album.id}`}
              active={album.id === activeAlbumId}
              name={album.name}
              detail={plural(album.photo_count, "photo")}
            />
          ))}
        {section === "projects" &&
          jobs.data?.map((job) => (
            <RailRow
              key={job.id}
              href={`/photos/${job.id}`}
              active={job.id === activeJobId}
              name={job.name}
              detail={`Project #${job.job_number} · ${plural(job.photo_count, "photo")}`}
            />
          ))}
      </div>

      <div className="shrink-0 border-t border-[#3a3a3a] p-2">
        <Link
          href="/photos/trash"
          className={cn(
            "flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] text-[#d0d0d0] hover:bg-[#2a2a2a] hover:text-white",
            focusRing
          )}
        >
          <Trash2 className="h-5 w-5 text-[#a8a8a8]" aria-hidden="true" />
          Trash
        </Link>
      </div>
    </nav>
  );
}
