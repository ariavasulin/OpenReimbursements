// Input is in the grid's sort order (newest or oldest first); groups and the
// photos inside them keep it unless a mode says otherwise.

import { FILE_TYPE_LABELS, fileTypeLabel } from "./file-type";
import { NO_PROJECT } from "./format";
import type { PhotoRow } from "./types";

export type GroupBy = "date" | "job" | "tag" | "uploader" | "type";

/** Header of the group for photos that carry no tag at all; always the last group. */
export const NO_TAGS = "No tags";
/** Header of the group for photos whose uploader has no name on file; always last. */
export const UNKNOWN_UPLOADER = "Unknown";

export interface PhotoGroup {
  /** Stable identity for React keys and sorting. */
  key: string;
  /** Section header text, e.g. "August 14, 2026" / "#3612 · …". */
  label: string;
  photos: PhotoRow[];
}

function append(
  map: Map<string, PhotoGroup>,
  key: string,
  label: string,
  photo: PhotoRow
) {
  let group = map.get(key);
  if (!group) {
    group = { key, label, photos: [] };
    map.set(key, group);
  }
  group.photos.push(photo);
}

// One formatter for every date header. Building one per photo (what
// toLocaleDateString does under the hood) was most of the cost of regrouping a
// few thousand photos, and every new page regroups all of them.
const DAY_HEADER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** A date group's header: "August 14, 2026", in the reader's time zone. */
export function formatDayHeader(date: Date): string {
  return DAY_HEADER.format(date);
}

const byLabel = (a: PhotoGroup, b: PhotoGroup) =>
  a.label.localeCompare(b.label, "en", { sensitivity: "base" });

/**
 * By tag: a photo shows under EACH of its tags, so the same photo can sit in
 * several groups. Tags run A to Z ignoring case; "No tags" is always last.
 * Inside a group the photos keep the input order.
 */
function groupByTag(photos: PhotoRow[]): PhotoGroup[] {
  const map = new Map<string, PhotoGroup>();
  const untagged: PhotoRow[] = [];
  for (const photo of photos) {
    if (photo.tags.length === 0) untagged.push(photo);
    for (const tag of photo.tags) append(map, `tag:${tag}`, tag, photo);
  }
  const groups = [...map.values()].sort(byLabel);
  if (untagged.length > 0) {
    groups.push({ key: "tag:none", label: NO_TAGS, photos: untagged });
  }
  return groups;
}

/**
 * By uploader: one group per person, keyed by their id (two people with the
 * same name stay apart), A to Z ignoring case like tags. Uploaders with no
 * name on file share one "Unknown" group, last.
 */
function groupByUploader(photos: PhotoRow[]): PhotoGroup[] {
  const map = new Map<string, PhotoGroup>();
  const unknown: PhotoRow[] = [];
  for (const photo of photos) {
    const name = photo.uploader?.full_name?.trim();
    if (name) append(map, `uploader:${photo.uploader_id}`, name, photo);
    else unknown.push(photo);
  }
  const groups = [...map.values()].sort(byLabel);
  if (unknown.length > 0) {
    groups.push({ key: "uploader:unknown", label: UNKNOWN_UPLOADER, photos: unknown });
  }
  return groups;
}

/** By file type, in `FILE_TYPE_LABELS` order, so the list reads the same on every page. */
function groupByType(photos: PhotoRow[]): PhotoGroup[] {
  const map = new Map<string, PhotoGroup>();
  for (const photo of photos) {
    const label = fileTypeLabel(photo);
    append(map, `type:${label}`, label, photo);
  }
  return FILE_TYPE_LABELS.flatMap((label) => map.get(`type:${label}`) ?? []);
}

export function groupPhotos(photos: PhotoRow[], groupBy: GroupBy): PhotoGroup[] {
  if (groupBy === "tag") return groupByTag(photos);
  if (groupBy === "uploader") return groupByUploader(photos);
  if (groupBy === "type") return groupByType(photos);

  // Map keeps insertion order, so groups come out in first-seen order.
  const map = new Map<string, PhotoGroup>();

  for (const photo of photos) {
    if (groupBy === "date") {
      const date = new Date(photo.captured_at);
      if (Number.isNaN(date.getTime())) {
        append(map, "date:unknown", "Unknown date", photo);
      } else {
        const key = `date:${date.toDateString()}`;
        // The label is only needed when this day's group is new.
        const group = map.get(key);
        if (group) group.photos.push(photo);
        else append(map, key, formatDayHeader(date), photo);
      }
    } else {
      // No project is its own group. "Unknown job" is only for a project the
      // embed could not read, which keeps its id as the key.
      const label = photo.job
        ? `#${photo.job.job_number} · ${photo.job.name}`
        : photo.job_id === null
          ? NO_PROJECT
          : "Unknown job";
      append(map, `job:${photo.job_id ?? "none"}`, label, photo);
    }
  }

  return [...map.values()];
}

/**
 * Can this photo open in the lightbox? Images and videos with a rendered
 * derivative do; companion files (and derivative-less rows awaiting repair)
 * show as labeled file tiles with download instead.
 */
export function isOpenable(photo: PhotoRow): boolean {
  return (
    (photo.preview_path ?? photo.thumb_path) != null &&
    (photo.kind === "image" || photo.kind === "video")
  );
}

/**
 * The photos a lightbox can flip through, in the order the grid shows them.
 * Each photo once, at its first place: grouped by tag the same photo sits in
 * several groups, and the viewer addresses photos by id.
 */
export function openableInDisplayOrder(groups: PhotoGroup[]): PhotoRow[] {
  const seen = new Set<string>();
  const out: PhotoRow[] = [];
  for (const group of groups) {
    for (const photo of group.photos) {
      if (seen.has(photo.id) || !isOpenable(photo)) continue;
      seen.add(photo.id);
      out.push(photo);
    }
  }
  return out;
}
