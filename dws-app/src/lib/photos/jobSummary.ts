import type { PhotoJobSummary, PhotoJobSummaryRow } from "./types";

export function mapJobSummary(row: PhotoJobSummaryRow): PhotoJobSummary {
  return {
    id: row.id,
    job_number: row.job_number,
    name: row.name,
    location: row.location,
    photo_count: Number(row.photo_count),
    thumb_paths: row.thumbs ?? [],
  };
}
