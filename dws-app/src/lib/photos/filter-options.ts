// Filter-chip menus for a photo grid. The options accumulate across every page
// of photos seen, so picking a filter never shrinks the menus to the filtered
// set.

import type { PhotoRow } from "./types";

export interface SeenOptions {
  /** uploader_id -> display name. */
  uploaders: Map<string, string>;
  /** Every tag carried by a photo seen so far. */
  tags: Set<string>;
}

export interface FilterOption {
  value: string;
  label: string;
}

export function emptySeenOptions(): SeenOptions {
  return { uploaders: new Map(), tags: new Set() };
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
  const tags = new Set(previous.tags);
  for (const photo of photos) {
    const name = photo.uploader?.full_name;
    if (name && uploaders.get(photo.uploader_id) !== name) {
      uploaders.set(photo.uploader_id, name);
      changed = true;
    }
    for (const tag of photo.tags) {
      if (!tags.has(tag)) {
        tags.add(tag);
        changed = true;
      }
    }
  }
  return changed ? { uploaders, tags } : previous;
}

/** Tags A to Z ignoring case; `known` adds tags no loaded photo has shown yet. */
export function toTagOptions(seen: SeenOptions, known: string[] = []): FilterOption[] {
  return [...new Set([...known, ...seen.tags])]
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
    .map((tag) => ({ value: tag, label: tag }));
}

/** Uploaders by display name. */
export function toUploaderOptions(seen: SeenOptions): FilterOption[] {
  return [...seen.uploaders.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ value: id, label: name }));
}
