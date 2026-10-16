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
    // An older database row has neither; date order is every album's default.
    sort_mode: row.sort_mode === "custom" ? "custom" : "date",
    has_custom_order: row.has_custom_order === true,
  };
}
