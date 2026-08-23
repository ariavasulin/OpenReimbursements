export const PHOTO_KINDS = ["image", "video", "file"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** Where captured_at came from, best first: EXIF, XMP sidecar, in-app camera
 * shutter, file.lastModified, or the server's upload time. 'file'/'upload'
 * dates render as "Approx." — a fallback is never presented as evidence. */
export const CAPTURED_AT_SOURCES = [
  "exif",
  "xmp",
  "camera",
  "file",
  "upload",
] as const;
export type CapturedAtSource = (typeof CAPTURED_AT_SOURCES)[number];

/** One photos row as returned by GET /api/photos (uploader + job embedded). */
export interface PhotoRow {
  id: string;
  job_id: string;
  uploader_id: string;
  kind: PhotoKind;
  sheet_number: string | null;
  tags: string[];
  /** Never null after finalize: EXIF capture time, or upload time fallback. */
  captured_at: string;
  captured_at_source: CapturedAtSource;
  original_path: string;
  original_bytes: number | null;
  mime_type: string | null;
  original_name: string | null;
  thumb_path: string | null;
  preview_path: string | null;
  duration_secs: number | null;
  created_at: string;
  uploader: { full_name: string | null } | null;
  /** Embedded job, for cross-job grids (search results grouped by job). */
  job: { id: string; job_number: string; name: string } | null;
}

/** One job card on the photos home screen / job dropdown. */
export interface PhotoJobSummary {
  id: string;
  job_number: string;
  name: string;
  location: string | null;
  photo_count: number;
  /** Storage paths (photos bucket) of up to 4 newest grid thumbnails. */
  thumb_paths: string[];
}
