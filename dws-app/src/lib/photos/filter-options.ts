// Filter-chip menus for a job page. The options accumulate across every page
// of photos seen for the job, so picking a filter never shrinks the menus to
// the filtered set.

import type { PhotoRow } from "./types";

export interface SeenOptions {
  /** uploader_id -> display name. */
  uploaders: Map<string, string>;
}

export interface FilterOption {
  value: string;
  label: string;
}

export function emptySeenOptions(): SeenOptions {
  return { uploaders: new Map() };
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
  const uploaders = new Map(previous.uploaders);
  for (const photo of photos) {
    const name = photo.uploader?.full_name;
    if (name && uploaders.get(photo.uploader_id) !== name) {
      uploaders.set(photo.uploader_id, name);
      changed = true;
    }
  }
  return changed ? { uploaders } : previous;
}

/** Uploaders by display name. */
export function toUploaderOptions(seen: SeenOptions): FilterOption[] {
  return [...seen.uploaders.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ value: id, label: name }));
}
