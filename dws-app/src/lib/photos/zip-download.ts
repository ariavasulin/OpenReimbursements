// Download a selection as one zip, built in the browser (plan Decision 10).
// This module holds the parts that need no browser: what each file in the zip
// is called, how big the download is, when that is too big to start without a
// warning, a small in-order fetch pool, and finding the rows for selected ids
// the grid has not loaded. zip-save.ts fetches the originals and writes the zip.

import { downloadName, formatBytes } from "./format";
import type { PhotoRow } from "./types";

/** What the zip needs from each photo. */
export type ZipRow = Pick<
  PhotoRow,
  "id" | "original_path" | "original_bytes" | "original_name" | "display_name" | "captured_at"
>;

/** Above this the confirm warns before anything is fetched. */
export const ZIP_WARN_BYTES = 2 * 1024 ** 3;

/** Rows per GET /api/photos page while looking for unloaded rows (the route's maximum). */
export const ROW_PAGE_SIZE = 200;

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

/** True when the download is over 2 GB. */
export const isLargeDownload = (bytes: number) => bytes > ZIP_WARN_BYTES;

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

export interface FindRowsDeps {
  /** One page of GET /api/photos for these parameters. */
  page(params: URLSearchParams): Promise<{ photos: ZipRow[]; nextCursor: string | null }>;
  /** One photo by id; null when it is gone (trashed or deleted). */
  one(id: string): Promise<ZipRow | null>;
}

/**
 * The rows for `ids`: those already `known` (the grid's loaded photos), then
 * the grid's own list (`listQuery`, the grid's GET /api/photos parameters) page
 * by page until every id is found or the list ends, then one by one for any
 * picked under an earlier filter. `missing` are ids no longer available.
 * Rows come back in `ids` order.
 */
export async function findRows(
  ids: readonly string[],
  known: readonly ZipRow[],
  listQuery: string | null,
  deps: FindRowsDeps,
  poolSize = 6
): Promise<{ rows: ZipRow[]; missing: string[] }> {
  const wanted = new Set(ids);
  const found = new Map<string, ZipRow>();
  for (const row of known) if (wanted.has(row.id)) found.set(row.id, row);

  let cursor: string | null = null;
  while (listQuery !== null && found.size < wanted.size) {
    const params = new URLSearchParams(listQuery);
    params.set("limit", String(ROW_PAGE_SIZE));
    if (cursor !== null) params.set("cursor", cursor);
    const page = await deps.page(params);
    for (const row of page.photos) if (wanted.has(row.id) && !found.has(row.id)) found.set(row.id, row);
    cursor = page.nextCursor;
    if (cursor === null) break;
  }

  const leftover = ids.filter((id) => !found.has(id));
  const missing: string[] = [];
  let index = 0;
  for await (const row of inOrderPool(leftover, poolSize, (id) => deps.one(id))) {
    if (row) found.set(row.id, row);
    else missing.push(leftover[index]);
    index += 1;
  }

  return { rows: ids.flatMap((id) => found.get(id) ?? []), missing };
}
