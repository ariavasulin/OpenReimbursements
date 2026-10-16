// Pure pieces of the targeted cache updates in api.ts: what an edit does to a
// cached row or page, worked out in the browser so the screen changes at once
// instead of after every loaded page is downloaded again. No React, no fetch.

import type { PhotoRow } from "./types";

/** The most tags one photo may carry; the server skips a photo a change would push past it. */
export const MAX_PHOTO_TAGS = 20;

/** One grid's cached pages as useInfiniteQuery holds them. */
export interface CachedGrid {
  pages: { photos: PhotoRow[]; nextCursor: string | null }[];
  pageParams: unknown[];
}

/**
 * Whether a cached value under a grid prefix is a grid's pages. The same
 * prefix also holds the "Select all" ids answer and its count, which have no
 * pages and must be left alone.
 */
export function isCachedGrid(data: unknown): data is CachedGrid {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as CachedGrid).pages) &&
    (data as CachedGrid).pages.every((page) => Array.isArray(page?.photos))
  );
}

/**
 * `grid` with every row passed through `edit`: the row it returns takes the
 * old one's place, and null takes the row out. Returns `grid` itself when no
 * row changed, so a component memoised on the pages does not draw again.
 * A page's cursor is kept even when its rows go: the next page starts after
 * the last row the server sent, not after what is left on screen.
 */
export function editGrid(grid: CachedGrid, edit: (photo: PhotoRow) => PhotoRow | null): CachedGrid {
  let changed = false;
  const pages = grid.pages.map((page) => {
    let pageChanged = false;
    const photos: PhotoRow[] = [];
    for (const photo of page.photos) {
      const next = edit(photo);
      if (next !== photo) pageChanged = true;
      if (next !== null) photos.push(next);
    }
    if (!pageChanged) return page;
    changed = true;
    return { ...page, photos };
  });
  return changed ? { ...grid, pages } : grid;
}

/**
 * A photo's tags after a bulk Tag or Untag, as the server works it out
 * (photo_bulk_tag): removing ignores case; an added tag a photo already holds
 * under any spelling is not added twice; a new tag takes the library's
 * spelling when `spellings` knows one ("kitchen" for "Kitchen"). Null when the
 * change would push the photo past MAX_PHOTO_TAGS: the server leaves such a
 * photo untouched and counts it as skipped.
 */
export function applyTagChange(
  tags: readonly string[],
  change: { add?: readonly string[]; remove?: readonly string[] },
  spellings: readonly string[] = []
): string[] | null {
  const removing = new Set((change.remove ?? []).map((tag) => tag.trim().toLowerCase()));
  const known = new Map(spellings.map((tag) => [tag.toLowerCase(), tag]));
  const next = tags.filter((tag) => !removing.has(tag.toLowerCase()));
  const held = new Set(next.map((tag) => tag.toLowerCase()));
  for (const raw of change.add ?? []) {
    const tag = raw.trim();
    const lower = tag.toLowerCase();
    if (!tag || held.has(lower)) continue;
    held.add(lower);
    next.push(known.get(lower) ?? tag);
  }
  if (next.length > MAX_PHOTO_TAGS && next.length > tags.length) return null;
  // The same array back when nothing changed, so the caller can keep the row as it was.
  const unchanged = next.length === tags.length && next.every((tag, index) => tag === tags[index]);
  return unchanged ? (tags as string[]) : next;
}

/** Whether a grid's list parameters (its query key's third part) filter by any tag. */
export function listFiltersByTag(listKey: unknown): boolean {
  return typeof listKey === "string" && new URLSearchParams(listKey).has("tags");
}
