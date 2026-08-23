"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PHOTOS_PAGE_SIZE } from "@/lib/photos/apiShared";
import {
  parsePhotoParam,
  withPhotoParam,
  withoutPhotoParam,
} from "@/lib/photos/photo-link";
import type { PhotoRow } from "@/lib/photos/types";

/** How far ?photo= resolution will paginate looking for its id. */
const MAX_DEEP_LINK_PAGES = 5;
/** The photo count the give-up toast quotes — derived so it cannot go stale. */
const DEEP_LINK_PHOTO_CAP = MAX_DEEP_LINK_PAGES * PHOTOS_PAGE_SIZE;

/** Same-document URL with `search` swapped in, hash and path untouched. */
function urlWithSearch(search: string): string {
  return `${window.location.pathname}${search}${window.location.hash}`;
}

interface UsePhotoDeepLinkOptions {
  /** Id of the photo the lightbox is showing, or null when closed. */
  openPhotoId: string | null;
  /** Called when Back should dismiss the lightbox. */
  onPopClose(): void;
  /** Called when Forward (or Back) lands on an entry that names a photo. */
  onPopOpen(photoId: string): void;
}

/**
 * Keeps `?photo=<id>` in the address bar in sync with the open lightbox.
 *
 * Uses history.pushState/replaceState directly — never the Next router — so
 * opening, arrowing, and closing change the address bar without re-running
 * the route's data fetching.
 *
 * Contract:
 * - Opening (null → id): pushState if the URL has no photo param yet — that
 *   entry is what makes Back dismiss the lightbox. If the URL already carries
 *   the param (the user arrived on a pasted link), the entry already exists,
 *   so do NOT push.
 * - Changing slides (id → other id): replaceState, so arrowing through fifty
 *   photos does not stack fifty history entries.
 * - Closing (id → null): history.back() only if this hook pushed the entry.
 *   On a pasted link, back() would leave the site entirely, so replaceState
 *   the param away instead.
 * - popstate: reconcile the viewer with whatever the entry says, in both
 *   directions — no param closes it, a param opens that photo. Back and
 *   Forward are inverses, so a one-directional handler would leave the URL
 *   and the screen disagreeing after the first Forward.
 */
