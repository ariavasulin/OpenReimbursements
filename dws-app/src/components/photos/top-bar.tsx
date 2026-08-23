"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useHasCamera } from "@/components/photos/multi-shot-camera";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import SearchInput from "@/components/photos/search-input";
import { PHOTO_SEARCH_PATH, photoSearchHref } from "@/lib/photos/photo-link";
import { signOut } from "@/hooks/use-session-guard";

/**
 * Desktop-only header, styled after the receipts admin shell
 * (user-management-dashboard.tsx) so the two halves read as one product.
 * Only mounted when useDesktop() is true — no desktop: guards needed here.
 */
export default function TopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const { query, setQuery, debouncedQuery, openPicker, openCamera } =
    usePhotosShell();
  const hasCamera = useHasCamera();

  const onRoot = pathname === "/photos";
  const trimmed = query.trim();

  // The root-route contract: on /photos typing filters the overview and the
  // rail together (both read ["photo-jobs", debouncedQuery]) and Enter does
  // nothing extra; everywhere else Enter submits to photo search. On the
  // search route that is a replace — refining a query must not make Back walk
  // every intermediate one — which is what the phone box there does too.
  const handleSubmit = () => {
    if (onRoot || !trimmed) return;
    const href = photoSearchHref(trimmed);
    if (pathname === PHOTO_SEARCH_PATH) router.replace(href);
    else router.push(href);
  };

  return (
    <div className="shrink-0 border-b border-[#444444]">
      <div className="flex h-16 items-center gap-4 px-4 md:px-8">
        <Link
          href="/photos"
          className="shrink-0 text-[15px] font-semibold tracking-wide"
        >
          DWS <span className="text-[#2680FC]">Photos</span>
        </Link>

        <div className="relative w-full max-w-sm">
          <SearchInput
            value={query}
            onChange={setQuery}
            onSubmit={handleSubmit}
            className="py-2"
          />
          {onRoot && debouncedQuery && (
            <Link
              href={photoSearchHref(debouncedQuery)}
              className="absolute left-0 top-full z-20 mt-1 block w-full truncate rounded-lg border border-[#3e3e3e] bg-[#2e2e2e] px-3 py-1.5 text-xs text-[#2680FC] shadow-lg hover:text-[#1a6fd8]"
            >
              Search photos for &ldquo;{debouncedQuery}&rdquo; &rsaquo;
            </Link>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center space-x-4">
          {hasCamera && (
            <Button
              variant="ghost"
              size="sm"
              onClick={openCamera}
              className="bg-[#333333] text-white hover:bg-[#444444]"
            >
              Take Photos
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={openPicker}
            className="bg-[#333333] text-white hover:bg-[#444444]"
          >
            Upload
          </Button>
          {/* asChild, not a Button inside the Link: nesting them is invalid
              interactive content and two focus stops for one action. */}
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="bg-[#333333] text-white hover:bg-[#444444]"
          >
            <Link href="/employee">Receipts</Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            // red-600, not the admin shell's red-500: white on red-500 is
            // 3.82:1, under the 4.5:1 floor for this small label.
            className="bg-red-600 text-white hover:bg-red-700"
          >
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
