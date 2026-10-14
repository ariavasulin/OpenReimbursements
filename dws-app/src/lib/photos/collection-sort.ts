// The Sort chip on the Projects and Albums pages. Both lists are fully loaded
// in the browser (collectPages), so sorting is done here; the server's order
// (photo_job_number_key / photo_sort_key in 20261014120000_photo_list_order.sql)
// is the same as each default, and the two key functions below mirror those.

import type { PhotoAlbumSummary, PhotoJobSummary } from "./types";

export type JobSort = "number" | "name" | "recent";
export type AlbumSort = "name" | "recent" | "count";

export const DEFAULT_JOB_SORT: JobSort = "number";
export const DEFAULT_ALBUM_SORT: AlbumSort = "name";

/** What the chip offers, in its order. The label reads after "Sort": "Sort Job number". */
export const JOB_SORT_OPTIONS: readonly { value: JobSort; label: string }[] = [
  { value: "number", label: "Job number" },
  { value: "name", label: "Name" },
  { value: "recent", label: "Latest upload" },
];
export const ALBUM_SORT_OPTIONS: readonly { value: AlbumSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Latest added" },
  { value: "count", label: "Most photos" },
];

export function parseJobSort(raw: string | null | undefined): JobSort {
  return JOB_SORT_OPTIONS.some((option) => option.value === raw) ? (raw as JobSort) : DEFAULT_JOB_SORT;
}
export function parseAlbumSort(raw: string | null | undefined): AlbumSort {
  return ALBUM_SORT_OPTIONS.some((option) => option.value === raw) ? (raw as AlbumSort) : DEFAULT_ALBUM_SORT;
}

/**
 * A name's sort key, as SQL photo_sort_key builds it: lowercase, every digit
 * run zero-padded to 12 places, so "Kitchen 2" sorts before "Kitchen 10" and
 * names starting with a digit come before letters.
 */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[0-9]+/g, (digits) => digits.padStart(12, "0"));
}

/**
 * A job number's sort key, as SQL photo_job_number_key builds it: "1" + the
 * padded number for all-digit numbers, "0" + the padded code for P-<n>, "0" +
 * the text otherwise. Descending puts numbered projects first, newest on top,
 * then the generated codes.
 */
export function jobNumberKey(jobNumber: string): string {
  if (/^[0-9]+$/.test(jobNumber)) return `1${jobNumber.padStart(20, "0")}`;
  const code = /^P-([0-9]+)$/.exec(jobNumber);
  return code ? `0${code[1].padStart(20, "0")}` : `0${jobNumber}`;
}

/** Byte-wise, like SQL's "C" collation, so the two sides agree on every order. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Newest first; a missing time last. */
const recentFirst = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : compare(b, a);

export function sortJobs(jobs: readonly PhotoJobSummary[], sort: JobSort): PhotoJobSummary[] {
  const byId = (a: PhotoJobSummary, b: PhotoJobSummary) => compare(a.id, b.id);
  const order: Record<JobSort, (a: PhotoJobSummary, b: PhotoJobSummary) => number> = {
    number: (a, b) => compare(jobNumberKey(b.job_number), jobNumberKey(a.job_number)) || byId(a, b),
    name: (a, b) => compare(nameKey(a.name), nameKey(b.name)) || byId(a, b),
    recent: (a, b) =>
      recentFirst(a.latest_activity, b.latest_activity) ||
      compare(jobNumberKey(b.job_number), jobNumberKey(a.job_number)) || byId(a, b),
  };
  return [...jobs].sort(order[sort]);
}

export function sortAlbums(albums: readonly PhotoAlbumSummary[], sort: AlbumSort): PhotoAlbumSummary[] {
  const byId = (a: PhotoAlbumSummary, b: PhotoAlbumSummary) => compare(a.id, b.id);
  const byName = (a: PhotoAlbumSummary, b: PhotoAlbumSummary) => compare(nameKey(a.name), nameKey(b.name)) || byId(a, b);
  const order: Record<AlbumSort, (a: PhotoAlbumSummary, b: PhotoAlbumSummary) => number> = {
    name: byName,
    // An album nothing was added to yet counts from when it was made, as the server did.
    recent: (a, b) => recentFirst(a.latest_activity ?? a.created_at, b.latest_activity ?? b.created_at) || byName(a, b),
    count: (a, b) => b.photo_count - a.photo_count || byName(a, b),
  };
  return [...albums].sort(order[sort]);
}
