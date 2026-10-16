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
  /** The photo's project. Null when it has none: show "No project". */
  job_id: string | null;
  uploader_id: string;
  kind: PhotoKind;
  tags: string[];
  /** Never null after finalize: EXIF capture time, or upload time fallback. */
  captured_at: string;
  captured_at_source: CapturedAtSource;
  original_path: string;
  original_bytes: number | null;
  mime_type: string | null;
  original_name: string | null;
  /** The photo's name, automatic or hand-given; null shows `original_name`.
   * Optional so cached rows without the field stay assignable. See photoName(). */
  display_name?: string | null;
  thumb_path: string | null;
  preview_path: string | null;
  duration_secs: number | null;
  /** Repair-cron H.264 rendition for browsers that can't play the original
   * container; null until the sweep transcodes the video (or forever, when
   * playback_skipped_reason is set). Optional so cached rows without the
   * field stay assignable; treat `undefined` as null. */
  playback_path?: string | null;
  /** Attached XMP sidecar beside the original (image rows only). */
  sidecar_path: string | null;
  /** The sidecar's filename as uploaded (download restores it). */
  sidecar_name: string | null;
  created_at: string;
  uploader: { full_name: string | null } | null;
  /** Embedded project, for cross-project grids. Null when `job_id` is null. */
  job: { id: string; job_number: string; name: string } | null;
  /** The reader's own favorite, if any (FAVORITES_EMBED). Absent on reads that
   * do not embed it; treat as none. See isFavorite(). */
  favorites?: { user_id: string }[];
}

/**
 * Whether `photo` is one of `me`'s favorites. The embed is read under a row rule
 * that shows only the reader's rows, but a row read with service credentials
 * would carry everyone's, so the check names the person either way.
 */
export function isFavorite(photo: Pick<PhotoRow, "favorites">, me: string | null | undefined): boolean {
  return Boolean(me) && (photo.favorites ?? []).some((favorite) => favorite.user_id === me);
}

/** An album as a photo carries it. */
export interface PhotoAlbumRef {
  id: string;
  name: string;
}

/** GET /api/photos/[id]: one active photo plus the albums it is in. */
export interface PhotoDetail extends PhotoRow {
  albums: PhotoAlbumRef[];
}

/** One row of the get_photo_album_cards RPC (via get_photo_album_summaries_by_name_page). */
export interface PhotoAlbumSummaryRow {
  id: string;
  name: string;
  photo_count: number | string; // bigint arrives as a string over PostgREST
  /** When a photo was last added to it; the Sort chip's "Latest added". */
  latest_added: string | null;
  thumbs: string[] | null;
  created_at: string;
  created_by: string | null;
  /** Both missing from a database without get_photo_album_cards' order columns. */
  sort_mode?: "date" | "custom";
  has_custom_order?: boolean;
}

/** One album card: name, active-photo count, up to 4 newest thumbnails. */
export interface PhotoAlbumSummary {
  id: string;
  name: string;
  photo_count: number;
  /** Storage paths (photos bucket) of up to 4 newest grid thumbnails. */
  thumb_paths: string[];
  created_at: string;
  /** Who made the album: they and photo admins may delete it. */
  created_by: string | null;
  /** When a photo was last added; null for an empty album (then created_at stands in). */
  latest_activity: string | null;
  /**
   * The album page's order, as GET /api/photo-albums/[id] reports it: an album
   * opened from a list can start loading its photos before its own header
   * arrives. `custom` while it shows its arranged order, else `date`.
   * Missing when the database did not say (an older one): the order is then
   * unknown, and the page waits for its own header (albumHeaderFromSummary).
   */
  sort_mode?: "date" | "custom";
  /** An arranged order is saved (kept when the album goes back to date order). Missing as sort_mode is. */
  has_custom_order?: boolean;
}

/** An album row as the create, rename, delete, and restore routes return it. */
export interface PhotoAlbum {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

/** One row of the get_photo_tags RPC. */
export interface PhotoTagRow {
  tag: string;
}

/** One row of the get_photo_job_summaries RPC. */
export interface PhotoJobSummaryRow {
  id: string;
  job_number: string;
  name: string;
  location: string | null;
  photo_count: number | string; // bigint arrives as a string over PostgREST
  /** When a photo was last uploaded to it; the Sort chip's "Latest upload". */
  latest_upload: string | null;
  thumbs: string[] | null;
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
  /** When a photo was last uploaded; null for a project with no photos. */
  latest_activity: string | null;
}
