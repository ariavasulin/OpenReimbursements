"use client";

import { useEffect, useRef } from "react";
import LoadMoreButton from "@/components/photos/load-more-button";
import { PHOTOS_SCROLLPORT_ID } from "@/components/photos/photos-shell-context";

/**
 * Fires onVisible when the sentinel scrolls within 600px of the viewport of
 * the shell's content cell (#photos-scrollport). Renders the Load more button
 * inside itself as the always-available fallback, so a failed observer
 * degrades to click-to-load rather than a dead end.
 */
export default function InfiniteSentinel({
  hasNextPage,
  isFetching,
  failed,
  onVisible,
}: {
  hasNextPage: boolean;
  isFetching: boolean;
  /** The last next-page request errored (hasNextPage is still the last good page's). */
  failed?: boolean;
  onVisible(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  // Recreated when a fetch settles, so a sentinel still in view fires again
  // for the next page (IntersectionObserver only reports *changes*).
  //
  // Not after a failure, though: react-query keeps hasNextPage from the last
  // good page and drops isFetching back to false, so recreating the observer
  // against a sentinel that never left the viewport would re-fire immediately
  // and loop the failing request.
  useEffect(() => {
    if (!hasNextPage || isFetching || failed) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisibleRef.current();
        }
      },
      {
        // null root would watch the window viewport, which is not the scroller.
        root: document.getElementById(PHOTOS_SCROLLPORT_ID),
        rootMargin: "600px",
      }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetching, failed]);

  if (!hasNextPage) return null;

  return (
    <div ref={ref}>
      <LoadMoreButton
        onClick={onVisible}
        loading={isFetching}
        retry={failed}
      />
    </div>
  );
}
