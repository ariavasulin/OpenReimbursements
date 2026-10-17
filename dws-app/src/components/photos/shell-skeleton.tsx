import { CARD_GRID_CLASS, PAGE_MAIN_CLASS, TILE_GRID_CLASS } from "@/components/photos/page-layout";
import type { PhotoSection } from "@/components/photos/photos-shell-context";

// Grey stand-ins for the photos frame and a page, drawn while the session
// check runs (PhotosShell), while a page's code loads (the layout's Suspense),
// and while a project or album opens (their loading.tsx). One drawing for all
// three, so they never flash one after another.
//
// Each stand-in takes up the same height as the real thing it is replacing
// (header rows, title, toolbar, rail rows, grid columns), so nothing moves when
// the page arrives. The heights below mirror PhoneHeader, CollectionTitleRow,
// CollectionHeader, BrowseToolbar, PhotoGrid and SectionsRail; change them
// together.
//
// No hooks and no "use client": server files (the layout, loading.tsx) render
// it too. Phone vs desktop is decided by the `desktop:` CSS variant, never by
// useDesktop(), which is false on the server and would flash the phone layout
// on a desktop.

const block = "rounded bg-[#2e2e2e] motion-safe:animate-pulse";

/**
 * Which page top to reserve: "list" for Projects and Albums (title and Sort
 * row, then cards), "collection" for one project or album (a way back, the
 * name and its actions, then photos), "grid" for everything else (a title,
 * then photos).
 */
export type PageSkeletonKind = "list" | "collection" | "grid";

export function pageSkeletonKind(
  pathname: string,
  params: { jobId?: string; albumId?: string }
): PageSkeletonKind {
  if (params.jobId || params.albumId) return "collection";
  if (pathname === "/photos/projects" || pathname === "/photos/albums") return "list";
  return "grid";
}

/** A line of text, sized by `className`, drawn as a thinner grey `bar` inside it. */
function Line({ className, bar }: { className: string; bar: string }) {
  return (
    <div className={`flex items-center ${className}`}>
      <div className={`${bar} ${block}`} />
    </div>
  );
}

/** PhoneHeader: the name row, then search; inside a section, only a way back. */
function PhoneHeaderSkeleton({ back }: { back: boolean }) {
  return (
    <div className="mb-3 desktop:hidden">
      <div className="flex min-h-11 items-center justify-between">
        <div className={`h-5 ${back ? "w-24" : "w-28"} ${block}`} />
        <div className={`h-9 w-9 rounded-full ${block}`} />
      </div>
      {!back && <div className={`mt-1 h-11 w-full rounded-lg ${block}`} />}
    </div>
  );
}

