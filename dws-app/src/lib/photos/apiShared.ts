import { PATH_COLUMNS } from './repair/known-paths';

/** Columns every photos response returns (uploader name + job embedded). */
export const PHOTO_COLUMNS =
  'id, job_id, uploader_id, kind, sheet_number, tags, captured_at, ' +
  'captured_at_source, ' +
  'original_path, original_bytes, mime_type, original_name, thumb_path, ' +
  'preview_path, playback_path, duration_secs, sidecar_path, sidecar_name, ' +
  'created_at, ' +
  'uploader:user_profiles(full_name), job:jobs(id, job_number, name)';

/** Rows one GET /api/photos page returns when the caller names no `limit`. */
export const PHOTOS_PAGE_SIZE = 100;

/**
 * Escape ILIKE wildcards for a value bound as an RPC argument. The RPCs
 * interpolate it into `ilike '%' || q || '%'`, so a typed % or _ would match
 * everything.
 */
export function escapeIlikeWildcards(raw: string): string {
  return raw.replace(/[%_\\]/g, (m) => `\\${m}`).trim();
}

/**
 * The same, plus PostgREST or()-syntax characters stripped, for a value that
 * goes into a `.or('col.ilike.%…%')` filter string. Stripping costs matches
 * (`punch (list)` becomes `punch  list`), so only use it where the value is
 * part of the filter grammar.
 */
export function escapeForIlike(raw: string): string {
  return escapeIlikeWildcards(raw).replace(/[,()]/g, ' ').trim();
}

/** Trimmed sheet number; null when absent, blank, or not a string. */
export function cleanSheet(input: unknown): string | null {
  return typeof input === 'string' && input.trim() ? input.trim() : null;
}

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 64;

/** Dedupe/trim/cap a client-supplied tags value; non-arrays become []. */
export function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
        .filter(Boolean)
    ),
  ].slice(0, MAX_TAGS);
}

/** True for a lowercase hex SHA-256 digest — the only content_sha256 shape
 * the per-job unique index (photos_job_sha) is meant to bite on. */
export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** Storage objects DELETE removes alongside a photos row (order is
 * irrelevant; nulls and absent columns drop out). Driven by PATH_COLUMNS so a
 * column added there is deleted here without a second edit. */
export function deletionPaths(
  row: Partial<Record<(typeof PATH_COLUMNS)[number], string | null>>
): string[] {
  return PATH_COLUMNS.map((column) => row[column]).filter(
    (path): path is string => Boolean(path)
  );
}
