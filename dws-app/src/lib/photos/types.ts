// Shared types for the DWS Photos hub.

/** One job card on the photos home screen / job dropdown. */
export interface PhotoJobSummary {
  id: string;
  job_number: string;
  name: string;
  location: string | null;
  photo_count: number;
  /** ISO timestamp of the newest upload, or null when the job has no photos. */
  latest_upload_at: string | null;
  /** Storage paths (photos bucket) of up to 4 newest grid thumbnails. */
  thumb_paths: string[];
}
