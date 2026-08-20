// Shared types for the DWS Photos hub.

/** One photos row as returned by GET /api/photos (uploader name embedded). */
export interface PhotoRow {
  id: string;
  job_id: string;
  kind: "image" | "video" | "file";
  sheet_number: string | null;
  tags: string[];
  /** Never null after finalize: EXIF capture time, or upload time fallback. */
  captured_at: string;
  original_path: string;
  original_bytes: number | null;
  mime_type: string | null;
  original_name: string | null;
  thumb_path: string | null;
  preview_path: string | null;
  duration_secs: number | null;
  created_at: string;
  uploader: { full_name: string | null } | null;
}

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
