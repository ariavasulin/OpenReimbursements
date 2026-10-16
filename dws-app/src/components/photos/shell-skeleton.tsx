import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";

// Grey stand-ins for the photos frame and a page, drawn while the session
// check runs (PhotosShell), while a page's code loads (the layout's Suspense),
// and while a project or album opens (their loading.tsx). One drawing for all
// three, so they never flash one after another.
//
// No hooks and no "use client": server files (the layout, loading.tsx) render
// it too. Phone vs desktop is decided by the `desktop:` CSS variant, never by
// useDesktop(), which is false on the server and would flash the phone layout
// on a desktop.

const block = "rounded bg-[#2e2e2e] motion-safe:animate-pulse";

/** The page area: a phone header, a title, then a grid of tiles. */
export function PageSkeleton() {
  return (
    <main className={PAGE_MAIN_CLASS} aria-busy="true">
      <span className="sr-only">Loading...</span>
      <div aria-hidden="true">
        {/* PhoneHeader's footprint: name row and search field. */}
        <div className="mb-3 desktop:hidden">
          <div className="flex min-h-11 items-center justify-between">
            <div className={`h-5 w-28 ${block}`} />
            <div className={`h-9 w-9 rounded-full ${block}`} />
          </div>
          <div className={`mt-1 h-11 w-full rounded-lg ${block}`} />
        </div>
        <div className={`mb-4 h-6 w-40 ${block}`} />
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 desktop:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] desktop:gap-2">
          {Array.from({ length: 18 }, (_, i) => (
            <div key={i} className={`aspect-square rounded-md ${block}`} />
          ))}
        </div>
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

/** The desktop left rail's footprint (same widths as SectionsRail). Hidden on phones. */
export function RailSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="hidden w-[220px] shrink-0 flex-col border-r border-[#444444] desktop:flex xl:w-[280px]"
    >
      <div className="space-y-2 p-2">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`h-9 rounded-lg ${block}`} />
        ))}
      </div>
      <div className="space-y-3 border-t border-[#3a3a3a] px-4 py-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className={`h-3.5 w-3/4 ${block}`} />
            <div className={`h-2.5 w-1/3 ${block}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
