// The tag and album routes take at most MAX_BULK_PHOTOS ids per request, while a
// selection holds up to MAX_SELECTION. Bulk calls go out in slices, one after
// another, and their counts are added up.

import { MAX_BULK_PHOTOS } from "./apiShared";

/** Thrown when a slice fails after earlier ones were saved: `done` ids are changed, the rest are not. */
export class PartialBulkError extends Error {
  constructor(
    readonly done: number,
    readonly total: number,
    readonly reason: unknown
  ) {
    super(reason instanceof Error ? reason.message : "The request failed");
    this.name = "PartialBulkError";
  }
}

/**
 * `call` once per slice of at most `size` ids, in order. `onProgress` gets the
 * ids finished so far. A failure on the first slice is rethrown as it is
 * (nothing changed); a later one becomes a PartialBulkError.
 */
export async function inChunks<T>(
  ids: readonly string[],
  call: (chunk: string[]) => Promise<T>,
  onProgress?: (done: number, total: number) => void,
  size = MAX_BULK_PHOTOS
): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < ids.length; start += size) {
    const chunk = ids.slice(start, start + size);
    try {
      results.push(await call(chunk));
    } catch (reason) {
      if (start === 0) throw reason;
      throw new PartialBulkError(start, ids.length, reason);
    }
    onProgress?.(start + chunk.length, ids.length);
  }
  return results;
}

/** Field-by-field sum of the slices' counts. */
export function sumCounts<K extends string>(results: readonly Record<K, number>[], keys: readonly K[]): Record<K, number> {
  const total = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const result of results) for (const key of keys) total[key] += result[key];
  return total;
}
