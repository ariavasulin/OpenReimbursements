// Input is newest-first.

import type { PhotoRow } from "./types";

export type GroupBy = "date" | "job";

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

export function groupPhotos(photos: PhotoRow[], groupBy: GroupBy): PhotoGroup[] {
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
      const label = photo.job
        ? `#${photo.job.job_number} · ${photo.job.name}`
        : "Unknown job";
      append(map, `job:${photo.job_id}`, label, photo);
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

/** The photos a lightbox can flip through, in the order the grid shows them. */
export function openableInDisplayOrder(groups: PhotoGroup[]): PhotoRow[] {
  return groups.flatMap((group) => group.photos).filter(isOpenable);
}