export function usePhotoDeepLink({
  openPhotoId,
  onPopClose,
  onPopOpen,
}: UsePhotoDeepLinkOptions): void {
  // Did *this hook* push the history entry for the current open session?
  const pushedRef = useRef(false);
  const previousIdRef = useRef<string | null>(null);
  // Latest callbacks without re-subscribing the popstate listener.
  const onPopCloseRef = useRef(onPopClose);
  onPopCloseRef.current = onPopClose;
  const onPopOpenRef = useRef(onPopOpen);
  onPopOpenRef.current = onPopOpen;

  useEffect(() => {
    const previousId = previousIdRef.current;
    previousIdRef.current = openPhotoId;
    if (openPhotoId === previousId) return;

    if (openPhotoId !== null && previousId === null) {
      if (parsePhotoParam(window.location.search) === null) {
        window.history.pushState(
          null,
          "",
          urlWithSearch(withPhotoParam(window.location.search, openPhotoId))
        );
        pushedRef.current = true;
      } else {
        // Pasted-link arrival: the entry exists; just make the id match.
        window.history.replaceState(
          null,
          "",
          urlWithSearch(withPhotoParam(window.location.search, openPhotoId))
        );
        pushedRef.current = false;
      }
    } else if (openPhotoId !== null) {
      window.history.replaceState(
        null,
        "",
        urlWithSearch(withPhotoParam(window.location.search, openPhotoId))
      );
    } else {
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      } else {
        window.history.replaceState(
          null,
          "",
          urlWithSearch(withoutPhotoParam(window.location.search))
        );
      }
    }
  }, [openPhotoId]);

  useEffect(() => {
    // Only same-page history moves are ours. Back out of this job onto some
    // other job's `?photo=` entry is a route change, and reconciling against
    // it would have this page chase an id it will never hold.
    const ownPathname = window.location.pathname;
    const handlePop = () => {
      if (window.location.pathname !== ownPathname) return;
      const paramId = parsePhotoParam(window.location.search);
      if (paramId === previousIdRef.current) return; // already agrees

      // The browser has already moved history for us, so record the new state
      // here: the outbound effect then sees no change and writes nothing.
      previousIdRef.current = paramId;

      if (paramId === null) {
        // Back consumed the entry we pushed; closing must not call back() again.
        pushedRef.current = false;
        onPopCloseRef.current();
        return;
      }
      // Forward back onto an entry we pushed when the viewer first opened —
      // so closing from here can pop it the same way Back would.
      pushedRef.current = true;
      onPopOpenRef.current(paramId);
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);
}

interface UseResolvePhotoDeepLinkOptions {
  /** Openable photos in display order — the set the lightbox flips through. */
  photos: PhotoRow[];
  /** Pages fetched so far; 0 means the first fetch has not landed (or errored). */
  pagesLoaded: number;
  /** True while any page of the set is in flight. */
  isFetching: boolean;
  hasNextPage: boolean;
  /** The last next-page request errored (hasNextPage is still the last good page's). */
  fetchFailed: boolean;
  fetchNextPage(): void;
  /** True once the lightbox is showing something — the link has lost its claim. */
  isLightboxOpen: boolean;
  /** Called with the id the link named, once that photo is loaded. */
  onResolve(photoId: string): void;
}

/**
 * The inbound half of the `?photo=<id>` contract: reads the param once on
 * mount, then opens that photo if it is loaded, pages deeper (up to
 * MAX_DEEP_LINK_PAGES) if it is not, and gives up with a toast once out of
 * pages. Paging can take seconds, so the link only ever gets to open the
 * viewer while the viewer is still closed — otherwise a late page would yank
 * the user off a photo they opened by hand.
 */
export function useResolvePhotoDeepLink({
  photos,
  pagesLoaded,
  isFetching,
  hasNextPage,
  fetchFailed,
  fetchNextPage,
  isLightboxOpen,
  onResolve,
}: UseResolvePhotoDeepLinkOptions): void {
  // The ?photo=<id> a pasted link arrived with, captured once on mount (the
  // outbound half rewrites the URL afterwards, so it must not be tracked).
  // Lazy initializers DO run during SSR, hence the window guard.
  const [deepLinkId, setDeepLinkId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : parsePhotoParam(window.location.search)
  );
  const onResolveRef = useRef(onResolve);
  onResolveRef.current = onResolve;

  useEffect(() => {
    if (deepLinkId === null) return;
    // The user got there first — hand the viewer over and stop paging for it.
    if (isLightboxOpen) {
      setDeepLinkId(null);
      return;
    }
    if (photos.some((candidate) => candidate.id === deepLinkId)) {
      onResolveRef.current(deepLinkId);
      setDeepLinkId(null);
      return;
    }
    if (isFetching) return;
    if (pagesLoaded === 0) return; // first page not in yet (or errored)
    if (fetchFailed) {
      // Re-asking would loop the failing request — the same trap
      // InfiniteSentinel's `failed` guard exists for. Settle instead; the
      // param stays, so a reload is a real second attempt. Not waiting for
      // the Load-more retry: that would leave the resolver armed to yank the
      // viewer open minutes later.
      toast.error("Couldn't load more photos — reload to keep looking for it.");
      setDeepLinkId(null);
      return;
    }
    if (hasNextPage && pagesLoaded < MAX_DEEP_LINK_PAGES) {
      fetchNextPage();
      return;
    }
    if (hasNextPage) {
      // Out of budget, not out of photos: "we stopped looking", not "absent".
      // The param stays, so a reload is a real second attempt.
      toast.error(
        `Stopped looking after ${DEEP_LINK_PHOTO_CAP} photos — reload to keep searching for it.`
      );
    } else {
      toast.error("Photo not found in this job");
      window.history.replaceState(
        null,
        "",
        urlWithSearch(withoutPhotoParam(window.location.search))
      );
    }
    setDeepLinkId(null);
  }, [
    deepLinkId,
    photos,
    isFetching,
    pagesLoaded,
    hasNextPage,
    fetchFailed,
    fetchNextPage,
    isLightboxOpen,
  ]);
}
