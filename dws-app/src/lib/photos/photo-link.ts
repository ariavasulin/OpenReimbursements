// The ?photo=<id> deep-link contract. Pure string work so it is testable;
// all history manipulation lives in use-photo-deep-link.ts.

export const PHOTO_PARAM = "photo";

/** Shareable link to one photo inside its job. */
export function buildPhotoLink(
  origin: string,
  jobId: string,
  photoId: string
): string {
  return `${origin.replace(/\/$/, "")}/photos/${jobId}?${PHOTO_PARAM}=${encodeURIComponent(photoId)}`;
}

/** Route of the all-photos search page. */
export const PHOTO_SEARCH_PATH = "/photos/search";

/** The all-photos search page for a job/people/tag query. */
export function photoSearchHref(query: string): string {
  return `${PHOTO_SEARCH_PATH}?q=${encodeURIComponent(query)}`;
}

/**
 * The photo id carried by a query string, or null. Accepts "?a=b" or "a=b".
 * Trimmed, not just tested for blankness: the resolver would otherwise spend
 * its whole page budget hunting for an id nothing can match.
 */
export function parsePhotoParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const id = params.get(PHOTO_PARAM)?.trim();
  return id ? id : null;
}

/** `search` with the photo param set. Returns a leading "?" or "". */
export function withPhotoParam(search: string, photoId: string): string {
  const params = new URLSearchParams(search);
  params.set(PHOTO_PARAM, photoId);
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** `search` with the photo param removed. Returns a leading "?" or "". */
export function withoutPhotoParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PHOTO_PARAM);
  const next = params.toString();
  return next ? `?${next}` : "";
}
