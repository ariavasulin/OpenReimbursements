import type { PhotoAlbumSummary, PhotoAlbumSummaryRow } from "./types";

/** Mirrors mapJobSummary: the count arrives as a string, thumbs may be null. */
export function mapAlbumSummary(row: PhotoAlbumSummaryRow): PhotoAlbumSummary {
  return {
    id: row.id,
    name: row.name,
    photo_count: Number(row.photo_count),
    thumb_paths: row.thumbs ?? [],
    created_at: row.created_at,
    created_by: row.created_by ?? null,
    latest_activity: row.latest_added ?? null,
    // Passed on only when the database sent them. Guessing "date" for an
    // older row would start an arranged album's grid in the wrong order; left
    // out, the album page waits for its own header instead.
    ...(row.sort_mode === "date" || row.sort_mode === "custom" ? { sort_mode: row.sort_mode } : {}),
    ...(typeof row.has_custom_order === "boolean" ? { has_custom_order: row.has_custom_order } : {}),
  };
}
