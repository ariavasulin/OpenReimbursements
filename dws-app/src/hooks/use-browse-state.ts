"use client";

import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  browseSearchKey,
  NO_FILTERS,
  parseBrowseState,
  writeBrowseState,
  type BrowseFilters,
  type BrowseOptions,
  type BrowseState,
} from "@/lib/photos/browse-state";
import type { GroupBy } from "@/lib/photos/group";

/**
 * A grid's filters, sort, and grouping, kept in the address bar so a reload or
 * a pasted link shows the same photos (lib/photos/browse-state.ts has the
 * grammar). Writes with history.replaceState, like the `?photo=` link in
 * use-photo-deep-link.ts: no new history entry per tap, no route re-render.
 * Next keeps useSearchParams in step with replaceState, so reading it here is
 * enough; a navigation to another page starts from that page's own URL.
 *
 * Parsed from the browse keys alone: the viewer's `?photo=` changes on every
 * swipe, and must not hand the grid a new (equal) filters object each time.
 */
export function useBrowseState(options: BrowseOptions) {
  const search = browseSearchKey(useSearchParams());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Callers pass the modes inline; their contents, not identity, matter.
  const modesKey = options.groupModes.join(",");
  const { projectFilter, defaultSort, customSort } = options;
  const state = useMemo(
    () =>
      parseBrowseState(search, {
        groupModes: modesKey.split(",") as GroupBy[],
        projectFilter,
        defaultSort,
        customSort,
      }),
    [search, modesKey, projectFilter, defaultSort, customSort]
  );

  // Read from the address bar itself, so two quick changes both land.
  const update = useCallback((change: (current: BrowseState) => BrowseState) => {
    const { pathname, search: current, hash } = window.location;
    const next = change(parseBrowseState(current, optionsRef.current));
    const written = writeBrowseState(current, next, optionsRef.current);
    if (written === current || (written === "" && current === "?")) return;
    window.history.replaceState(null, "", `${pathname}${written}${hash}`);
  }, []);

  const setFilters = useCallback(
    (change: Partial<BrowseFilters>) =>
      update((current) => ({ ...current, filters: { ...current.filters, ...change } })),
    [update]
  );
  const clearFilters = useCallback(
    () => update((current) => ({ ...current, filters: NO_FILTERS })),
    [update]
  );
  const setSort = useCallback(
    (sort: BrowseState["sort"]) => update((current) => ({ ...current, sort })),
    [update]
  );
  const setGroup = useCallback(
    (group: BrowseState["group"]) => update((current) => ({ ...current, group })),
    [update]
  );

  return { ...state, setFilters, clearFilters, setSort, setGroup };
}
