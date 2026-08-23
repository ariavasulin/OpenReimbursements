// Decoding deliberately stops at "it is a pair of strings" and hands off to a
// caller-supplied validator, because what counts as a *valid* pair differs per
// endpoint — and the decoded values get interpolated into PostgREST filter
// strings, so each call site has to pin down its own accepted character set
// rather than trusting the tuple shape.

/** Encode a keyset position (the sort key, then its tiebreaker). */
export function encodeKeysetCursor(first: string, second: string): string {
  return Buffer.from(JSON.stringify([first, second])).toString("base64url");
}

/**
 * Decode a cursor produced by `encodeKeysetCursor`. Returns null — never
 * throws — for anything that isn't a two-string tuple, or that `validate`
 * rejects by returning null.
 */
export function decodeKeysetCursor<T>(
  raw: string,
  validate: (first: string, second: string) => T | null
): T | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [first, second] = parsed;
    if (typeof first !== "string" || typeof second !== "string") return null;
    return validate(first, second);
  } catch {
    return null;
  }
}

/**
 * True for the timestamp shapes PostgREST emits and accepts: an ISO-8601
 * date-time with optional fractional seconds and either `Z` or a numeric
 * offset (`+00:00`, `-07`), and that parses to a real instant. Both keyset
 * endpoints run their timestamp through this before it reaches a filter
 * string.
 */
export function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * PostgREST `or()` filter for "strictly past this keyset position" under a
 * descending sort: the sort key is smaller, or it ties and the tiebreaker is
 * smaller. Callers must have validated both values — they are interpolated
 * into the filter string.
 */
export function keysetOrFilter(
  sortField: string,
  sortValue: string,
  tiebreakField: string,
  tiebreakValue: string
): string {
  return (
    `${sortField}.lt.${sortValue},` +
    `and(${sortField}.eq.${sortValue},${tiebreakField}.lt.${tiebreakValue})`
  );
}

/** A page size from `?limit=`: a positive integer clamped to [1, max]; null for anything else. */
export function parseLimit(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1) return null;
  return Math.min(n, max);
}
