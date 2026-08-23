// Pure ownership rules for the repair sweep's orphan pass: which stored
// objects some photos row still points at, and which are therefore candidates
// for deletion. The route (app/api/photos/repair/route.ts) reads the rows and
// walks the bucket; this module decides, so the rule that governs deletion is
// testable with plain objects.

import type { StoredObject } from "./sweep";

/** Every column a photos row can point a stored object at — the one list the
 * sweep's known set, the route's confirm-before-delete guard, and
 * deletionPaths all read. A column missing here turns the objects it owns
 * into apparent orphans, and orphans get deleted. */
export const PATH_COLUMNS = [
  "original_path",
  "sidecar_path",
  "thumb_path",
  "preview_path",
  "playback_path",
] as const;

export type PathRow = Record<(typeof PATH_COLUMNS)[number], string | null>;

/** One object found under originals/ or derived/ in the photos bucket. */
export interface ListedObject {
  name: string;
  created_at: string;
}

/** Every path any row still points at, across all five path columns. */
export function knownPaths(rows: PathRow[]): Set<string> {
  const known = new Set<string>();
  for (const r of rows) {
    for (const column of PATH_COLUMNS) {
      const value = r[column];
      if (value) known.add(value);
    }
  }
  return known;
}

/** Tags each listed object with whether a row owns it. `has_row: false` is an
 * orphan candidate — planSweep still holds it back until it is older than the
 * orphan age, and the route re-confirms it against live state before any
 * delete. */
export function markOwnership(
  objects: ListedObject[],
  known: Set<string>
): StoredObject[] {
  return objects.map((o) => ({ ...o, has_row: known.has(o.name) }));
}
