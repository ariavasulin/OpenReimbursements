// Download a selection as one zip, built in the browser (plan Decision 10).
// This module holds the parts that need no browser: what each file in the zip
// is called, how big the download is, when that is too big to start without a
// warning, a small in-order fetch pool, and finding the rows for selected ids
// the grid has not loaded. zip-save.ts fetches the originals and writes the zip.

import { MAX_BULK_PHOTOS } from "./apiShared";
import { downloadName, formatBytes } from "./format";
import type { PhotoRow } from "./types";

/** What the zip needs from each photo. */
export type ZipRow = Pick<
  PhotoRow,
  "id" | "original_path" | "original_bytes" | "original_name" | "display_name" | "captured_at"
>;

/** The zip streams to a file the person picked: the confirm warns above this. */
export const ZIP_WARN_BYTES = 2 * 1024 ** 3;

/**
 * The zip is built in memory first (phones, Safari, Firefox: no save dialog),
 * so the browser holds all of it before saving. A phone can run out of memory,
 * and lose the whole download, far below 2 GB: the confirm warns above this.
 */
export const ZIP_WARN_BYTES_IN_MEMORY = 400 * 1024 ** 2;

/** Ids per POST /api/photos/rows while looking up unloaded rows (the route's maximum). */
export const ROW_LOOKUP_SIZE = MAX_BULK_PHOTOS;

/** Row lookups in flight at once. */
const ROW_LOOKUPS_AT_ONCE = 3;

/** Sizes summed from `original_bytes`; `unknown` rows have none recorded. */
export function selectionBytes(rows: readonly Pick<ZipRow, "original_bytes">[]): { bytes: number; unknown: number } {
  let bytes = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.original_bytes == null) unknown += 1;
    else bytes += row.original_bytes;
  }
  return { bytes, unknown };
}

/** True when the download is too big to start without a warning: over 2 GB, or 400 MB when built in memory. */
export const isLargeDownload = (bytes: number, inMemory = false) =>
  bytes > (inMemory ? ZIP_WARN_BYTES_IN_MEMORY : ZIP_WARN_BYTES);

/** "3.4 GB" past a gigabyte, otherwise formatBytes ("850.2 MB"). */
export function formatDownloadSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : formatBytes(bytes) ?? "0 B";
}

// Characters a zip entry name cannot carry: `/` and `\` would make folders, and
// the rest are refused by Windows when the zip is opened there.
const UNSAFE_IN_ZIP = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/** One photo's file name in the zip, before de-duplication. */
function entryName(row: ZipRow): string {
  const name = (downloadName(row) ?? "").replace(UNSAFE_IN_ZIP, "-").trim().replace(/[. ]+$/, "");
  if (name) return name;
  // Neither a name nor an uploaded filename: "photo" plus the stored file's extension.
  return `photo${row.original_path.match(EXTENSION)?.[0] ?? ""}`;
}

/**
 * Each row's file name in the zip, in row order: the photo's download name,
 * and ` (2)`, ` (3)` … before the extension when that name is already taken.
 * Names are compared ignoring case, since Windows and macOS do when unzipping.
 */
export function zipEntryNames(rows: readonly ZipRow[]): string[] {
  const taken = new Set<string>();
  return rows.map((row) => {
    const name = entryName(row);
    const ext = name.match(EXTENSION)?.[0] ?? "";
    const stem = ext ? name.slice(0, -ext.length) : name;
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The zip's own file name: the album's name inside an album, else "Photos 2026-10-12". */
export function zipFileName(now: Date, albumName?: string): string {
  const label = albumName?.replace(UNSAFE_IN_ZIP, "-").trim();
  if (label) return `${label}.zip`;
  const two = (n: number) => String(n).padStart(2, "0");
  return `Photos ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.zip`;
}

/**
 * `work` on each item with at most `size` running at once, results yielded in
 * item order. Items ahead of the one being consumed keep fetching, so a slow
 * photo does not stall the others. A rejection surfaces when its turn comes;
 * the generator then ends, and work still running is left to finish unread.
 */
export async function* inOrderPool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<R>
): AsyncGenerator<R> {
  const running: Promise<R>[] = [];
  let next = 0;
  const fill = () => {
    while (next < items.length && running.length < size) {
      const result = work(items[next], next);
      result.catch(() => {}); // handled when its turn comes, or never read
      running.push(result);
      next += 1;
    }
  };
  fill();
  while (running.length > 0) {
    const result = await running.shift()!;
    fill();
    yield result;
  }
}

/**
 * The zip fields for these ids (at most ROW_LOOKUP_SIZE), as POST
 * /api/photos/rows answers: only photos still available, in any order.
 */
export type RowLookup = (ids: string[], signal?: AbortSignal) => Promise<ZipRow[]>;

/**
 * The rows for `ids`: those already `known` (the grid's loaded photos), then
 * the rest by id, ROW_LOOKUP_SIZE ids a request, a few requests at once.
 * `missing` are ids no longer available (trashed or deleted). Rows come back
 * in `ids` order. `signal` stops the lookups when the sheet closes.
 */
export async function findRows(
  ids: readonly string[],
  known: readonly ZipRow[],
  lookup: RowLookup,
  signal?: AbortSignal
): Promise<{ rows: ZipRow[]; missing: string[] }> {
  const wanted = new Set(ids);
  const found = new Map<string, ZipRow>();
  for (const row of known) if (wanted.has(row.id)) found.set(row.id, row);

  const leftover = ids.filter((id) => !found.has(id));
  const slices: string[][] = [];
  for (let start = 0; start < leftover.length; start += ROW_LOOKUP_SIZE) {
    slices.push(leftover.slice(start, start + ROW_LOOKUP_SIZE));
  }
  for await (const rows of inOrderPool(slices, ROW_LOOKUPS_AT_ONCE, (slice) => lookup(slice, signal))) {
    for (const row of rows) if (wanted.has(row.id)) found.set(row.id, row);
  }

  return {
    rows: ids.flatMap((id) => found.get(id) ?? []),
    missing: leftover.filter((id) => !found.has(id)),
  };
}
