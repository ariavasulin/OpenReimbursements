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

// Each sort works out every row's keys once, then sorts on them: building
// them inside the comparator ran the regexes about n·log n times, 5-8 ms for
// 3,000 projects on every sort.

export function sortJobs(jobs: readonly PhotoJobSummary[], sort: JobSort): PhotoJobSummary[] {
  const rows = jobs.map((job) => ({ job, number: jobNumberKey(job.job_number), name: nameKey(job.name) }));
  type Row = (typeof rows)[number];
  const byId = (a: Row, b: Row) => compare(a.job.id, b.job.id);
  const byNumber = (a: Row, b: Row) => compare(b.number, a.number);
  const order: Record<JobSort, (a: Row, b: Row) => number> = {
    number: (a, b) => byNumber(a, b) || byId(a, b),
    name: (a, b) => compare(a.name, b.name) || byId(a, b),
    recent: (a, b) =>
      recentFirst(a.job.latest_activity, b.job.latest_activity) || byNumber(a, b) || byId(a, b),
  };
  return rows.sort(order[sort]).map((row) => row.job);
}

export function sortAlbums(albums: readonly PhotoAlbumSummary[], sort: AlbumSort): PhotoAlbumSummary[] {
  const rows = albums.map((album) => ({ album, name: nameKey(album.name) }));
  type Row = (typeof rows)[number];
  const byName = (a: Row, b: Row) => compare(a.name, b.name) || compare(a.album.id, b.album.id);
  const order: Record<AlbumSort, (a: Row, b: Row) => number> = {
    name: byName,
    // An album nothing was added to yet counts from when it was made, as the server did.
    recent: (a, b) =>
      recentFirst(a.album.latest_activity ?? a.album.created_at, b.album.latest_activity ?? b.album.created_at) ||
      byName(a, b),
    count: (a, b) => b.album.photo_count - a.album.photo_count || byName(a, b),
  };
  return rows.sort(order[sort]).map((row) => row.album);
}
