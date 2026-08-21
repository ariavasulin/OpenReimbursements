// Input is newest-first.

import type { PhotoRow } from "./types";

export type GroupBy = "date" | "sheet" | "job";

export interface PhotoGroup {
  /** Stable identity for React keys and sorting. */
  key: string;
  /** Section header text, e.g. "August 14, 2026" / "Sheet 12" / "#3612 · …". */
  label: string;
  photos: PhotoRow[];
}

const NO_SHEET_KEY = "sheet:none";
const SHEET_PREFIX = "sheet:";

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
    } else if (groupBy === "sheet") {
      const sheet = photo.sheet_number?.trim() || null;
      if (sheet) {
        append(map, `${SHEET_PREFIX}${sheet}`, `Sheet ${sheet}`, photo);
      } else {
        append(map, NO_SHEET_KEY, "No sheet", photo);
      }
    } else {
      const label = photo.job
        ? `#${photo.job.job_number} · ${photo.job.name}`
        : "Unknown job";
      append(map, `job:${photo.job_id}`, label, photo);
    }
  }

  const groups = [...map.values()];

  if (groupBy === "sheet") {
    // Numeric sheets highest-first, then non-numeric A→Z, "No sheet" last.
    groups.sort((a, b) => {
      if (a.key === NO_SHEET_KEY) return 1;
      if (b.key === NO_SHEET_KEY) return -1;
      const aNum = Number(a.key.slice(SHEET_PREFIX.length));
      const bNum = Number(b.key.slice(SHEET_PREFIX.length));
      const aIsNum = Number.isFinite(aNum);
      const bIsNum = Number.isFinite(bNum);
      if (aIsNum && bIsNum) return bNum - aNum;
      if (aIsNum) return -1;
      if (bIsNum) return 1;
      return a.label.localeCompare(b.label);
    });
  }

  return groups;
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
