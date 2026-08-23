// Filter-chip menus for a job page. The options accumulate across every page
// of photos seen for the job, so picking a filter never shrinks the menus to
// the filtered set.

import type { PhotoRow } from "./types";

export interface SeenOptions {
  /** Sheet numbers, as written on the photos. */
  sheets: Set<string>;
  /** uploader_id -> display name. */
  uploaders: Map<string, string>;
}

export interface FilterOption {
  value: string;
  label: string;
}

export function emptySeenOptions(): SeenOptions {
  return { sheets: new Set(), uploaders: new Map() };
}

/**
 * `previous` widened by everything `photos` adds. Returns `previous` itself
 * when there is nothing new, so React can skip the re-render.
 */
export function accumulateSeenOptions(
  previous: SeenOptions,
  photos: PhotoRow[]
): SeenOptions {
  let changed = false;
  const sheets = new Set(previous.sheets);
  const uploaders = new Map(previous.uploaders);
  for (const photo of photos) {
    const sheet = photo.sheet_number?.trim();
    if (sheet && !sheets.has(sheet)) {
      sheets.add(sheet);
      changed = true;
    }
    const name = photo.uploader?.full_name;
    if (name && uploaders.get(photo.uploader_id) !== name) {
      uploaders.set(photo.uploader_id, name);
      changed = true;
    }
  }
  return changed ? { sheets, uploaders } : previous;
}

/**
 * Highest sheet number first, then the non-numeric ones alphabetically.
 *
 * Partitioned rather than compared in one pass: a numeric-or-lexical compare
 * over mixed free-text sheets is not a total order, so the result depended on
 * Set insertion (pagination) order.
 */
export function toSheetOptions(seen: SeenOptions): FilterOption[] {
  const numeric: string[] = [];
  const rest: string[] = [];
  for (const sheet of seen.sheets) {
    (Number.isFinite(Number(sheet)) ? numeric : rest).push(sheet);
  }
  numeric.sort((a, b) => Number(b) - Number(a) || a.localeCompare(b));
  rest.sort((a, b) => a.localeCompare(b));
  return [...numeric, ...rest].map((sheet) => ({
    value: sheet,
    label: `Sheet ${sheet}`,
  }));
}

/** Uploaders by display name. */
export function toUploaderOptions(seen: SeenOptions): FilterOption[] {
  return [...seen.uploaders.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ value: id, label: name }));
}
