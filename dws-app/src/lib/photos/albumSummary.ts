import type { PhotoAlbumSummary, PhotoAlbumSummaryRow } from "./types";

/** Mirrors mapJobSummary: the count arrives as a string, thumbs may be null. */
export function mapAlbumSummary(row: PhotoAlbumSummaryRow): PhotoAlbumSummary {
  return {
    id: row.id,
    name: row.name,
    photo_count: Number(row.photo_count),
    thumb_paths: row.thumbs ?? [],
    created_at: row.created_at,
  };
}
