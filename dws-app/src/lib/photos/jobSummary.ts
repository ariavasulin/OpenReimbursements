import type { PhotoJobSummary } from "./types";

/** One row from the get_photo_job_summaries RPC. */
export type PhotoJobSummaryRow = {
  id: string;
  job_number: string;
  name: string;
  location: string | null;
  photo_count: number | string; // bigint arrives as a string over PostgREST
  /** Drives the RPC's ordering; not part of the wire shape we return. */
  latest_upload: string | null;
  thumbs: string[] | null;
};

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