/** CollectionTitleRow (the name and its Sort chip, 44px), then the cards. */
function ListSkeleton() {
  return (
    <>
      <div className="mb-4 flex min-h-11 items-center justify-between gap-3">
        <div className={`h-6 w-32 ${block}`} />
        <div className={`h-11 w-28 rounded-full ${block}`} />
      </div>
      <div className={CARD_GRID_CLASS}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-xl border border-[#3e3e3e] bg-[#2a2a2a] p-3">
            {/* CollectionCard: name (22px), detail (20px), then a row of thumbs. */}
            <Line className="h-[22px]" bar="h-4 w-2/3" />
            <Line className="mb-2.5 mt-0.5 h-5" bar="h-3 w-1/3" />
            <div className="grid grid-cols-4 gap-1.5">
              {Array.from({ length: 4 }, (_, j) => (
                <div key={j} className={`aspect-square rounded-md ${block}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * CollectionHeader with a one-line name: name and count stacked, the action
 * row under them on a phone and beside them at desktop.
 */
function CollectionHeaderSkeleton() {
  return (
    <div className="mb-3 flex flex-col gap-3 desktop:flex-row desktop:items-start desktop:justify-between desktop:gap-x-4">
      <div className="min-w-0 desktop:flex-1">
        <Line className="h-[24.75px] desktop:h-[27.5px]" bar="h-5 w-3/4 max-w-80 desktop:h-6" />
        <Line className="mt-0.5 h-5 desktop:mt-1 desktop:h-6" bar="h-3.5 w-40" />
      </div>
      <div className="grid grid-cols-3 gap-2 desktop:flex">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`h-11 rounded-full desktop:w-28 desktop:rounded-lg ${block}`} />
        ))}
      </div>
    </div>
  );
}

/** BrowseToolbar's chip row, one group header, then PhotoGrid's tiles. */
function GridSkeleton() {
  return (
    <>
      <div className="mb-2 flex h-11 items-center gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`h-11 w-24 rounded-full ${block}`} />
        ))}
      </div>
      <div className="flex min-h-11 items-center">
        <div className={`h-3.5 w-28 ${block}`} />
      </div>
      <div className={TILE_GRID_CLASS}>
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className={`aspect-square rounded-md ${block}`} />
        ))}
      </div>
    </>
  );
}

/** The page area, shaped like the top of the page it stands in for. */
export function PageSkeleton({ kind = "grid" }: { kind?: PageSkeletonKind }) {
  return (
    <main className={PAGE_MAIN_CLASS} aria-busy="true">
      <span className="sr-only">Loading...</span>
      <div aria-hidden="true">
        <PhoneHeaderSkeleton back={kind === "collection"} />
        {kind === "list" ? (
          <ListSkeleton />
        ) : (
          <>
            {kind === "collection" ? (
              <CollectionHeaderSkeleton />
            ) : (
              // The page's h1: text-xl leading-snug, 27.5px.
              <Line className="mb-3 h-[27.5px]" bar="h-6 w-28" />
            )}
            <GridSkeleton />
          </>
        )}
      </div>
    </main>
  );
}

/** The desktop top bar's footprint. Hidden on phones. */
export function TopBarSkeleton() {
  return (
    <div aria-hidden="true" className="hidden shrink-0 border-b border-[#444444] desktop:block">
      <div className="flex min-h-16 items-center gap-4 px-4 py-2 md:px-6">
        <div className="flex min-h-11 shrink-0 items-center gap-1 text-base font-semibold tracking-wide xl:w-[256px]">
          DWS <span className="text-[#2680FC]">Photos</span>
        </div>
        <div className={`h-11 w-full max-w-md rounded-lg ${block}`} />
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <div className={`h-11 w-11 rounded-full ${block}`} />
          <div className={`h-11 w-11 rounded-full ${block}`} />
        </div>
      </div>
    </div>
  );
}

/**
 * The desktop left rail's footprint (same widths and rows as SectionsRail):
 * the three section rows, then, in Projects or Albums, the list's heading and
 * rows, then Trash at the foot. Hidden on phones.
 */
export function RailSkeleton({ section = null }: { section?: PhotoSection | null }) {
  const heading =
    section === "projects" ? "All projects" : section === "albums" ? "All albums" : null;
  return (
    <div
      aria-hidden="true"
      className="hidden w-[220px] shrink-0 flex-col border-r border-[#444444] desktop:flex xl:w-[280px]"
    >
      <div className="shrink-0 space-y-0.5 p-2">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`h-11 rounded-lg ${block}`} />
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden border-t border-[#3a3a3a] py-1">
        {heading && (
          <>
            <div className="py-2 pl-4 pr-2 text-[13px] font-semibold uppercase tracking-wide text-[#a8a8a8]">
              {heading}
            </div>
            {Array.from({ length: 6 }, (_, i) => (
              // A RailRow with a one-line name: py-2, 19.25px name, 2px, 19.5px detail.
              <div key={i} className="py-2 pl-4 pr-3">
                <Line className="h-[19.25px]" bar="h-3.5 w-3/4" />
                <Line className="mt-0.5 h-[19.5px]" bar="h-2.5 w-1/3" />
              </div>
            ))}
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-[#3a3a3a] p-2">
        <div className={`h-11 rounded-lg ${block}`} />
      </div>
    </div>
  );
}
