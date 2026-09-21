// Input is newest-first.

import { NO_PROJECT } from "./format";
import type { PhotoRow } from "./types";

export type GroupBy = "date" | "job" | "tag";

/** Header of the group for photos that carry no tag at all; always the last group. */
export const NO_TAGS = "No tags";

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

/**
 * By tag: a photo shows under EACH of its tags, so the same photo can sit in
 * several groups. Tags run A to Z ignoring case; "No tags" is always last.
 * Inside a group the photos keep the input order (newest first).
 */
function groupByTag(photos: PhotoRow[]): PhotoGroup[] {
  const map = new Map<string, PhotoGroup>();
  const untagged: PhotoRow[] = [];
  for (const photo of photos) {
    if (photo.tags.length === 0) untagged.push(photo);
    for (const tag of photo.tags) append(map, `tag:${tag}`, tag, photo);
  }
  const groups = [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" })
  );
  if (untagged.length > 0) {
    groups.push({ key: "tag:none", label: NO_TAGS, photos: untagged });
  }
  return groups;
}

export function groupPhotos(photos: PhotoRow[], groupBy: GroupBy): PhotoGroup[] {
  if (groupBy === "tag") return groupByTag(photos);

  // Map keeps insertion order, so groups come out in first-seen order.
  const map = new Map<string, PhotoGroup>();

  for (const photo of photos) {
    if (groupBy === "date") {
      const date = new Date(photo.captured_at);
      if (Number.isNaN(date.getTime())) {
        append(map, "date:unknown", "Unknown date", photo);
      } else {
        append(
          map,
          `date:${date.toDateString()}`,
          date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          photo
        );
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
