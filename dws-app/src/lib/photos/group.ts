// Grouping is a view choice, not a fixed hierarchy: the same filtered set of
// photos regroups by capture date, sheet number, or job. Pure function — the
// grids feed it whatever pages they have loaded (input is newest-first).

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
  order: string[],
  key: string,
  label: string,
  photo: PhotoRow
) {
  let group = map.get(key);
  if (!group) {
    group = { key, label, photos: [] };
    map.set(key, group);
    order.push(key);
  }
  group.photos.push(photo);
}

export function groupPhotos(photos: PhotoRow[], groupBy: GroupBy): PhotoGroup[] {
  const map = new Map<string, PhotoGroup>();
  const order: string[] = [];

  for (const photo of photos) {
    if (groupBy === "date") {
      const date = new Date(photo.captured_at);
      if (Number.isNaN(date.getTime())) {
        append(map, order, "date:unknown", "Unknown date", photo);
      } else {
        append(
          map,
          order,
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
        append(map, order, `${SHEET_PREFIX}${sheet}`, `Sheet ${sheet}`, photo);
      } else {
        append(map, order, NO_SHEET_KEY, "No sheet", photo);
      }
    } else {
      const label = photo.job
        ? `#${photo.job.job_number} · ${photo.job.name}`
        : "Unknown job";
      append(map, order, `job:${photo.job_id}`, label, photo);
    }
  }

  const groups = order.map((key) => map.get(key)!);

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
