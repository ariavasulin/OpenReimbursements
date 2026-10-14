"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

/**
 * The Projects or Albums page's Sort choice, kept in the address bar as
 * `?sort=` like a photo grid's (use-browse-state.ts), so a reload or a pasted
 * link shows the same order and the desktop rail follows the page. The default
 * is written as no parameter. Written with history.replaceState: no history
 * entry per tap, no route re-render.
 */
export function useCollectionSort<T extends string>(parse: (raw: string | null) => T, defaultValue: T) {
  const sort = parse(useSearchParams().get("sort"));
  const setSort = useCallback(
    (next: T) => {
      const { pathname, search, hash } = window.location;
      const params = new URLSearchParams(search);
      if (next === defaultValue) params.delete("sort");
      else params.set("sort", next);
      const written = params.toString();
      window.history.replaceState(null, "", `${pathname}${written ? `?${written}` : ""}${hash}`);
    },
    [defaultValue]
  );
  return [sort, setSort] as const;
}
